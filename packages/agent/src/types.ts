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

export type IdKind = "run" | "turn" | "attempt" | "message" | "tool_invocation" | "queue_item";

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

export interface RunFailure {
	readonly kind: "model" | "tool" | "runtime" | "listener";
	readonly message: string;
}

export interface ActiveRun {
	readonly id: RunId;
	readonly source: RunSource;
	readonly queueItemId?: QueueItemId;
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

export interface ToolPolicyRequest {
	readonly runId: RunId;
	readonly turnId: TurnId;
	readonly invocationId: ToolInvocationId;
	readonly resultMessageId: MessageId;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly arguments: Immutable<Record<string, unknown>>;
	readonly replaySafety: ToolReplaySafety;
}

export type ToolPolicyDecision =
	| { readonly decision: "allow" }
	| { readonly decision: "reject"; readonly reason: string };

export interface PolicyGate {
	check(request: ToolPolicyRequest): ToolPolicyDecision | Promise<ToolPolicyDecision>;
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

export type ToolRejectionReason = "missing" | "invalid" | "policy" | "aborted" | "not_started";
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
	| RunEndPayload;

export type AgentEvent = Immutable<
	AgentEventPayload & {
		readonly runId: RunId;
		readonly sequence: number;
		readonly timestamp: number;
	}
>;

export type AgentEventListener = (event: AgentEvent) => unknown;

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

export type SystemPromptFactory = () => string;

export interface RunPreparation {
	readonly runId: RunId;
	readonly source: RunSource;
	readonly inputMessage: AgentMessage<UserMessage>;
	readonly queueItemId?: QueueItemId;
}

/** Freezes application-owned state before the Run snapshot is created. */
export type BeforeRun = (preparation: RunPreparation) => Promise<void> | void;

/** Produces the immutable Tool set for one Run after `beforeRun` has completed. */
export type AgentToolsFactory = () => readonly AgentTool[];

export interface AgentOptions {
	readonly stream: ModelStream;
	readonly tools: readonly AgentTool[] | AgentToolsFactory;
	readonly policyGate: PolicyGate;
	readonly idGenerator: IdGenerator;
	readonly clock: Clock;
	readonly systemPrompt?: string | SystemPromptFactory;
	readonly beforeRun?: BeforeRun;
	readonly retry?: RetryOptions;
	readonly recoverFailedAttempt?: FailedAttemptRecovery;
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
