import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Static,
	TextContent,
	Tool,
	ToolCall,
	ToolObservation,
	TSchema,
	UserMessage,
} from "@coda/ai";

declare const opaqueId: unique symbol;

type OpaqueId<TName extends string> = string & { readonly [opaqueId]: TName };

export type RunId = OpaqueId<"RunId">;
export type TurnId = OpaqueId<"TurnId">;
export type AttemptId = OpaqueId<"AttemptId">;
export type MessageId = OpaqueId<"MessageId">;
export type ToolInvocationId = OpaqueId<"ToolInvocationId">;
export type QueueItemId = OpaqueId<"QueueItemId">;

export type IdKind = "run" | "turn" | "attempt" | "message" | "tool_invocation" | "queue_item" | "process_session";

export interface IdGenerator {
	generate(kind: IdKind): string;
}

export interface Clock {
	now(): number;
}

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type Immutable<T> = T extends Primitive
	? T
	: T extends (...args: never[]) => unknown
		? T
		: T extends readonly (infer TItem)[]
			? readonly Immutable<TItem>[]
			: T extends object
				? { readonly [TKey in keyof T]: Immutable<T[TKey]> }
				: T;

export interface AgentMessage<TMessage extends Message = Message> {
	readonly id: MessageId;
	readonly message: Immutable<TMessage>;
}

export type AgentInput = UserMessage["content"];

export interface Steering {
	readonly id: QueueItemId;
	readonly content: Immutable<AgentInput>;
}

export interface FollowUp {
	readonly id: QueueItemId;
	readonly content: Immutable<AgentInput>;
}

export interface AgentSeed {
	readonly version: 1;
	readonly messages: readonly AgentMessage[];
	readonly pendingFollowUps: readonly FollowUp[];
}

export type RunSource = "prompt" | "follow_up";
export type RunOutcome = "success" | "error" | "aborted";

export interface RunLimits {
	readonly maxTurns?: number;
	readonly maxModelAttempts?: number;
	readonly maxToolInvocations?: number;
	readonly maxElapsedMs?: number;
	readonly maxTotalTokens?: number;
	readonly maxTotalCostUsd?: number;
	readonly maxConsecutiveEquivalentToolBatches?: number;
}

/** Immutable limits frozen for one Run. Accounting starts fresh for every Run. */
export interface RunBudget {
	readonly limits: RunLimits;
}

export type RunLimitKind =
	| "turns"
	| "model_attempts"
	| "tool_invocations"
	| "elapsed_ms"
	| "total_tokens"
	| "total_cost_usd"
	| "consecutive_equivalent_tool_batches";

export interface RunBudgetExhaustion {
	readonly limit: RunLimitKind;
	readonly maximum: number;
	readonly observed: number;
}

export type RunFailure =
	| {
			readonly kind: "model" | "tool" | "runtime" | "listener";
			readonly message: string;
	  }
	| {
			readonly kind: "budget";
			readonly message: string;
			readonly exhaustion: RunBudgetExhaustion;
	  };

export interface ActiveRun {
	readonly id: RunId;
	readonly source: RunSource;
	readonly queueItemId?: QueueItemId;
	readonly budget?: RunBudget;
	readonly budgetExhaustion?: RunBudgetExhaustion;
}

export interface RunSummary {
	readonly id: RunId;
	readonly outcome: RunOutcome;
	readonly failure?: RunFailure;
}

export interface AgentState {
	readonly status: "idle" | "running" | "settling";
	readonly activeRun?: ActiveRun;
	readonly activeTurnId?: TurnId;
	readonly messages: readonly AgentMessage[];
	readonly pendingSteering: readonly Steering[];
	readonly pendingFollowUps: readonly FollowUp[];
	readonly lastRun?: RunSummary;
}

export interface ModelCallRequest {
	readonly context: Context;
	readonly signal: AbortSignal;
	readonly runId: RunId;
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
}

export type ModelStream = (
	request: ModelCallRequest,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ToolReplaySafety = "never" | "safe";

export interface ToolExecutionOutput<TDetails = unknown> {
	readonly content: string | readonly (TextContent | ImageContent)[];
	readonly observation?: ToolObservation;
	/** Host-only presentation/audit metadata, not a model semantic channel. */
	readonly details?: TDetails;
	/** @deprecated Compatibility input. New Tools should set observation.status. */
	readonly isError?: boolean;
}

export interface ToolExecutionProgress {
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

export interface ToolExecutionContext {
	readonly signal: AbortSignal;
	readonly runId: RunId;
	readonly turnId: TurnId;
	readonly invocationId: ToolInvocationId;
	readonly resultMessageId: MessageId;
	readonly providerToolCallId: string;
	readonly reportProgress?: (progress: ToolExecutionProgress) => void;
}

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	readonly replaySafety: ToolReplaySafety;
	readonly parallelSafe?: boolean;
	execute(
		arguments_: Static<TParameters>,
		context: ToolExecutionContext,
	): ToolExecutionOutput<TDetails> | Promise<ToolExecutionOutput<TDetails>>;
}

export interface ToolInvocation {
	readonly id: ToolInvocationId;
	readonly resultMessageId: MessageId;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly arguments: Immutable<Record<string, unknown>>;
	readonly sourceIndex: number;
	readonly replaySafety?: ToolReplaySafety;
}

export type ToolRejectionReason = "missing" | "invalid" | "aborted" | "not_started" | "budget";
/** Compatibility event projection derived from the Tool Observation status. */
export type ToolExecutionOutcome = "success" | "error" | "aborted";
export type ToolExecutionSettlement = "returned" | "threw" | "aborted";

export type MessageDelta =
	| { readonly type: "text_start"; readonly contentIndex: number }
	| { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
	| { readonly type: "text_end"; readonly contentIndex: number; readonly content: string }
	| { readonly type: "thinking_start"; readonly contentIndex: number }
	| { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
	| { readonly type: "thinking_end"; readonly contentIndex: number; readonly content: string }
	| { readonly type: "toolcall_start"; readonly contentIndex: number }
	| { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "toolcall_end";
			readonly contentIndex: number;
			readonly toolCall: Immutable<ToolCall>;
	  };

interface RunStartPayload {
	readonly type: "run_start";
	readonly source: RunSource;
	readonly queueItemId?: QueueItemId;
	readonly inputMessage: AgentMessage<UserMessage>;
	readonly budget?: RunBudget;
}

interface TurnStartPayload {
	readonly type: "turn_start";
	readonly turnId: TurnId;
	readonly steeringMessages: readonly AgentMessage<UserMessage>[];
}

interface AttemptStartPayload {
	readonly type: "attempt_start";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly messageId: MessageId;
	readonly attempt: number;
}

interface MessageStartPayload {
	readonly type: "message_start";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly messageId: MessageId;
}

interface MessageUpdatePayload {
	readonly type: "message_update";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly messageId: MessageId;
	readonly delta: MessageDelta;
}

interface AttemptEndPayload {
	readonly type: "attempt_end";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly messageId: MessageId;
	readonly attempt: number;
	readonly outcome: "success" | "error" | "aborted";
	readonly discarded: boolean;
	readonly candidate: AgentMessage<AssistantMessage>;
}

interface RetryScheduledPayload {
	readonly type: "retry_scheduled";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly attempt: number;
	readonly delayMs: number;
	readonly reason: string;
}

interface MessageEndPayload {
	readonly type: "message_end";
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly message: AgentMessage<AssistantMessage>;
}

interface ToolExecutionRejectedPayload {
	readonly type: "tool_execution_rejected";
	readonly turnId: TurnId;
	readonly invocation: ToolInvocation;
	readonly reason: ToolRejectionReason;
	readonly message: string;
	readonly result: AgentMessage;
}

interface ToolExecutionStartPayload {
	readonly type: "tool_execution_start";
	readonly turnId: TurnId;
	readonly invocation: ToolInvocation;
}

interface ToolExecutionProgressPayload {
	readonly type: "tool_execution_progress";
	readonly turnId: TurnId;
	readonly invocation: ToolInvocation;
	readonly progress: ToolExecutionProgress;
}

interface ToolExecutionEndPayload {
	readonly type: "tool_execution_end";
	readonly turnId: TurnId;
	readonly invocation: ToolInvocation;
	readonly settlement: ToolExecutionSettlement;
	readonly outcome: ToolExecutionOutcome;
	readonly result: AgentMessage;
}

interface TurnEndPayload {
	readonly type: "turn_end";
	readonly turnId: TurnId;
	readonly outcome: RunOutcome;
}

interface RunBudgetExhaustedPayload {
	readonly type: "run_budget_exhausted";
	readonly exhaustion: RunBudgetExhaustion;
}

interface RunEndPayload {
	readonly type: "run_end";
	readonly outcome: RunOutcome;
	readonly failure?: RunFailure;
}

export type AgentEventPayload =
	| RunStartPayload
	| TurnStartPayload
	| AttemptStartPayload
	| MessageStartPayload
	| MessageUpdatePayload
	| AttemptEndPayload
	| RetryScheduledPayload
	| MessageEndPayload
	| ToolExecutionRejectedPayload
	| ToolExecutionStartPayload
	| ToolExecutionProgressPayload
	| ToolExecutionEndPayload
	| TurnEndPayload
	| RunBudgetExhaustedPayload
	| RunEndPayload;

export type AgentEvent = Immutable<
	AgentEventPayload & {
		readonly runId: RunId;
		readonly sequence: number;
		readonly timestamp: number;
	}
>;

export type AgentObservationEvent = Extract<
	AgentEvent,
	{ readonly type: "message_start" | "message_update" | "tool_execution_progress" }
>;

export type AgentSemanticEvent = Exclude<AgentEvent, AgentObservationEvent>;

export type AgentSemanticEventListener = (event: AgentSemanticEvent) => unknown;

export interface AgentObservationResynchronization {
	readonly reason: "slow_consumer";
	readonly runId: RunId;
	readonly sequence: number;
	readonly state: AgentState;
}

export interface AgentObservationObserver {
	accept(event: AgentObservationEvent): Promise<void> | void;
	resynchronize(snapshot: AgentObservationResynchronization): Promise<void> | void;
}

export interface AgentObservationOptions {
	readonly capacity?: number;
}

export type RetryDecision =
	| { readonly retry: false }
	| { readonly retry: true; readonly delayMs: number; readonly reason: string };

export interface TurnRetryContext {
	readonly runId: RunId;
	readonly turnId: TurnId;
	readonly attemptId: AttemptId;
	readonly attempt: number;
	readonly message: AgentMessage<AssistantMessage>;
	readonly transient: boolean;
}

export interface TurnRetryPolicy {
	decide(context: TurnRetryContext): RetryDecision | Promise<RetryDecision>;
}

export type FailedAttemptRecoveryDecision =
	| { readonly retry: false }
	| { readonly retry: true; readonly reason: string };

/** Application-owned recovery that must materially change the next Attempt's input. */
export type FailedAttemptRecovery = (
	context: TurnRetryContext,
) => FailedAttemptRecoveryDecision | Promise<FailedAttemptRecoveryDecision>;

export interface RetryDelay {
	wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface RetryOptions {
	readonly policy: TurnRetryPolicy;
	readonly delay: RetryDelay;
}

export interface RunPreparation {
	readonly runId: RunId;
	readonly source: RunSource;
	readonly inputMessage: AgentMessage<UserMessage>;
	readonly queueItemId?: QueueItemId;
	/** Cancels preparation and remains the Run signal after preparation settles. */
	readonly signal: AbortSignal;
	/** Absolute host-clock deadline derived from the configured Run budget, when bounded. */
	readonly deadline?: number;
}

/**
 * The complete immutable execution capability for one Run. The Agent calls
 * `prepareRun` exactly once and retains this snapshot until the Run settles.
 */
export interface PreparedRun {
	readonly stream: ModelStream;
	readonly tools: readonly AgentTool[];
	readonly systemPrompt?: string;
	readonly recoverFailedAttempt?: FailedAttemptRecovery;
	/** Optional per-Run budget frozen by dynamic preparation. */
	readonly runBudget?: RunBudget;
	readonly dispose?: () => Promise<void> | void;
}

export type PrepareRun = (preparation: RunPreparation) => PreparedRun | Promise<PreparedRun>;

/** Static convenience input for tests and consumers without per-Run state. */
export type StaticRunPreparation = Omit<PreparedRun, "dispose">;

export interface AgentOptions {
	readonly prepareRun: PrepareRun;
	readonly idGenerator: IdGenerator;
	readonly clock: Clock;
	readonly retry?: RetryOptions;
	readonly runBudget?: RunBudget;
	readonly seed?: AgentSeed;
	/** Disable automatic Follow-up draining so an application scheduler can interleave other local operations. */
	readonly autoDrainFollowUps?: boolean;
}

export interface RunResult {
	readonly runId: RunId;
	readonly outcome: RunOutcome;
	readonly failure?: RunFailure;
	readonly finalMessageId?: MessageId;
}
