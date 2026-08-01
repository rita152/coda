// Legacy public Session compatibility facade. Construction is delegated to a private standalone
// host; all execution, persistence, retry/compaction, and event delivery live in collaborators.

import type { AgentMessage, ModelConfig, ModelRef, UserMessage } from '../protocol/index.js';
import { StandaloneSessionHost } from './standalone-session-host.js';
import type { CompactionRecord, MetaRecord, SessionListItem } from './store.js';
import type {
  SessionInteractionState,
  SessionListener,
  SessionOptions,
} from './legacy-thread-execution.js';

export type {
  SessionAuthoritativeEventBatch,
  SessionEvent,
  SessionInteractionState,
  SessionListener,
  SessionOptions,
  SessionRuntimeMirrorGuard,
} from './legacy-thread-execution.js';
export type { RetryOptions } from './retry.js';
export type { CompactionOptions } from './compactor.js';

export class Session {
  readonly #host: StandaloneSessionHost;

  private constructor(host: StandaloneSessionHost) {
    this.#host = host;
  }

  static async create(opts: SessionOptions): Promise<Session> {
    return new Session(await StandaloneSessionHost.create(opts));
  }

  /** @internal Runtime legacy adapter; ordinary callers should use create(). */
  static async createWithId(
    id: string,
    opts: SessionOptions,
    runtimeMeta?: MetaRecord,
  ): Promise<Session> {
    return new Session(await StandaloneSessionHost.createWithId(id, opts, runtimeMeta));
  }

  static async resume(id: string, opts: SessionOptions): Promise<Session> {
    return new Session(await StandaloneSessionHost.resume(id, opts));
  }

  static async list(dir?: string): Promise<SessionListItem[]> {
    return StandaloneSessionHost.list(dir);
  }

  get id(): string {
    return this.#host.id;
  }

  prompt(text: string): Promise<void> {
    return this.#host.prompt(text);
  }

  continue(): Promise<void> {
    return this.#host.continue();
  }

  steer(text: string | UserMessage): void {
    this.#host.steer(text);
  }

  followUp(text: string | UserMessage): void {
    this.#host.followUp(text);
  }

  abort(): void {
    this.#host.abort();
  }

  usage(): ReturnType<StandaloneSessionHost['usage']> {
    return this.#host.usage();
  }

  interactionState(): SessionInteractionState {
    return this.#host.interactionState();
  }

  /** @internal Runtime legacy driver decision hint. */
  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting' {
    return this.#host.runtimeFollowUpState();
  }

  currentModel(): ModelRef {
    return this.#host.currentModel();
  }

  setModel(model: ModelConfig): void {
    this.#host.setModel(model);
  }

  status(): ReturnType<StandaloneSessionHost['status']> {
    return this.#host.status();
  }

  get messages(): readonly AgentMessage[] {
    return this.#host.messages;
  }

  /** @internal Runtime checkpoint bridge. */
  compactionCheckpoint(): Readonly<CompactionRecord> | undefined {
    return this.#host.compactionCheckpoint();
  }

  subscribe(listener: SessionListener): () => void {
    return this.#host.subscribe(listener);
  }

  close(): Promise<void> {
    return this.#host.close();
  }

  waitForIdle(): Promise<void> {
    return this.#host.waitForIdle();
  }
}
