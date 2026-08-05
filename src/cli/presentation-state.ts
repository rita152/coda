// Frontend-private presentation persistence. This file deliberately knows nothing about
// Runtime/Session state: drafts, transcript anchors, search and input preferences are disposable
// UI state and must never become a second source of truth for threads, runs or permissions.

import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ThreadId, WorkspaceId } from '../protocol/index.js';
import { sanitizeTerminalText } from './terminal-sanitize.js';

const PRESENTATION_SCHEMA_VERSION = 1;
export const PRESENTATION_WRITE_DEBOUNCE_MS = 200;
/**
 * Stable frontend-only identity for a workspace draft that exists before Runtime owns a thread.
 * It is deliberately never submitted as a Runtime ThreadId.
 */
export const PENDING_PRESENTATION_THREAD_ID =
  'coda_presentation_pending_thread_v1' as const;
export type PresentationThreadId =
  | ThreadId
  | typeof PENDING_PRESENTATION_THREAD_ID;

/**
 * A value may enter durable presentation storage only after the composer has established that it
 * is ordinary user text. Provider/password controllers intentionally never construct this type.
 */
export interface PersistableDraft {
  readonly kind: 'persistable-draft';
  readonly text: string;
}

export function persistableDraft(text: string): PersistableDraft {
  return { kind: 'persistable-draft', text: sanitizeTerminalText(text) };
}

export interface TranscriptScrollAnchor {
  readonly blockKey: string;
  readonly logicalOffset: number;
  readonly fallbackBlockKeys: readonly string[];
  readonly observedHighWaterSeq: number;
}

export interface PresentationSearchState {
  readonly query: string;
  readonly matchOrdinal: number;
}

export interface ThreadPresentationState {
  readonly workspaceId: WorkspaceId;
  readonly threadId: PresentationThreadId;
  readonly draft: string;
  readonly scrollAnchor?: TranscriptScrollAnchor;
  /** Zero means the transcript is read through the current high-water mark. */
  readonly unreadAfterSeq: number;
  readonly search?: PresentationSearchState;
  readonly vimEnabled: boolean;
}

interface PresentationFile {
  readonly version: typeof PRESENTATION_SCHEMA_VERSION;
  readonly state: ThreadPresentationState;
}

export interface PresentationStoreOptions {
  readonly root: string;
  readonly workspaceId: WorkspaceId;
  readonly threadId: PresentationThreadId;
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
  readonly debounceMs?: number;
}

/**
 * One store instance owns one (workspace, thread) file. UI updates are coalesced for at most
 * 200ms; explicit durability barriers and dispose are synchronous.
 */
export class ThreadPresentationStore {
  readonly #root: string;
  #file: string;
  readonly #workspaceId: WorkspaceId;
  #threadId: PresentationThreadId;
  readonly #now: () => number;
  readonly #onWarning: ((message: string) => void) | undefined;
  readonly #debounceMs: number;

  #state: ThreadPresentationState;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #disposed = false;

  constructor(options: PresentationStoreOptions) {
    this.#root = options.root;
    this.#workspaceId = options.workspaceId;
    this.#threadId = options.threadId;
    this.#now = options.now ?? Date.now;
    this.#onWarning = options.onWarning;
    this.#debounceMs = options.debounceMs ?? PRESENTATION_WRITE_DEBOUNCE_MS;
    this.#file = presentationStatePath(
      options.root,
      options.workspaceId,
      options.threadId,
    );
    this.#state = this.#load();
  }

  snapshot(): ThreadPresentationState {
    return copyState(this.#state);
  }

  /**
   * Move a cold-start workspace draft onto the real Runtime thread after attachment. The target
   * is written first; any old pending file is then durably replaced with empty state before the
   * in-memory owner changes, so a failed barrier retains a recoverable source draft.
   */
  migrateToThread(threadId: ThreadId): void {
    this.#assertOpen();
    if (threadId === this.#threadId) return;
    const targetFile = presentationStatePath(
      this.#root,
      this.#workspaceId,
      threadId,
    );
    const migrated = {
      ...this.#state,
      threadId,
    };
    try {
      atomicWritePresentation(targetFile, {
        version: PRESENTATION_SCHEMA_VERSION,
        state: migrated,
      });
      if (existsSync(this.#file)) {
        atomicWritePresentation(this.#file, {
          version: PRESENTATION_SCHEMA_VERSION,
          state: emptyState(this.#workspaceId, this.#threadId),
        });
      }
    } catch (error) {
      this.#onWarning?.(`presentation state could not be migrated: ${errorMessage(error)}`);
      throw new Error(
        `presentation state could not be migrated: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const sourceFile = this.#file;
    this.#file = targetFile;
    this.#threadId = threadId;
    this.#state = migrated;
    this.#dirty = false;
    try {
      unlinkSync(sourceFile);
    } catch (error) {
      if (existsSync(sourceFile)) {
        this.#onWarning?.(
          `empty pending presentation state could not be removed: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** Durably leave one thread view and restore the independent view state of another. */
  switchToThread(threadId: ThreadId): ThreadPresentationState {
    this.#assertOpen();
    if (threadId === this.#threadId) return this.snapshot();
    this.#flushDirty(true);
    this.#threadId = threadId;
    this.#file = presentationStatePath(this.#root, this.#workspaceId, threadId);
    this.#state = this.#load();
    this.#dirty = false;
    return this.snapshot();
  }

  setDraft(draft: PersistableDraft): void {
    this.#assertOpen();
    if (draft.text === this.#state.draft) return;
    this.#replace({ ...this.#state, draft: draft.text }, false);
  }

  setScrollState(
    anchor: TranscriptScrollAnchor | undefined,
    unreadAfterSeq: number,
  ): void {
    this.#assertOpen();
    const next = {
      ...this.#state,
      unreadAfterSeq: safeSequence(unreadAfterSeq),
      ...(anchor === undefined ? {} : { scrollAnchor: copyAnchor(anchor) }),
    };
    if (anchor === undefined) deleteMutableOptional(next, 'scrollAnchor');
    this.#replace(next, false);
  }

  markRead(): void {
    this.#assertOpen();
    if (this.#state.unreadAfterSeq === 0 && this.#state.scrollAnchor === undefined) return;
    const next = { ...this.#state, unreadAfterSeq: 0 };
    deleteMutableOptional(next, 'scrollAnchor');
    this.#replace(next, false);
  }

  setSearch(search: PresentationSearchState | undefined): void {
    this.#assertOpen();
    const next = {
      ...this.#state,
      ...(search === undefined
        ? {}
        : {
            search: {
              query: sanitizeTerminalText(search.query),
              matchOrdinal: Math.max(0, Math.trunc(search.matchOrdinal)),
            },
          }),
    };
    if (search === undefined) deleteMutableOptional(next, 'search');
    this.#replace(next, false);
  }

  setVimEnabled(enabled: boolean): void {
    this.#assertOpen();
    if (enabled === this.#state.vimEnabled) return;
    this.#replace({ ...this.#state, vimEnabled: enabled }, true);
  }

  flush(): void {
    this.#assertOpen();
    this.#flushDirty(true);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#flushDirty(true);
    this.#disposed = true;
  }

  #replace(next: ThreadPresentationState, durable: boolean): void {
    if (sameState(this.#state, next)) return;
    if (durable) {
      try {
        atomicWritePresentation(this.#file, {
          version: PRESENTATION_SCHEMA_VERSION,
          state: next,
        });
      } catch (error) {
        this.#onWarning?.(`presentation state could not be saved: ${errorMessage(error)}`);
        throw new Error(
          `presentation state could not be saved: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#state = next;
      this.#dirty = false;
      return;
    }
    this.#state = next;
    this.#dirty = true;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushDirty(false);
    }, this.#debounceMs);
  }

  #flushDirty(strict: boolean): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#dirty) return;
    try {
      atomicWritePresentation(this.#file, {
        version: PRESENTATION_SCHEMA_VERSION,
        state: this.#state,
      });
      this.#dirty = false;
    } catch (error) {
      this.#onWarning?.(`presentation state could not be saved: ${errorMessage(error)}`);
      if (strict) {
        throw new Error(
          `presentation state could not be saved: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  }

  #load(): ThreadPresentationState {
    const empty = emptyState(this.#workspaceId, this.#threadId);
    if (!existsSync(this.#file)) return empty;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#file, 'utf8'));
      return parsePresentationFile(parsed, this.#workspaceId, this.#threadId);
    } catch (error) {
      quarantineCorruptFile(this.#file, this.#now());
      this.#onWarning?.(
        `invalid presentation state was quarantined: ${errorMessage(error)}`,
      );
      return empty;
    }
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error('presentation store is disposed');
  }
}

export function presentationStatePath(
  root: string,
  workspaceId: WorkspaceId,
  threadId: PresentationThreadId,
): string {
  return path.join(
    root,
    digestIdentity(workspaceId),
    `${digestIdentity(threadId)}.json`,
  );
}

function digestIdentity(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function emptyState(
  workspaceId: WorkspaceId,
  threadId: PresentationThreadId,
): ThreadPresentationState {
  return {
    workspaceId,
    threadId,
    draft: '',
    unreadAfterSeq: 0,
    vimEnabled: false,
  };
}

function parsePresentationFile(
  value: unknown,
  workspaceId: WorkspaceId,
  threadId: PresentationThreadId,
): ThreadPresentationState {
  const file = record(value, 'presentation file');
  if (file['version'] !== PRESENTATION_SCHEMA_VERSION) {
    throw new Error('unsupported presentation schema version');
  }
  const state = record(file['state'], 'presentation state');
  if (state['workspaceId'] !== workspaceId || state['threadId'] !== threadId) {
    throw new Error('presentation identity does not match its path');
  }
  const draft = sanitizeTerminalText(stringValue(state['draft'], 'draft'));
  const unreadAfterSeq = sequenceValue(state['unreadAfterSeq'], 'unreadAfterSeq');
  const vimEnabled = booleanValue(state['vimEnabled'], 'vimEnabled');
  const scrollAnchor = parseScrollAnchor(state['scrollAnchor']);
  const search = parseSearch(state['search']);
  return {
    workspaceId,
    threadId,
    draft,
    ...(scrollAnchor === undefined ? {} : { scrollAnchor }),
    unreadAfterSeq,
    ...(search === undefined ? {} : { search }),
    vimEnabled,
  };
}

function parseScrollAnchor(value: unknown): TranscriptScrollAnchor | undefined {
  if (value === undefined) return undefined;
  const anchor = record(value, 'scrollAnchor');
  return {
    blockKey: stringValue(anchor['blockKey'], 'scrollAnchor.blockKey'),
    logicalOffset: nonNegativeNumber(
      anchor['logicalOffset'],
      'scrollAnchor.logicalOffset',
    ),
    fallbackBlockKeys: stringArray(
      anchor['fallbackBlockKeys'],
      'scrollAnchor.fallbackBlockKeys',
    ).slice(0, 8),
    observedHighWaterSeq: sequenceValue(
      anchor['observedHighWaterSeq'],
      'scrollAnchor.observedHighWaterSeq',
    ),
  };
}

function parseSearch(value: unknown): PresentationSearchState | undefined {
  if (value === undefined) return undefined;
  const search = record(value, 'search');
  return {
    query: sanitizeTerminalText(stringValue(search['query'], 'search.query')),
    matchOrdinal: sequenceValue(search['matchOrdinal'], 'search.matchOrdinal'),
  };
}

function atomicWritePresentation(file: string, value: PresentationFile): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // rename already consumed the temporary, or cleanup failed; preserve the primary error.
    }
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Some platforms/filesystems do not support directory fsync. The file itself is still fsynced.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function quarantineCorruptFile(file: string, now: number): void {
  try {
    renameSync(file, `${file}.corrupt-${Math.max(0, Math.trunc(now))}`);
  } catch {
    // Recovery must never block the Runtime because presentation state is disposable.
  }
}

function copyState(state: ThreadPresentationState): ThreadPresentationState {
  return {
    ...state,
    ...(state.scrollAnchor === undefined
      ? {}
      : { scrollAnchor: copyAnchor(state.scrollAnchor) }),
    ...(state.search === undefined ? {} : { search: { ...state.search } }),
  };
}

function copyAnchor(anchor: TranscriptScrollAnchor): TranscriptScrollAnchor {
  return {
    ...anchor,
    logicalOffset: Math.max(0, anchor.logicalOffset),
    observedHighWaterSeq: safeSequence(anchor.observedHighWaterSeq),
    fallbackBlockKeys: [...anchor.fallbackBlockKeys].slice(0, 8),
  };
}

function safeSequence(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sameState(left: ThreadPresentationState, right: ThreadPresentationState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function sequenceValue(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deleteMutableOptional<
  T extends object,
  K extends keyof T,
>(value: T, key: K): void {
  delete value[key];
}
