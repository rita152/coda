// Checkpoint-only execution engine for one canonical Runtime thread. It owns the Agent,
// retry/compaction policy, usage projection, and the authoritative event sink, but no filesystem
// persistence, public observer surface, workspace identity, or secondary transcript mirror.

import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  CanonicalAgentEvent,
  Context,
  ModelConfig,
  ModelRef,
  QueuedMessage,
  RuntimeCoordinatorEvent,
  StreamFn,
  ThreadUsage,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import { strictJsonSnapshot } from '../protocol/index.js';
import { Agent } from '../agent/index.js';
import type { RuntimeTurnProvider } from '../agent/index.js';
import { CompactionCoordinator } from './compaction-coordinator.js';
import type { CompactionOptions } from './compactor.js';
import { HARD_TRUNCATION_SUMMARY } from './compactor.js';
import { RetryCoordinator } from './retry-coordinator.js';
import type { RetryOptions } from './retry.js';
import type {
  ThreadCompactionCheckpoint,
  ThreadDriverCheckpoint,
} from './thread-runtime-ports.js';
import type { ModelPricing } from './usage.js';
import { UsageTracker } from './usage.js';

type RetryScheduledEvent = Omit<
  Extract<RuntimeCoordinatorEvent, { readonly type: 'retry_scheduled' }>,
  'predecessorRunId' | 'successorRunId'
>;

type CompactionStartEvent = Omit<
  Extract<RuntimeCoordinatorEvent, { readonly type: 'compaction_start' }>,
  'predecessorRunId' | 'activityRunId'
>;

type CompactionEndEvent = Omit<
  Extract<RuntimeCoordinatorEvent, { readonly type: 'compaction_end' }>,
  'activityRunId'
>;

/** Events before the driver supplies run/turn/op identity and coordinator causal links. */
export type RuntimeThreadExecutionEvent =
  | CanonicalAgentEvent
  | RetryScheduledEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | { readonly type: 'usage_update'; readonly usage: Readonly<ThreadUsage> };

export type RuntimeThreadExecutionEventBatch = readonly [
  RuntimeThreadExecutionEvent,
  ...RuntimeThreadExecutionEvent[],
];

export interface RuntimeThreadExecutionOptions {
  readonly model: ModelConfig;
  readonly checkpoint: Readonly<ThreadDriverCheckpoint>;
  readonly runtimeTurnProvider: RuntimeTurnProvider;
  /** Dedicated provider snapshot for summary sampling; never used as a normal turn fallback. */
  readonly compactionStreamFn: StreamFn;
  readonly eventSink: (events: RuntimeThreadExecutionEventBatch) => Promise<void>;
  readonly truncationScope: string;
  readonly pricing?: ModelPricing;
  readonly retry?: RetryOptions;
  readonly compaction?: CompactionOptions;
}

/** Narrow execution surface consumed by RuntimeThreadDriver and its tests. */
export interface RuntimeThreadExecutionPort {
  readonly messages: readonly AgentMessage[];
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  compact(): Promise<{ readonly aborted: boolean }>;
  steer(text: string): void;
  followUp(text: string): void;
  abort(): void;
  usage(): ThreadUsage;
  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting';
  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting';
  deferCompactionResumeToMailbox(): void;
  currentModel(): ModelRef;
  setModel(model: ModelConfig): void;
  compactionCheckpoint(): Readonly<ThreadCompactionCheckpoint> | undefined;
  close(): Promise<void>;
  waitForIdle(): Promise<void>;
}

interface HookHost {
  transform?: (context: Context) => Promise<Context>;
  shouldStop?: (context: Context) => Promise<boolean>;
}

/**
 * RuntimeThreadExecution deliberately has no create/resume distinction: both start from the exact
 * canonical checkpoint selected by the Supervisor. A failed authoritative commit aborts the Agent
 * and permanently latches the attachment; restart reconstructs only the committed checkpoint.
 */
export class RuntimeThreadExecution implements RuntimeThreadExecutionPort {
  readonly #agent: Agent;
  readonly #usage: UsageTracker;
  readonly #retry: RetryCoordinator;
  readonly #compaction: CompactionCoordinator;
  readonly #compactionStreamFn: StreamFn;
  readonly #eventSink: RuntimeThreadExecutionOptions['eventSink'];
  #model: ModelConfig;

  #closed = false;
  #authoritativeFailure: Error | undefined;
  #compacting = false;
  #mailboxOwnsNextActivity = false;
  #opChain: Promise<void> = Promise.resolve();
  #opController: AbortController | undefined;
  #followUpState: 'idle' | 'retrying' | 'compacting' = 'idle';

  constructor(options: RuntimeThreadExecutionOptions) {
    this.#model = options.model;
    this.#usage = new UsageTracker(options.pricing);
    this.#usage.restore(options.checkpoint.frontend.usage);
    this.#retry = new RetryCoordinator(options.retry);
    this.#compaction = new CompactionCoordinator(options.compaction);
    this.#compactionStreamFn = options.compactionStreamFn;
    this.#eventSink = options.eventSink;
    if (options.checkpoint.execution.compaction !== undefined) {
      this.#compaction.restore(options.checkpoint.execution.compaction);
    }

    const hooks: HookHost = {};
    this.#agent = new Agent({
      model: options.model,
      runtimeTurnProvider: options.runtimeTurnProvider,
      initialMessages: [...options.checkpoint.frontend.transcript],
      initialQueues: {
        steering: options.checkpoint.frontend.queues.steering.map((message) =>
          queuedUserMessage(message, 'steering')),
        followUp: options.checkpoint.frontend.queues.followUp.map((message) =>
          queuedUserMessage(message, 'follow_up')),
      },
      truncationScope: options.truncationScope,
      transformContext: (context) => hooks.transform?.(context) ?? Promise.resolve(context),
      shouldStopAfterTurn: (context) => hooks.shouldStop?.(context) ?? Promise.resolve(false),
    });
    hooks.transform = (context) => this.#transformContext(context);
    hooks.shouldStop = () => this.#shouldStopAfterTurn();

    // Agent's ordinary listener contract intentionally isolates rejections. Keep the canonical
    // writer failure in an explicit latch and synchronously abort the run so no later tool/provider
    // work can continue under an event stream whose authority has failed.
    this.#agent.subscribe(async (event) => {
      try {
        this.#throwAuthoritativeFailure();
        const prepared = this.#prepareForCommit(event);
        if (prepared.event.type === 'message_end' && prepared.extras.length > 0) {
          await this.#commit([prepared.event, ...prepared.extras]);
        } else {
          await this.#onAgentEvent(prepared.event, prepared.extras);
        }
      } catch (error) {
        this.#recordAuthoritativeFailure(error);
      }
    });
  }

  async prompt(text: string): Promise<void> {
    this.#assertOperational();
    if (this.#followUpState !== 'idle') {
      throw new Error('Runtime thread has a pending retry or compaction activity');
    }
    await this.#agent.prompt(text);
    this.#throwAuthoritativeFailure();
  }

  async continue(): Promise<void> {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') {
      throw new Error('Runtime thread is not idle');
    }
    await this.#agent.continue();
    this.#throwAuthoritativeFailure();
  }

  async compact(): Promise<{ readonly aborted: boolean }> {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') throw new Error('Runtime thread is not idle');
    if (this.#agent.transcript.length === 0) throw new Error('Runtime thread has no context to compact');
    const controller = new AbortController();
    this.#opController = controller;
    this.#followUpState = 'compacting';
    this.#compacting = true;
    try {
      await this.#runCompaction('manual', controller.signal, false, false);
      this.#throwAuthoritativeFailure();
      return { aborted: controller.signal.aborted };
    } finally {
      this.#compacting = false;
      if (this.#opController === controller) this.#opController = undefined;
      if (this.#followUpState === 'compacting') this.#followUpState = 'idle';
    }
  }

  steer(text: string): void {
    this.#assertOperational();
    this.#agent.steer(text);
  }

  followUp(text: string): void {
    this.#assertOperational();
    this.#agent.followUp(text);
  }

  abort(): void {
    this.#opController?.abort();
    this.#agent.abort();
  }

  usage(): ThreadUsage {
    return this.#usage.snapshot();
  }

  interactionState(): 'idle' | 'running' | 'retrying' | 'compacting' {
    return this.#agent.state === 'running' ? 'running' : this.#followUpState;
  }

  runtimeFollowUpState(): 'idle' | 'retrying' | 'compacting' {
    return this.#followUpState;
  }

  deferCompactionResumeToMailbox(): void {
    if (this.#compacting) this.#mailboxOwnsNextActivity = true;
  }

  currentModel(): ModelRef {
    return { ...this.#model.ref };
  }

  setModel(model: ModelConfig): void {
    this.#assertOperational();
    if (this.interactionState() !== 'idle') throw new Error('Runtime thread is not idle');
    this.#agent.setModel(model);
    this.#model = model;
    this.#retry.resetForModelChange();
    this.#compaction.resetForModelChange();
  }

  get messages(): readonly AgentMessage[] {
    return this.#agent.transcript;
  }

  compactionCheckpoint(): Readonly<ThreadCompactionCheckpoint> | undefined {
    return this.#compaction.checkpoint();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#opController?.abort();
    await this.#opChain.catch(() => undefined);
    this.#agent.abort();
    await this.#agent.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const op = this.#opChain;
      await Promise.all([op, this.#agent.waitForIdle()]);
      if (op === this.#opChain && this.interactionState() === 'idle') {
        this.#throwAuthoritativeFailure();
        return;
      }
    }
  }

  async #transformContext(context: Context): Promise<Context> {
    this.#throwAuthoritativeFailure();
    return this.#compaction.transform(context);
  }

  async #shouldStopAfterTurn(): Promise<boolean> {
    this.#throwAuthoritativeFailure();
    return this.#compaction.shouldStopAfterTurn(
      this.#model,
      this.#usage.snapshot().contextTokens,
    );
  }

  async #onAgentEvent(
    event: CanonicalAgentEvent,
    extras: readonly RuntimeThreadExecutionEvent[],
  ): Promise<void> {
    if (event.type === 'turn_end' && event.message.stopReason !== 'error') {
      this.#retry.observeSuccessfulTurn();
      this.#compaction.observeSuccessfulTurn();
    }
    if (event.type === 'agent_end') {
      await this.#onAgentEnd(event, extras);
      return;
    }
    await this.#commit([event, ...extras]);
  }

  async #onAgentEnd(
    event: Extract<CanonicalAgentEvent, { readonly type: 'agent_end' }>,
    extras: readonly RuntimeThreadExecutionEvent[],
  ): Promise<void> {
    const decision = this.#decideFollowUp(event);
    if (decision.kind === 'retry') {
      this.#scheduleOp('retrying', (signal) => this.#runRetry(decision.delayMs, signal));
      await this.#commit([
        { ...event, willRetry: true },
        ...extras,
        {
          type: 'retry_scheduled',
          attempt: decision.attempt,
          maxAttempts: this.#retry.maxAttempts,
          delayMs: decision.delayMs,
          errorMessage: decision.errorMessage,
        },
      ]);
      return;
    }
    if (decision.kind === 'compaction') {
      this.#compacting = true;
      this.#scheduleOp(
        'compacting',
        (signal) => this.#runCompaction(decision.reason, signal, decision.hardTruncate),
      );
    }
    await this.#commit([event, ...extras]);
    if (decision.kind === 'fatal') {
      await this.#commit([{
        type: 'error',
        message: decision.message,
        fatal: true,
      }]);
    }
  }

  #decideFollowUp(
    event: Extract<CanonicalAgentEvent, { readonly type: 'agent_end' }>,
  ):
    | { readonly kind: 'none' }
    | {
        readonly kind: 'retry';
        readonly attempt: number;
        readonly delayMs: number;
        readonly errorMessage: string;
      }
    | {
        readonly kind: 'compaction';
        readonly reason: 'threshold' | 'overflow';
        readonly hardTruncate: boolean;
      }
    | { readonly kind: 'fatal'; readonly message: string } {
    const last = lastAssistant(event.messages);
    const compact = this.#compaction.decideRunEnd(event.reason, last, this.#model);
    if (compact.kind === 'compact') {
      return {
        kind: 'compaction',
        reason: compact.reason,
        hardTruncate: compact.hardTruncate,
      };
    }
    if (compact.kind === 'fatal') return compact;
    if (event.reason !== 'error') return { kind: 'none' };
    const retry = this.#retry.decide(last);
    return retry.retry ? { kind: 'retry', ...retry } : { kind: 'none' };
  }

  #scheduleOp(
    state: 'retrying' | 'compacting',
    operation: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    this.#opController = controller;
    this.#followUpState = state;
    const previous = this.#opChain;
    this.#opChain = (async () => {
      await previous.catch(() => undefined);
      try {
        if (this.#closed) return;
        await this.#agent.waitForIdle();
        if (this.#closed) return;
        await operation(controller.signal);
      } catch (error) {
        if (this.#authoritativeFailure === undefined) {
          try {
            await this.#commit([{
              type: 'error',
              message: `runtime follow-up failed: ${String(error)}`,
              fatal: false,
            }]);
          } catch (commitError) {
            this.#recordAuthoritativeFailure(commitError);
          }
        }
      } finally {
        if (this.#opController === controller) {
          this.#opController = undefined;
          this.#followUpState = 'idle';
        }
      }
    })();
  }

  async #runRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    let aborted: boolean;
    try {
      aborted = await this.#retry.sleep(delayMs, signal);
    } catch (error) {
      await this.#commit([{
        type: 'error',
        message: `retry sleep failed: ${String(error)}`,
        fatal: true,
      }]);
      return;
    }
    if (aborted) {
      if (!this.#closed) {
        await this.#commit([{
          type: 'error',
          message: 'retry cancelled by abort',
          fatal: false,
        }]);
      }
      return;
    }
    if (!this.#closed) await this.#agent.continue();
  }

  async #runCompaction(
    reason: 'threshold' | 'overflow' | 'manual',
    signal: AbortSignal,
    hardTruncate = false,
    continueAfter = true,
  ): Promise<void> {
    await this.#commit([{ type: 'compaction_start', reason }]);
    const contextTokens = this.#usage.snapshot().contextTokens;
    const plan = this.#compaction.plan(this.#agent.transcript, contextTokens);
    const tailMessage = plan.tailMessage;
    let summary: string;
    if (hardTruncate) {
      summary = HARD_TRUNCATION_SUMMARY;
    } else {
      try {
        summary = await this.#compaction.summarize(
          this.#compactionStreamFn,
          this.#model,
          plan.dropped,
          signal,
          false,
        );
      } catch (error) {
        if (signal.aborted) {
          await this.#commit([{ type: 'compaction_end', ok: false, droppedMessages: 0 }]);
          this.#compacting = false;
          await this.#resumeAfterCompaction(false);
          return;
        }
        if (reason === 'threshold' || reason === 'manual') {
          console.error(`[compaction] summary failed, abandoning: ${String(error)}`);
          await this.#commit([{ type: 'compaction_end', ok: false, droppedMessages: 0 }]);
          this.#compacting = false;
          await this.#resumeAfterCompaction(continueAfter);
          return;
        }
        console.error(`[compaction] overflow summary failed, hard-truncating: ${String(error)}`);
        summary = HARD_TRUNCATION_SUMMARY;
      }
    }
    if (tailMessage === undefined) {
      await this.#commit([{ type: 'compaction_end', ok: false, droppedMessages: 0 }]);
      this.#compacting = false;
      await this.#resumeAfterCompaction(continueAfter);
      return;
    }

    const checkpoint: ThreadCompactionCheckpoint = {
      id: `cmp_${crypto.randomUUID()}`,
      timestamp: Date.now(),
      tailStartId: tailMessage.id,
      summary,
      contextTokensBefore: contextTokens,
    };
    this.#compaction.install(checkpoint);
    await this.#commit([{
      type: 'compaction_end',
      ok: true,
      droppedMessages: plan.dropped.length,
    }]);
    this.#compacting = false;
    await this.#resumeAfterCompaction(continueAfter);
  }

  async #resumeAfterCompaction(continueIfEmpty = true): Promise<void> {
    const mailboxOwnsNextActivity = this.#mailboxOwnsNextActivity;
    this.#mailboxOwnsNextActivity = false;
    if (mailboxOwnsNextActivity || this.#closed || !continueIfEmpty) return;
    try {
      await this.#agent.continue();
    } catch (error) {
      if (!/nothing to continue/iu.test(String(error))) throw error;
    }
  }

  #prepareForCommit(event: AgentEvent): {
    readonly event: CanonicalAgentEvent;
    readonly extras: readonly RuntimeThreadExecutionEvent[];
  } {
    if (event.type === 'tool_execution_end') {
      return {
        event: {
          ...event,
          result: strictJsonSnapshot(withoutInvalidDetails(event.result)) as unknown as ToolResultMessage,
        },
        extras: [],
      };
    }
    if (event.type === 'message_start' && event.message.role === 'tool_result') {
      return {
        event: {
          ...event,
          message: strictJsonSnapshot(withoutInvalidDetails(event.message)) as unknown as ToolResultMessage,
        },
        extras: [],
      };
    }
    if (event.type === 'turn_end') {
      return {
        event: {
          ...event,
          message: this.#canonicalAssistantMessage(event.message),
          toolResults: event.toolResults.map((result) =>
            strictJsonSnapshot(withoutInvalidDetails(result)) as unknown as ToolResultMessage),
        },
        extras: [],
      };
    }
    if (event.type === 'agent_end') {
      return {
        event: {
          ...event,
          messages: event.messages.map((message) => message.role === 'assistant'
            ? this.#canonicalAssistantMessage(message)
            : strictJsonSnapshot(withoutInvalidDetails(message)) as unknown as AgentMessage),
        },
        extras: [],
      };
    }
    if (event.type !== 'message_end') return { event, extras: [] };
    let message = withoutInvalidDetails(event.message);
    const extras: RuntimeThreadExecutionEvent[] = [];
    if (message.role === 'assistant') {
      message = this.#canonicalAssistantMessage(message);
      this.#usage.add(message);
      extras.push({ type: 'usage_update', usage: this.#usage.snapshot() });
    } else {
      message = strictJsonSnapshot(message) as unknown as AgentMessage;
    }
    return { event: { ...event, message }, extras };
  }

  /** Canonicalizes one assistant payload without changing cumulative usage. */
  #canonicalAssistantMessage(message: AssistantMessage): AssistantMessage {
    const cost = message.usage.costUSD ?? this.#usage.cost(message.usage);
    const enriched = cost !== undefined && message.usage.costUSD === undefined
      ? { ...message, usage: { ...message.usage, costUSD: cost } }
      : message;
    return strictJsonSnapshot(enriched) as unknown as AssistantMessage;
  }

  #commit(events: RuntimeThreadExecutionEventBatch): Promise<void> {
    this.#throwAuthoritativeFailure();
    return this.#eventSink(events);
  }

  #recordAuthoritativeFailure(error: unknown): void {
    if (this.#authoritativeFailure !== undefined) return;
    this.#authoritativeFailure = error instanceof Error
      ? error
      : new Error(`authoritative event commit failed: ${String(error)}`);
    this.#opController?.abort();
    this.#agent.abort();
  }

  #throwAuthoritativeFailure(): void {
    if (this.#authoritativeFailure !== undefined) throw this.#authoritativeFailure;
  }

  #assertOperational(): void {
    if (this.#closed) throw new Error('Runtime thread execution is closed');
    this.#throwAuthoritativeFailure();
  }
}

function queuedUserMessage(message: QueuedMessage, source: 'steering' | 'follow_up'): UserMessage {
  if (message.kind !== source) throw new Error(`Runtime queue kind mismatch: ${message.kind}`);
  return {
    role: 'user',
    id: message.id,
    timestamp: 0,
    content: [{ type: 'text', text: message.text }],
    source,
  };
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

function withoutInvalidDetails(message: ToolResultMessage): ToolResultMessage;
function withoutInvalidDetails(message: AgentMessage): AgentMessage;
function withoutInvalidDetails(message: AgentMessage): AgentMessage {
  if (message.role !== 'tool_result' || message.details === undefined) return message;
  try {
    return { ...message, details: strictJsonSnapshot(message.details) };
  } catch {
    const { details, ...withoutDetails } = message;
    void details;
    return withoutDetails;
  }
}
