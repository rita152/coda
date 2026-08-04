import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ThreadId, WorkspaceId } from '../protocol/index.js';
import {
  PENDING_PRESENTATION_THREAD_ID,
  persistableDraft,
  presentationStatePath,
  ThreadPresentationStore,
} from './presentation-state.js';

const roots: string[] = [];
const WORKSPACE = 'ws_presentation' as WorkspaceId;
const THREAD = 'thr_presentation' as ThreadId;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(over: { now?: () => number; debounceMs?: number } = {}): {
  root: string;
  store: ThreadPresentationStore;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'coda-presentation-'));
  roots.push(root);
  return {
    root,
    store: new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      ...over,
    }),
  };
}

describe('ThreadPresentationStore', () => {
  it('does not create storage for an untouched or empty initial draft', () => {
    const { root, store } = fixture();
    store.setDraft(persistableDraft(''));
    store.dispose();
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('coalesces drafts, persists mode 0600, and restores the same thread state', async () => {
    let now = 10;
    const { root, store } = fixture({ now: () => now, debounceMs: 10 });
    store.setDraft(persistableDraft('first'));
    now = 11;
    store.setDraft(persistableDraft('second'));
    const file = presentationStatePath(root, WORKSPACE, THREAD);
    expect(existsSync(file)).toBe(false);
    await Bun.sleep(20);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restored = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: THREAD,
    });
    expect(restored.snapshot()).toMatchObject({
      workspaceId: WORKSPACE,
      threadId: THREAD,
      draft: 'second',
      vimEnabled: false,
      unreadAfterSeq: 0,
    });
    restored.dispose();
    store.dispose();
  });

  it('makes stash/restore durable and keeps presentation-only navigation state', () => {
    const { root, store } = fixture();
    store.stash(persistableDraft('long prompt'));
    expect(JSON.parse(readFileSync(presentationStatePath(root, WORKSPACE, THREAD), 'utf8')).state).toMatchObject({
      draft: '',
      stashedDraft: 'long prompt',
    });

    store.setScrollState({
      blockKey: 'message:u1',
      logicalOffset: 2,
      fallbackBlockKeys: ['message:a0'],
      observedHighWaterSeq: 7,
    }, 7);
    store.setSearch({ query: 'needle', matchOrdinal: 1 });
    store.setVimEnabled(true);
    expect(store.restoreStash()).toEqual(persistableDraft('long prompt'));
    store.dispose();

    const restored = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: THREAD,
    });
    expect(restored.snapshot()).toMatchObject({
      draft: 'long prompt',
      unreadAfterSeq: 7,
      vimEnabled: true,
      search: { query: 'needle', matchOrdinal: 1 },
      scrollAnchor: {
        blockKey: 'message:u1',
        logicalOffset: 2,
        observedHighWaterSeq: 7,
      },
    });
    expect(restored.snapshot().stashedDraft).toBeUndefined();
    restored.dispose();
  });

  it('quarantines malformed or identity-mismatched state without blocking recovery', () => {
    const { root, store } = fixture({ now: () => 123 });
    const file = presentationStatePath(root, WORKSPACE, THREAD);
    store.dispose();
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, '{"version":1,"state":{"workspaceId":"wrong"}}\n');
    const warnings: string[] = [];

    const recovered = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      now: () => 123,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(recovered.snapshot().draft).toBe('');
    expect(warnings).toHaveLength(1);
    expect(existsSync(`${file}.corrupt-123`)).toBe(true);
    recovered.dispose();
  });

  it('sanitizes ordinary and externally modified recovery text before it reaches a surface', () => {
    const { root, store } = fixture();
    store.setDraft(persistableDraft('safe\u001b[31m draft'));
    store.setSearch({ query: 'needle\u001b]52;c;bad\u0007', matchOrdinal: 0 });
    store.flush();
    expect(store.snapshot()).toMatchObject({
      draft: 'safe draft',
      search: { query: 'needle', matchOrdinal: 0 },
    });
    store.dispose();

    const file = presentationStatePath(root, WORKSPACE, THREAD);
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    payload.state.draft = 'tampered\u001b[2J draft';
    payload.state.stashedDraft = 'stash\u009b31m';
    payload.state.search.query = 'query\u001b]0;title\u0007';
    writeFileSync(file, `${JSON.stringify(payload)}\n`);
    const restored = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: THREAD,
    });
    expect(restored.snapshot()).toMatchObject({
      draft: 'tampered draft',
      stashedDraft: 'stash',
      search: { query: 'query', matchOrdinal: 0 },
    });
    restored.dispose();
  });

  it('hashes untrusted identities instead of using them as path segments', () => {
    const root = '/tmp/presentation-root';
    const file = presentationStatePath(
      root,
      '../workspace' as WorkspaceId,
      '../../thread' as ThreadId,
    );
    expect(file.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(file).not.toContain('..');
    expect(path.relative(root, file).split(path.sep)).toHaveLength(2);
  });

  it('isolates drafts and preferences by both workspace and thread', () => {
    const { root, store } = fixture();
    store.setDraft(persistableDraft('thread one'));
    store.setVimEnabled(true);
    store.dispose();

    const otherThread = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: 'thr_other' as ThreadId,
    });
    const otherWorkspace = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_other' as WorkspaceId,
      threadId: THREAD,
    });
    expect(otherThread.snapshot()).toMatchObject({ draft: '', vimEnabled: false });
    expect(otherWorkspace.snapshot()).toMatchObject({ draft: '', vimEnabled: false });
    expect(presentationStatePath(root, WORKSPACE, 'thr_other' as ThreadId))
      .not.toBe(presentationStatePath(root, WORKSPACE, THREAD));
    expect(presentationStatePath(root, 'ws_other' as WorkspaceId, THREAD))
      .not.toBe(presentationStatePath(root, WORKSPACE, THREAD));
    otherThread.dispose();
    otherWorkspace.dispose();
  });

  it('durably swaps independent draft, scroll, and unread state across threads', () => {
    const { store } = fixture();
    const other = 'thr_background' as ThreadId;
    store.setDraft(persistableDraft('thread A draft'));
    store.setScrollState({
      blockKey: 'message:a',
      logicalOffset: 3,
      fallbackBlockKeys: [],
      observedHighWaterSeq: 11,
    }, 11);
    expect(store.switchToThread(other)).toMatchObject({
      threadId: other,
      draft: '',
      unreadAfterSeq: 0,
    });
    store.setDraft(persistableDraft('thread B draft'));
    store.setScrollState({
      blockKey: 'message:b',
      logicalOffset: 1,
      fallbackBlockKeys: ['message:b0'],
      observedHighWaterSeq: 22,
    }, 22);
    expect(store.switchToThread(THREAD)).toMatchObject({
      threadId: THREAD,
      draft: 'thread A draft',
      unreadAfterSeq: 11,
      scrollAnchor: { blockKey: 'message:a', logicalOffset: 3 },
    });
    expect(store.switchToThread(other)).toMatchObject({
      threadId: other,
      draft: 'thread B draft',
      unreadAfterSeq: 22,
      scrollAnchor: { blockKey: 'message:b', logicalOffset: 1 },
    });
    store.dispose();
  });

  it('recovers a stable cold-start draft and migrates it only after a real thread attaches', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-presentation-pending-'));
    roots.push(root);
    const pending = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: PENDING_PRESENTATION_THREAD_ID,
    });
    pending.setDraft(persistableDraft('survive before model selection'));
    pending.dispose();

    const recovered = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: PENDING_PRESENTATION_THREAD_ID,
    });
    expect(recovered.snapshot()).toMatchObject({
      threadId: PENDING_PRESENTATION_THREAD_ID,
      draft: 'survive before model selection',
    });

    const attachedThread = 'thr_attached_after_selection' as ThreadId;
    recovered.migrateToThread(attachedThread);
    expect(recovered.snapshot()).toMatchObject({
      threadId: attachedThread,
      draft: 'survive before model selection',
    });
    expect(existsSync(presentationStatePath(root, WORKSPACE, attachedThread))).toBe(true);
    expect(existsSync(presentationStatePath(
      root,
      WORKSPACE,
      PENDING_PRESENTATION_THREAD_ID,
    ))).toBe(false);
    recovered.dispose();

    const attached = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: attachedThread,
    });
    const nextColdStart = new ThreadPresentationStore({
      root,
      workspaceId: WORKSPACE,
      threadId: PENDING_PRESENTATION_THREAD_ID,
    });
    expect(attached.snapshot().draft).toBe('survive before model selection');
    expect(nextColdStart.snapshot().draft).toBe('');
    attached.dispose();
    nextColdStart.dispose();
  });

  it('does not clear in-memory draft or claim success when a durability barrier fails', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'coda-presentation-blocked-'));
    roots.push(parent);
    const blockedRoot = path.join(parent, 'not-a-directory');
    writeFileSync(blockedRoot, 'blocked');
    const warnings: string[] = [];
    const store = new ThreadPresentationStore({
      root: blockedRoot,
      workspaceId: WORKSPACE,
      threadId: THREAD,
      onWarning: (warning) => warnings.push(warning),
    });
    store.setDraft(persistableDraft('must survive'));

    expect(() => store.stash(persistableDraft('must survive'))).toThrow(
      /presentation state could not be saved/,
    );
    expect(store.snapshot()).toMatchObject({ draft: 'must survive' });
    expect(store.snapshot().stashedDraft).toBeUndefined();
    expect(() => store.flush()).toThrow(/presentation state could not be saved/);
    expect(() => store.dispose()).toThrow(/presentation state could not be saved/);
    expect(() => store.setDraft(persistableDraft('must survive'))).not.toThrow();
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
