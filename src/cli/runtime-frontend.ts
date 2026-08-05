// Default-thread human-frontend adapter over RuntimePort. All business actions become
// identity-bearing RuntimeOps, and emitted payloads are projections of RuntimeEvent values.

import { strictJsonSnapshot } from '../protocol/index.js';
import type {
  AgentMessage,
  ApprovalControlDecision,
  ApprovalPresentation,
  EventEnvelope,
  ExternalOpId,
  ModelConfig,
  ModelRef,
  OpId,
  OpReceipt,
  RunId,
  RuntimeEvent,
  RuntimeDiffSnapshot,
  RuntimeOp,
  RuntimeReviewSnapshot,
  RuntimeThreadListItem,
  ThreadId,
  ThreadSnapshot,
  ThreadUsage,
  UserMessage,
  WorkspaceRuntimeSnapshot,
} from '../protocol/index.js';
import type { RuntimePort } from '../runtime/index.js';
import type {
  CliInteractionState,
  CliRuntimeEnvelopeListener,
  CliRuntimeEvent,
  CliRuntimeEventListener,
} from './frontend-types.js';
import type { InteractiveSession } from './interactive-runtime.js';
import { sanitizeTerminalError } from './terminal-sanitize.js';

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
> & Partial<Pick<
  RuntimePort,
  | 'listThreadDetails'
  | 'getWorkspaceSnapshot'
  | 'getReviewSnapshot'
  | 'getDiffSnapshot'
>>;

export interface RuntimeFrontendOptions {
  readonly runtime: RuntimeFrontendPort;
  readonly attachment: 'create' | 'resume';
  readonly threadId?: ThreadId;
  readonly initialModel?: ModelConfig;
  /** Makes the full trusted config available to RuntimeModelResolver before an op is submitted. */
  readonly registerModel?: (model: ModelConfig) => void;
}

export interface PendingApprovalView {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly presentation: Readonly<ApprovalPresentation>;
}

export interface PendingApprovalSnapshot {
  readonly threadId: ThreadId;
  readonly approvals: readonly PendingApprovalView[];
}

export interface RuntimeWorkspaceActions {
  readonly currentThreadId: ThreadId;
  eventHighWaterSeq(): number;
  listSessions(): Promise<readonly RuntimeThreadListItem[]>;
  workspaceSnapshot(): Promise<Readonly<WorkspaceRuntimeSnapshot>>;
  switchSession(threadId: ThreadId): Promise<void>;
  newSession(model?: ModelConfig): Promise<ThreadId>;
  renameSession(title: string): Promise<void>;
  archiveSession(archived?: boolean): Promise<void>;
  compactConversation(): Promise<void>;
  forkConversation(throughTurnId?: import('../protocol/index.js').TurnId): Promise<ThreadId>;
  reviewSnapshot(): Promise<Readonly<RuntimeReviewSnapshot> | undefined>;
  diffSnapshot(scope: 'turn' | 'workspace'): Promise<Readonly<RuntimeDiffSnapshot> | undefined>;
  pendingApprovals(): readonly PendingApprovalView[];
  subscribePendingApprovals(
    listener: (snapshot: Readonly<PendingApprovalSnapshot>) => void | Promise<void>,
  ): () => void;
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
 * Runtime-backed implementation of the human frontend view.
 * `initialize()` establishes the hot subscription before any lifecycle op.
 */
export class RuntimeFrontendSession implements InteractiveSession, RuntimeWorkspaceActions {
  readonly #runtime: RuntimeFrontendPort;
  #threadId: ThreadId;
  #attachment: 'create' | 'resume';
  readonly #registerModel: ((model: ModelConfig) => void) | undefined;
  readonly #listeners = new Set<CliRuntimeEventListener>();
  readonly #envelopeListeners = new Set<CliRuntimeEnvelopeListener>();
  readonly #attachmentListeners = new Set<
    (messages: readonly AgentMessage[]) => void | Promise<void>
  >();
  readonly #pendingApprovalListeners = new Set<
    (snapshot: Readonly<PendingApprovalSnapshot>) => void | Promise<void>
  >();
  readonly #pendingControls = new Map<string, {
    readonly runId: RunId;
    readonly presentation: Readonly<ApprovalPresentation>;
    readonly toolCallId: string;
    readonly description: string;
  }>();
  readonly #abortRequestedRuns = new Set<RunId>();
  readonly #submittedControlResponses = new Map<ThreadId, Map<string, OpId>>();
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
  readonly #threadHighWater = new Map<ThreadId, number>();
  #pendingEnvelopes: Readonly<EventEnvelope>[] = [];
  #transitionThreadId: ThreadId | undefined;
  #transitionEnvelopes: Readonly<EventEnvelope>[] = [];
  #fanoutTail: Promise<void> = Promise.resolve();
  #pendingApprovalRevision = 0;
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

  get currentThreadId(): ThreadId {
    return this.#threadId;
  }

  /** Runtime owns no thread or journal until attachment succeeds. */
  isAttached(): boolean {
    return this.#attached;
  }

  /** Frontends use the canonical Runtime cursor only for unread presentation bookkeeping. */
  eventHighWaterSeq(): number {
    return this.#highWaterSeq;
  }

  listSessions(): Promise<readonly RuntimeThreadListItem[]> {
    this.#assertReady();
    return this.#requireWorkspaceMethod('listThreadDetails')();
  }

  workspaceSnapshot(): Promise<Readonly<WorkspaceRuntimeSnapshot>> {
    this.#assertReady();
    return this.#requireWorkspaceMethod('getWorkspaceSnapshot')();
  }

  async switchSession(threadId: ThreadId): Promise<void> {
    this.#assertReady();
    if (threadId === this.#threadId) return;
    if (this.#transitionThreadId !== undefined) {
      throw new Error(`Session switch to ${this.#transitionThreadId} is already in progress`);
    }
    this.#transitionThreadId = threadId;
    this.#transitionEnvelopes = [];
    try {
      const snapshot = await this.#runtime.getThreadSnapshot(threadId);
      if (snapshot === undefined) throw new Error(`Unknown session ${threadId}`);
      const resume = await this.#runtime.submit({
        type: 'thread_resume',
        opId: this.#runtime.newOpId(),
        workspaceId: this.#runtime.workspaceId,
        threadId,
        model: snapshot.model,
      });
      if (!resume.accepted && resume.reason !== 'thread_already_attached') {
        throw new RuntimeFrontendOpRejectedError(resume.opId, resume.reason);
      }
      const hydrated = await this.#runtime.getThreadSnapshot(threadId);
      if (hydrated === undefined) throw new Error(`Runtime resumed ${threadId} without a snapshot`);
      const pending = this.#transitionEnvelopes;
      this.#transitionThreadId = undefined;
      this.#transitionEnvelopes = [];
      this.#threadId = threadId;
      this.#attachment = 'resume';
      this.#attached = true;
      this.#model = { ref: { ...hydrated.model } };
      this.#hydrating = true;
      this.#pendingEnvelopes = pending;
      this.#hydrate(hydrated);
      await this.#notifyAttachment();
    } catch (error) {
      const pending = this.#transitionEnvelopes;
      this.#transitionThreadId = undefined;
      this.#transitionEnvelopes = [];
      for (const envelope of pending) this.#applyEnvelope(envelope);
      throw error;
    }
  }

  async newSession(model = this.#model): Promise<ThreadId> {
    this.#assertReady();
    const previous = {
      threadId: this.#threadId,
      attachment: this.#attachment,
      attached: this.#attached,
      model: this.#model,
      state: this.#state,
      usage: copyUsage(this.#usage),
      messages: copyMessages(this.#messages),
      activeRunId: this.#activeRunId,
      pendingControls: [...this.#pendingControls],
      hydrating: this.#hydrating,
      highWaterSeq: this.#highWaterSeq,
      pendingEnvelopes: [...this.#pendingEnvelopes],
    };
    const restorePrevious = (notifyPendingApprovals = true): void => {
      this.#threadId = previous.threadId;
      this.#attachment = previous.attachment;
      this.#attached = previous.attached;
      this.#model = previous.model;
      this.#state = previous.state;
      this.#usage = copyUsage(previous.usage);
      this.#messages = [...previous.messages];
      this.#activeRunId = previous.activeRunId;
      this.#pendingControls.clear();
      for (const [requestId, control] of previous.pendingControls) {
        this.#pendingControls.set(requestId, control);
      }
      this.#hydrating = previous.hydrating;
      this.#highWaterSeq = previous.highWaterSeq;
      this.#pendingEnvelopes = [...previous.pendingEnvelopes];
      if (notifyPendingApprovals) this.#enqueuePendingApprovalSnapshot();
    };
    const threadId = this.#runtime.newThreadId();
    this.#threadId = threadId;
    this.#attachment = 'create';
    this.#attached = false;
    this.#model = model;
    this.#hydrating = true;
    this.#pendingEnvelopes = [];
    this.#resetDetachedView();
    try {
      if (model !== undefined) await this.#ensureAttached(model);
      else await this.#notifyAttachment();
      return threadId;
    } catch (error) {
      const failedTargetEnvelopes = [...this.#pendingEnvelopes];
      restorePrevious(false);
      // An accepted create can still fail later while hydrating its snapshot. Preserve the
      // workspace stream cursor for every event already observed from that now-background thread;
      // otherwise its next live envelope would look like a fatal gap after we restore the source.
      for (const envelope of failedTargetEnvelopes) {
        try {
          this.#applyEnvelope(envelope);
        } catch (streamError) {
          this.#reportEventFailure(streamError);
          break;
        }
      }
      if (previous.attached) {
        this.#hydrating = true;
        this.#pendingEnvelopes = [];
        try {
          const snapshot = await this.#runtime.getThreadSnapshot(previous.threadId);
          if (snapshot === undefined) restorePrevious();
          else this.#hydrate(snapshot);
        } catch {
          restorePrevious();
        }
      } else this.#enqueuePendingApprovalSnapshot();
      throw error;
    }
  }

  async renameSession(title: string): Promise<void> {
    this.#assertReady();
    this.#assertAttachedModel();
    const trimmed = title.trim();
    if (trimmed === '') throw new Error('Session title cannot be empty');
    await this.#submitAndWait({
      type: 'thread_rename',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      title: trimmed,
    });
  }

  async archiveSession(archived = true): Promise<void> {
    this.#assertReady();
    this.#assertAttachedModel();
    await this.#submitAndWait({
      type: 'thread_archive',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
      archived,
    });
  }

  async compactConversation(): Promise<void> {
    this.#assertReady();
    this.#assertAttachedModel();
    await this.#submitAndWait({
      type: 'compact',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      threadId: this.#threadId,
    });
  }

  async forkConversation(
    throughTurnId?: import('../protocol/index.js').TurnId,
  ): Promise<ThreadId> {
    this.#assertReady();
    const model = this.#model;
    if (model === undefined) throw new Error('尚未选择模型；请先运行 /model');
    const target = this.#runtime.newThreadId();
    const receipt = await this.#runtime.submit({
      type: 'conversation_fork',
      opId: this.#runtime.newOpId(),
      workspaceId: this.#runtime.workspaceId,
      sourceThreadId: this.#threadId,
      threadId: target,
      model: model.ref,
      ...(throughTurnId === undefined ? {} : { throughTurnId }),
    });
    if (!receipt.accepted) throw new RuntimeFrontendOpRejectedError(receipt.opId, receipt.reason);
    await this.switchSession(target);
    return target;
  }

  reviewSnapshot(): Promise<Readonly<RuntimeReviewSnapshot> | undefined> {
    this.#assertReady();
    return this.#requireWorkspaceMethod('getReviewSnapshot')(this.#threadId);
  }

  diffSnapshot(scope: 'turn' | 'workspace'): Promise<Readonly<RuntimeDiffSnapshot> | undefined> {
    this.#assertReady();
    return this.#requireWorkspaceMethod('getDiffSnapshot')(this.#threadId, scope);
  }

  pendingApprovals(): readonly PendingApprovalView[] {
    return [...this.#pendingControls].flatMap(([requestId, control]) =>
      this.#hasSubmittedControlResponse(this.#threadId, requestId)
        ? []
        : [{
            requestId,
            toolCallId: control.toolCallId,
            description: control.description,
            presentation: control.presentation,
          }]);
  }

  subscribePendingApprovals(
    listener: (snapshot: Readonly<PendingApprovalSnapshot>) => void | Promise<void>,
  ): () => void {
    this.#pendingApprovalListeners.add(listener);
    this.#enqueuePendingApprovalSnapshot(listener);
    return () => {
      this.#pendingApprovalListeners.delete(listener);
    };
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
      // One non-blocking workspace stream keeps background runs alive while the visible target
      // changes. Only the selected thread is projected into the human UI view.
      const events = this.#runtime.events();
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

  subscribe(listener: CliRuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Machine-facing observation of exact canonical envelopes for the selected thread. */
  subscribeEnvelopes(listener: CliRuntimeEnvelopeListener): () => void {
    this.#envelopeListeners.add(listener);
    return () => {
      this.#envelopeListeners.delete(listener);
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

  resolveApproval(
    requestId: string,
    decision: ApprovalControlDecision | 'abort',
  ): void {
    if (this.#closed) throw new Error('runtime frontend is closed');
    const control = this.#pendingControls.get(requestId);
    if (control === undefined) throw new Error(`approval request ${JSON.stringify(requestId)} is not pending`);
    if (decision === 'abort') {
      this.#submitAbort(control.runId);
      return;
    }
    const opId = this.#runtime.newOpId();
    if (!this.#markSubmittedControlResponse(this.#threadId, requestId, opId)) return;
    this.#enqueuePendingApprovalSnapshot();
    this.#submitDetached({
      type: 'control_response',
      opId,
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
      // identity-bearing op instead of letting the adapter diverge from the attached driver.
      await this.#commitModelUpdate(model);
    }
    this.#model = model;
    await this.#notifyAttachment();
  }

  async #notifyAttachment(): Promise<void> {
    for (const listener of [...this.#attachmentListeners]) {
      try {
        await listener(copyMessages(this.#messages));
      } catch (error) {
        console.error(
          `[runtime frontend] attachment listener threw (ignored): ${sanitizeTerminalError(error)}`,
        );
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
      if (request.kind !== 'approval') continue;
      this.#pendingControls.set(request.requestId, {
        runId: request.owningRunId,
        presentation: request.payload.presentation,
        toolCallId: request.payload.toolCallId,
        description: request.payload.description,
      });
    }
    this.#reconcileSubmittedControlResponses(
      this.#threadId,
      new Set(snapshot.pendingControls.map((request) => request.requestId)),
    );
    this.#highWaterSeq = snapshot.highWaterSeq;
    this.#threadHighWater.set(this.#threadId, snapshot.highWaterSeq);
    const pending = this.#pendingEnvelopes;
    this.#pendingEnvelopes = [];
    this.#hydrating = false;
    try {
      for (const envelope of pending) {
        if (envelope.seq > this.#highWaterSeq) this.#applyEnvelope(envelope);
        else this.#applyControlResponseLifecycle(envelope);
      }
    } catch (error) {
      this.#reportEventFailure(error);
      throw error;
    }
    this.#enqueuePendingApprovalSnapshot();
  }

  async #consumeEvents(events: AsyncIterable<Readonly<EventEnvelope>>): Promise<void> {
    try {
      for await (const envelope of events) {
        if (envelope.threadId === this.#transitionThreadId) {
          this.#transitionEnvelopes.push(envelope);
          continue;
        }
        if (this.#hydrating) {
          if (envelope.threadId === this.#threadId) this.#pendingEnvelopes.push(envelope);
          else this.#applyEnvelope(envelope);
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
    // A no-cursor workspace subscription begins at each registered thread's durable high-water.
    // Establish that baseline from the first live envelope without loading every thread snapshot.
    const previous = this.#threadHighWater.get(envelope.threadId) ?? envelope.seq - 1;
    if (envelope.seq <= previous) return;
    if (envelope.seq !== previous + 1) {
      throw new RuntimeFrontendEventGapError(
        envelope.threadId,
        previous,
        envelope.seq,
      );
    }
    this.#threadHighWater.set(envelope.threadId, envelope.seq);
    const submittedApprovalChanged = this.#applyControlResponseLifecycle(envelope);
    if (envelope.threadId !== this.#threadId) {
      if (envelope.opId !== undefined && envelope.event.type === 'op_completed') {
        this.#settleOp(envelope.opId, { accepted: true });
      } else if (envelope.opId !== undefined && envelope.event.type === 'op_rejected') {
        this.#settleOp(envelope.opId, { accepted: false, reason: envelope.event.reason });
      }
      return;
    }
    this.#highWaterSeq = envelope.seq;
    const terminalFallback = this.#applyCanonicalEvent(
      envelope.event,
      envelope.runId,
      envelope.opId,
    );
    this.#enqueueEnvelopeFanout(envelope);
    this.#enqueueFanout(terminalFallback ?? envelope.event);
    if (
      ((envelope.event.type === 'control_request' || envelope.event.type === 'control_resolved') &&
        envelope.event.kind === 'approval') ||
      submittedApprovalChanged
    ) {
      this.#enqueuePendingApprovalSnapshot();
    }
  }

  #applyControlResponseLifecycle(envelope: Readonly<EventEnvelope>): boolean {
    const event = envelope.event;
    if (event.type === 'control_resolved') {
      return this.#clearSubmittedControlResponse(envelope.threadId, event.requestId);
    }
    if (
      (event.type === 'op_completed' || event.type === 'op_rejected') &&
      event.opType === 'control_response' &&
      envelope.opId !== undefined
    ) {
      const requestId = this.#submittedControlResponseByOp(envelope.threadId, envelope.opId);
      if (requestId === undefined) return false;
      const cleared = this.#clearSubmittedControlResponse(
        envelope.threadId,
        requestId,
        envelope.opId,
      );
      return cleared;
    }
    return false;
  }

  #hasSubmittedControlResponse(threadId: ThreadId, requestId: string): boolean {
    return this.#submittedControlResponses.get(threadId)?.has(requestId) === true;
  }

  #markSubmittedControlResponse(
    threadId: ThreadId,
    requestId: string,
    opId: OpId,
  ): boolean {
    let submitted = this.#submittedControlResponses.get(threadId);
    if (submitted?.has(requestId) === true) return false;
    if (submitted === undefined) {
      submitted = new Map();
      this.#submittedControlResponses.set(threadId, submitted);
    }
    submitted.set(requestId, opId);
    return true;
  }

  #clearSubmittedControlResponse(
    threadId: ThreadId,
    requestId: string,
    expectedOpId?: OpId,
  ): boolean {
    const submitted = this.#submittedControlResponses.get(threadId);
    if (submitted === undefined) return false;
    if (expectedOpId !== undefined && submitted.get(requestId) !== expectedOpId) return false;
    const cleared = submitted.delete(requestId);
    if (submitted.size === 0) this.#submittedControlResponses.delete(threadId);
    return cleared;
  }

  #submittedControlResponseByOp(threadId: ThreadId, opId: OpId): string | undefined {
    const submitted = this.#submittedControlResponses.get(threadId);
    if (submitted === undefined) return undefined;
    for (const [requestId, submittedOpId] of submitted) {
      if (submittedOpId === opId) return requestId;
    }
    return undefined;
  }

  #reconcileSubmittedControlResponses(
    threadId: ThreadId,
    pendingRequestIds: ReadonlySet<string>,
  ): void {
    const submitted = this.#submittedControlResponses.get(threadId);
    if (submitted === undefined) return;
    for (const requestId of submitted.keys()) {
      if (!pendingRequestIds.has(requestId)) submitted.delete(requestId);
    }
    if (submitted.size === 0) this.#submittedControlResponses.delete(threadId);
  }

  #applyCanonicalEvent(
    event: RuntimeEvent,
    runId: RunId | undefined,
    opId: OpId | undefined,
  ): CliRuntimeEvent | undefined {
    switch (event.type) {
      case 'agent_start':
        this.#state = 'running';
        this.#activeRunId = runId;
        break;
      case 'agent_end':
        if (event.willRetry === true) {
          this.#state = 'retrying';
        } else {
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
        if (this.#state === 'compacting') {
          this.#state = 'idle';
          this.#activeRunId = undefined;
        }
        break;
      case 'error':
        if (event.fatal || this.#state === 'retrying') {
          this.#state = 'idle';
          this.#activeRunId = undefined;
        }
        break;
      case 'message_end':
        this.#upsertMessage(event.message);
        break;
      case 'usage_update':
        this.#usage = copyUsage(event.usage);
        break;
      case 'control_request':
        if (event.kind !== 'approval') break;
        this.#pendingControls.set(event.requestId, {
          runId: event.owningRunId,
          presentation: event.payload.presentation,
          toolCallId: event.payload.toolCallId,
          description: event.payload.description,
        });
        break;
      case 'control_resolved':
        this.#pendingControls.delete(event.requestId);
        break;
      case 'thread_created':
      case 'thread_resumed':
      case 'thread_updated':
        this.#state = projectInteractionState(event.thread.state);
        this.#activeRunId = event.thread.activeRunId;
        break;
      case 'thread_closed':
        this.#state = 'idle';
        this.#activeRunId = undefined;
        break;
      case 'op_completed': {
        let terminalFallback: CliRuntimeEvent | undefined;
        if (event.opType === 'prompt' || event.opType === 'continue' || event.opType === 'compact') {
          const needsTerminalFallback = this.#state !== 'idle';
          const wasAbortRequested = this.#abortRequestedRuns.delete(event.terminalRunId);
          this.#state = 'idle';
          this.#activeRunId = undefined;
          if (needsTerminalFallback) {
            terminalFallback = {
              type: 'agent_end',
              reason:
                event.outcome === 'applied'
                  ? 'completed'
                  : wasAbortRequested ? 'aborted' : 'error',
              messages: [...copyMessages(this.#messages)],
            };
          }
        }
        if (opId !== undefined) this.#settleOp(opId, { accepted: true });
        return terminalFallback;
      }
      case 'op_rejected':
        if (opId !== undefined) {
          this.#settleOp(opId, { accepted: false, reason: event.reason });
        }
        break;
      default:
        break;
    }
    return undefined;
  }

  #upsertMessage(message: AgentMessage): void {
    const index = this.#messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 0) this.#messages.push(message);
    else this.#messages[index] = message;
  }

  #resetDetachedView(): void {
    this.#state = 'idle';
    this.#usage = copyUsage(EMPTY_USAGE);
    this.#messages = [];
    this.#activeRunId = undefined;
    this.#pendingControls.clear();
    this.#highWaterSeq = this.#threadHighWater.get(this.#threadId) ?? 0;
    this.#enqueuePendingApprovalSnapshot();
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
          if (op.type === 'abort') {
            if (op.expectedRunId !== undefined) this.#abortRequestedRuns.delete(op.expectedRunId);
            if (receipt.reason === 'stale_run') return;
          }
          if (op.type === 'control_response') {
            const cleared = this.#clearSubmittedControlResponse(
              op.threadId,
              op.requestId,
              op.opId,
            );
            if (cleared && op.threadId === this.#threadId) {
              this.#enqueuePendingApprovalSnapshot();
            }
          }
          if (!('threadId' in op) || op.threadId === this.#threadId) {
            this.#enqueueFanout({ type: 'error', fatal: false, message: receipt.reason });
          }
        }
      },
      (error: unknown) => {
        if (op.type === 'abort' && op.expectedRunId !== undefined) {
          this.#abortRequestedRuns.delete(op.expectedRunId);
        }
        if (op.type === 'control_response') {
          const cleared = this.#clearSubmittedControlResponse(
            op.threadId,
            op.requestId,
            op.opId,
          );
          if (cleared && op.threadId === this.#threadId) {
            this.#enqueuePendingApprovalSnapshot();
          }
        }
        this.#enqueueFanout({
          type: 'error',
          fatal: true,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  #submitAbort(expectedRunId?: RunId): void {
    if (expectedRunId !== undefined) this.#abortRequestedRuns.add(expectedRunId);
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

  async #fanout(event: CliRuntimeEvent): Promise<void> {
    for (const listener of [...this.#listeners]) {
      try {
        await listener(event);
      } catch (error) {
        console.error(`[runtime frontend] listener threw (ignored): ${sanitizeTerminalError(error)}`);
      }
    }
  }

  async #fanoutEnvelope(
    envelope: Readonly<EventEnvelope>,
    listeners: readonly CliRuntimeEnvelopeListener[],
  ): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener(envelope);
      } catch (error) {
        console.error(
          `[runtime frontend] envelope listener threw (ignored): ${sanitizeTerminalError(error)}`,
        );
      }
    }
  }

  #enqueueFanout(event: CliRuntimeEvent): void {
    this.#fanoutTail = this.#fanoutTail.then(() => this.#fanout(event));
  }

  #enqueueEnvelopeFanout(envelope: Readonly<EventEnvelope>): void {
    // Capture observers at the canonical observation point: late subscribers must not receive
    // pre-subscription envelopes, while already-observed records still drain after unsubscribe.
    const listeners = [...this.#envelopeListeners];
    if (listeners.length === 0) return;
    this.#fanoutTail = this.#fanoutTail.then(() => this.#fanoutEnvelope(envelope, listeners));
  }

  #enqueuePendingApprovalSnapshot(
    target?: (snapshot: Readonly<PendingApprovalSnapshot>) => void | Promise<void>,
  ): void {
    const listeners = target === undefined ? [...this.#pendingApprovalListeners] : [target];
    const revisionAtEnqueue = target === undefined
      ? ++this.#pendingApprovalRevision
      : this.#pendingApprovalRevision;
    const snapshot: Readonly<PendingApprovalSnapshot> = {
      threadId: this.#threadId,
      approvals: this.pendingApprovals(),
    };
    this.#fanoutTail = this.#fanoutTail.then(async () => {
      // A targeted subscription replay is obsolete once a newer broadcast exists. Broadcasts
      // themselves are never coalesced across the shared frontend event queue: each captured level
      // is an ordering barrier, so a resolved card is gone before the next Runtime event fanout.
      if (target !== undefined && revisionAtEnqueue !== this.#pendingApprovalRevision) return;
      for (const listener of listeners) {
        if (!this.#pendingApprovalListeners.has(listener)) continue;
        try {
          await listener(snapshot);
        } catch (error) {
          console.error(
            `[runtime frontend] pending approval listener threw (ignored): ${sanitizeTerminalError(error)}`,
          );
        }
      }
    });
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

  #requireWorkspaceMethod<K extends keyof Pick<
    RuntimePort,
    'listThreadDetails' | 'getWorkspaceSnapshot' | 'getReviewSnapshot' | 'getDiffSnapshot'
  >>(name: K): NonNullable<RuntimePort[K]> {
    const method = this.#runtime[name];
    if (method === undefined) throw new Error(`Runtime frontend method ${name} is unavailable`);
    return method.bind(this.#runtime) as NonNullable<RuntimePort[K]>;
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
