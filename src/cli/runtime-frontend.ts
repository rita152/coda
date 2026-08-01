// Default-thread CLI facade over RuntimePort. It is intentionally an edge adapter:
// all business actions become identity-bearing RuntimeOps, while existing TUI/classic/plain
// frontends continue to consume the stable legacy SessionEvent projection.

import {
  projectLegacySessionEvent,
  strictJsonSnapshot,
} from '../protocol/index.js';
import type {
  AgentMessage,
  ApprovalControlDecision,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpId,
  OpReceipt,
  RunId,
  RuntimeEvent,
  RuntimeOp,
  ThreadId,
  ThreadSnapshot,
  ThreadUsage,
  UserMessage,
} from '../protocol/index.js';
import type { RuntimePort } from '../runtime/index.js';
import type {
  CliInteractionState,
  CliSessionEvent,
  CliSessionListener,
} from './frontend-types.js';
import type { InteractiveSession } from './interactive-runtime.js';

/** Narrow view used by the default-thread adapter; derived from the public RuntimePort contract. */
export type RuntimeFrontendPort = Pick<
  RuntimePort,
  | 'workspaceId'
  | 'newThreadId'
  | 'newOpId'
  | 'submit'
  | 'events'
  | 'getThreadSnapshot'
  | 'close'
>;

export interface RuntimeFrontendOptions {
  readonly runtime: RuntimeFrontendPort;
  readonly attachment: 'create' | 'resume';
  readonly threadId?: ThreadId;
  readonly initialModel?: ModelConfig;
  /** Makes the full trusted config available to RuntimeModelResolver before an op is submitted. */
  readonly registerModel?: (model: ModelConfig) => void;
}

export class RuntimeFrontendOpRejectedError extends Error {
  override readonly name = 'RuntimeFrontendOpRejectedError';

  constructor(
    readonly opId: ExternalOpId,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export class RuntimeFrontendEventGapError extends Error {
  override readonly name = 'RuntimeFrontendEventGapError';

  constructor(
    readonly threadId: ThreadId,
    readonly lastDeliveredSeq: number,
    readonly nextSeq: number,
  ) {
    super(
      `runtime event gap for ${threadId}: expected ${lastDeliveredSeq + 1}, received ${nextSeq}`,
    );
  }
}

interface OpOutcome {
  readonly accepted: boolean;
  readonly reason?: string;
}

const EMPTY_USAGE: ThreadUsage = {
  cumulative: { input: 0, output: 0 },
  turns: 0,
  contextTokens: 0,
};

/**
 * Runtime-backed implementation of the frontend's legacy-shaped view.
 * `initialize()` establishes the hot subscription before any lifecycle op.
 */
export class RuntimeFrontendSession implements InteractiveSession {
  readonly #runtime: RuntimeFrontendPort;
  readonly #threadId: ThreadId;
  readonly #attachment: 'create' | 'resume';
  readonly #registerModel: ((model: ModelConfig) => void) | undefined;
  readonly #listeners = new Set<CliSessionListener>();
  readonly #attachmentListeners = new Set<
    (messages: readonly AgentMessage[]) => void | Promise<void>
  >();
  readonly #pendingControls = new Map<string, RunId>();
  readonly #opWaiters = new Map<OpId, (outcome: OpOutcome) => void>();

  #model: ModelConfig | undefined;
  #state: CliInteractionState = 'idle';
  #usage: ThreadUsage = EMPTY_USAGE;
  #messages: AgentMessage[] = [];
  #activeRunId: RunId | undefined;
  #attached = false;
  #initialized = false;
  #closed = false;
  #hydrating = true;
  #highWaterSeq = 0;
  #pendingEnvelopes: Readonly<EventEnvelope>[] = [];
  #fanoutTail: Promise<void> = Promise.resolve();
  #eventPump: Promise<void> | undefined;
  #initializePromise: Promise<void> | undefined;
  #attachmentPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #eventFailure: Error | undefined;

  constructor(options: RuntimeFrontendOptions) {
    this.#runtime = options.runtime;
    this.#threadId = options.threadId ?? options.runtime.newThreadId();
    this.#attachment = options.attachment;
    this.#model = options.initialModel;
    this.#registerModel = options.registerModel;
  }

  get threadId(): ThreadId {
    return this.#threadId;
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    if (this.#initialized) return;
    if (this.#initializePromise !== undefined) return this.#initializePromise;
    const initialization = this.#performInitialize();
    this.#initializePromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.#initializePromise === initialization) this.#initializePromise = undefined;
    }
  }

  async #performInitialize(): Promise<void> {
    try {
      const events = this.#runtime.events({ threadIds: [this.#threadId] });
      this.#eventPump = this.#consumeEvents(events);
      if (this.#model !== undefined) await this.#ensureAttached(this.#model);
      this.#initialized = true;
    } catch (error) {
      this.#closed = true;
      await this.#runtime.close().catch(() => undefined);
      await this.#eventPump?.catch(() => undefined);
      throw error;
    }
  }

  interactionState(): CliInteractionState {
    return this.#state;
  }

  currentModel(): ModelRef | undefined {
    return this.#model === undefined ? undefined : { ...this.#model.ref };
  }

  async setModel(model: ModelConfig): Promise<void> {
    this.#assertReady();
    if (this.#state !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再切换模型');
    }
    if (!this.#attached) {
      await this.#ensureAttached(model);
      this.#model = model;
      return;
    }

    this.#registerModel?.(model);
    await this.#commitModelUpdate(model);
    this.#model = model;
  }

  clearModel(): void {
    this.#assertReady();
    if (this.#state !== 'idle') {
      throw new Error('任务仍在运行；请先完成或 abort，再退出 provider');
    }
    this.#model = undefined;
  }

  usage(): ThreadUsage {
    return copyUsage(this.#usage);
  }

  get messages(): readonly AgentMessage[] {
    return copyMessages(this.#messages);
  }

  subscribe(listener: CliSessionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  subscribeSessionAttached(
    listener: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ): () => void {
    this.#attachmentListeners.add(listener);
    return () => {
      this.#attachmentListeners.delete(listener);
    };
  }

  async prompt(text: string): Promise<void> {
    this.#assertReady();
    const model = this.#model;
    if (model === undefined) {
      throw new Error('尚未选择模型；请先运行 /login 配置 provider，再运行 /model');
    }
    await this.#ensureAttached(model);
    const op = {
      type: 'prompt',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      text,
    } satisfies RuntimeOp;
    await this.#submitAndWait(op);
  }

  steer(text: string | UserMessage): void {
    this.#assertReady();
    this.#assertAttachedModel();
    const normalized = normalizeText(text);
    if (normalized === undefined) return;
    this.#submitDetached({
      type: 'steer',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      text: normalized,
    });
  }

  followUp(text: string | UserMessage): void {
    this.#assertReady();
    this.#assertAttachedModel();
    const normalized = normalizeText(text);
    if (normalized === undefined) return;
    this.#submitDetached({
      type: 'follow_up',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      text: normalized,
    });
  }

  abort(): void {
    if (!this.#initialized || this.#closed || !this.#attached) return;
    this.#submitAbort(this.#activeRunId);
  }

  /** Edge-only approval command mapping; unknown/already-resolved ids remain legacy silent no-ops. */
  resolveApproval(
    requestId: string,
    decision: ApprovalControlDecision | 'abort',
  ): void {
    if (!this.#pendingControls.has(requestId) || this.#closed) return;
    if (decision === 'abort') {
      this.#submitAbort(this.#pendingControls.get(requestId));
      return;
    }
    this.#submitDetached({
      type: 'control_response',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      requestId,
      decision,
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#runtime.close();
      await this.#eventPump;
      await this.#fanoutTail;
      this.#resolveAllWaiters('runtime closed');
    })();
    return this.#closePromise;
  }

  async #ensureAttached(model: ModelConfig): Promise<void> {
    if (this.#attached) return;
    if (this.#attachmentPromise !== undefined) return this.#attachmentPromise;
    this.#registerModel?.(model);
    const attachment = this.#attach(model);
    this.#attachmentPromise = attachment;
    try {
      await attachment;
    } finally {
      if (this.#attachmentPromise === attachment) this.#attachmentPromise = undefined;
    }
  }

  async #attach(model: ModelConfig): Promise<void> {
    const op = {
      type: this.#attachment === 'create' ? 'thread_create' : 'thread_resume',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      model: model.ref,
    } satisfies RuntimeOp;
    const receipt = await this.#runtime.submit(op);
    const adoptedAutoAttachment =
      !receipt.accepted &&
      op.type === 'thread_resume' &&
      receipt.reason === 'thread_already_attached';
    if (!receipt.accepted && !adoptedAutoAttachment) {
      throw new RuntimeFrontendOpRejectedError(receipt.opId, receipt.reason);
    }
    const snapshot = await this.#runtime.getThreadSnapshot(this.#threadId);
    if (snapshot === undefined) {
      throw new Error(`Runtime accepted ${op.type} without a thread snapshot`);
    }
    this.#hydrate(snapshot);
    this.#attached = true;
    if (adoptedAutoAttachment && !sameModelRef(snapshot.model, model.ref)) {
      // Supervisor startup may have already recovered the prior lifecycle before the CLI can
      // submit its explicit resume. Preserve the user's requested model through a regular
      // identity-bearing op instead of letting the facade diverge from the attached driver.
      await this.#commitModelUpdate(model);
    }
    this.#model = model;
    for (const listener of [...this.#attachmentListeners]) {
      try {
        await listener(copyMessages(this.#messages));
      } catch (error) {
        console.error('[runtime frontend] attachment listener threw (ignored):', error);
      }
    }
  }

  async #commitModelUpdate(model: ModelConfig): Promise<void> {
    const op = {
      type: 'set_model',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      model: model.ref,
    } satisfies RuntimeOp;
    await this.#submitAndWait(op);
  }

  #hydrate(snapshot: ThreadSnapshot): void {
    this.#messages = [...snapshot.transcript];
    this.#usage = copyUsage(snapshot.usage);
    this.#state = projectInteractionState(snapshot.thread.state);
    this.#activeRunId = snapshot.thread.activeRunId;
    this.#pendingControls.clear();
    for (const request of snapshot.pendingControls) {
      this.#pendingControls.set(request.requestId, request.owningRunId);
    }
    this.#highWaterSeq = snapshot.highWaterSeq;
    const pending = this.#pendingEnvelopes;
    this.#pendingEnvelopes = [];
    this.#hydrating = false;
    try {
      for (const envelope of pending) {
        if (envelope.seq > this.#highWaterSeq) this.#applyEnvelope(envelope);
      }
    } catch (error) {
      this.#reportEventFailure(error);
      throw error;
    }
  }

  async #consumeEvents(events: AsyncIterable<Readonly<EventEnvelope>>): Promise<void> {
    try {
      for await (const envelope of events) {
        if (this.#hydrating) {
          this.#pendingEnvelopes.push(envelope);
          continue;
        }
        this.#applyEnvelope(envelope);
      }
      if (!this.#closed) {
        this.#reportEventFailure(new Error('runtime event stream ended unexpectedly'));
        await this.#fanoutTail;
      }
    } catch (error) {
      this.#reportEventFailure(error);
      await this.#fanoutTail;
    }
  }

  #applyEnvelope(envelope: Readonly<EventEnvelope>): void {
    if (this.#eventFailure !== undefined) return;
    if (envelope.seq <= this.#highWaterSeq) return;
    if (envelope.seq !== this.#highWaterSeq + 1) {
      throw new RuntimeFrontendEventGapError(
        this.#threadId,
        this.#highWaterSeq,
        envelope.seq,
      );
    }
    this.#highWaterSeq = envelope.seq;
    this.#applyCanonicalEvent(envelope.event, envelope.runId, envelope.opId);
    const projected = projectLegacySessionEvent(envelope, {
      targetThreadId: this.#threadId,
    });
    if (projected !== undefined) this.#enqueueFanout(projected);
  }

  #applyCanonicalEvent(event: RuntimeEvent, runId: RunId | undefined, opId: OpId | undefined): void {
    switch (event.type) {
      case 'agent_start':
        this.#state = 'running';
        this.#activeRunId = runId;
        break;
      case 'agent_end':
        if (event.willRetry !== true) {
          this.#state = 'idle';
          this.#activeRunId = undefined;
        }
        break;
      case 'retry_scheduled':
        this.#state = 'retrying';
        this.#activeRunId = event.successorRunId;
        break;
      case 'compaction_start':
        this.#state = 'compacting';
        this.#activeRunId = event.activityRunId;
        break;
      case 'compaction_end':
        if (this.#state === 'compacting') this.#state = 'idle';
        break;
      case 'message_end':
        this.#upsertMessage(event.message);
        break;
      case 'usage_update':
        this.#usage = copyUsage(event.usage);
        break;
      case 'control_request':
        this.#pendingControls.set(event.requestId, event.owningRunId);
        break;
      case 'control_resolved':
        this.#pendingControls.delete(event.requestId);
        break;
      case 'thread_created':
      case 'thread_resumed':
        this.#state = projectInteractionState(event.thread.state);
        this.#activeRunId = event.thread.activeRunId;
        break;
      case 'thread_closed':
        this.#state = 'idle';
        this.#activeRunId = undefined;
        break;
      case 'op_completed':
        if (opId !== undefined) this.#settleOp(opId, { accepted: true });
        break;
      case 'op_rejected':
        if (opId !== undefined) {
          this.#settleOp(opId, { accepted: false, reason: event.reason });
        }
        break;
      default:
        break;
    }
  }

  #upsertMessage(message: AgentMessage): void {
    const index = this.#messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) this.#messages.push(message);
    else this.#messages[index] = message;
  }

  async #submitAndWait(op: RuntimeOp): Promise<void> {
    const completion = this.#waitForOp(op.opId);
    let receipt: OpReceipt;
    try {
      receipt = await this.#runtime.submit(op);
    } catch (error) {
      this.#opWaiters.delete(op.opId);
      throw error;
    }
    if (!receipt.accepted) {
      this.#opWaiters.delete(op.opId);
      throw new RuntimeFrontendOpRejectedError(receipt.opId, receipt.reason);
    }
    const outcome = await completion;
    if (!outcome.accepted) {
      throw new RuntimeFrontendOpRejectedError(op.opId, outcome.reason ?? 'runtime operation rejected');
    }
  }

  #submitDetached(op: RuntimeOp): void {
    void this.#runtime.submit(op).then(
      (receipt) => {
        if (!receipt.accepted) {
          if (
            op.type === 'control_response' &&
            isSilentLegacyControlRejection(receipt.reason)
          ) {
            this.#pendingControls.delete(op.requestId);
            return;
          }
          this.#enqueueFanout({ type: 'error', fatal: false, message: receipt.reason });
        }
      },
      (error: unknown) => {
        this.#enqueueFanout({
          type: 'error',
          fatal: true,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  #submitAbort(expectedRunId?: RunId): void {
    this.#submitDetached({
      type: 'abort',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      ...(expectedRunId !== undefined && { expectedRunId }),
    });
  }

  #waitForOp(opId: OpId): Promise<OpOutcome> {
    return new Promise((resolve) => {
      this.#opWaiters.set(opId, resolve);
    });
  }

  #settleOp(opId: OpId, outcome: OpOutcome): void {
    const resolve = this.#opWaiters.get(opId);
    if (resolve === undefined) return;
    this.#opWaiters.delete(opId);
    resolve(outcome);
  }

  #resolveAllWaiters(reason: string): void {
    const waiters = [...this.#opWaiters.values()];
    this.#opWaiters.clear();
    for (const resolve of waiters) resolve({ accepted: false, reason });
  }

  #reportEventFailure(error: unknown): void {
    if (this.#eventFailure !== undefined) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.#eventFailure = failure;
    this.#resolveAllWaiters(failure.message);
    this.#enqueueFanout({
      type: 'error',
      fatal: true,
      message: `runtime event stream failed: ${failure.message}`,
    });
  }

  async #fanout(event: CliSessionEvent): Promise<void> {
    for (const listener of [...this.#listeners]) {
      try {
        await listener(event);
      } catch (error) {
        console.error('[runtime frontend] listener threw (ignored):', error);
      }
    }
  }

  #enqueueFanout(event: CliSessionEvent): void {
    this.#fanoutTail = this.#fanoutTail.then(() => this.#fanout(event));
  }

  #assertAttachedModel(): void {
    if (!this.#attached || this.#model === undefined) {
      throw new Error('尚未选择模型；请先运行 /model');
    }
  }

  #assertReady(): void {
    this.#assertOpen();
    if (!this.#initialized) throw new Error('runtime frontend is not initialized');
    if (this.#eventFailure !== undefined) throw this.#eventFailure;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('runtime frontend is closed');
  }
}

function normalizeText(input: string | UserMessage): string | undefined {
  const text = typeof input === 'string'
    ? input
    : input.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
  return text.trim().length === 0 ? undefined : text;
}

function sameModelRef(left: ModelRef, right: ModelRef): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model
  );
}

function projectInteractionState(state: ThreadSnapshot['thread']['state']): CliInteractionState {
  switch (state) {
    case 'running':
    case 'starting':
      return 'running';
    case 'retrying':
      return 'retrying';
    case 'compacting':
      return 'compacting';
    case 'idle':
    case 'suspended':
    case 'closing':
    case 'closed':
      return 'idle';
  }
}

function copyUsage(usage: Readonly<ThreadUsage>): ThreadUsage {
  return {
    ...(usage.lastTurn !== undefined && { lastTurn: { ...usage.lastTurn } }),
    cumulative: { ...usage.cumulative },
    turns: usage.turns,
    contextTokens: usage.contextTokens,
  };
}

function copyMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  return strictJsonSnapshot(messages) as unknown as readonly AgentMessage[];
}

function isSilentLegacyControlRejection(reason: string): boolean {
  return (
    reason === 'control_request_not_found' ||
    reason === 'control_response_already_claimed'
  );
}
