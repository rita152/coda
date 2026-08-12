import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type ImageContent,
	type Message,
	resolveToolObservation,
	type TextContent,
	type ToolCall,
	type ToolObservation,
	type ToolResultMessage,
	type UserMessage,
	validateToolArguments,
} from "@coda/ai";
import { AgentError } from "./errors.ts";
import { isPersistenceSafeId } from "./identities.ts";
import { cloneFrozen, deepFreeze } from "./immutable.ts";
import { initialRuntimeState, type RuntimeState, reduceState } from "./reducer.ts";
import { RunBudgetMeter, runBudgetFailure, snapshotRunBudget } from "./run-budget.ts";
import { validateAgentSeed } from "./seed.ts";
import type {
	AgentEvent,
	AgentEventListener,
	AgentEventPayload,
	AgentInput,
	AgentMessage,
	AgentOptions,
	AgentState,
	AgentTool,
	AttemptId,
	IdKind,
	MessageDelta,
	MessageId,
	QueueItemId,
	RunBudgetExhaustion,
	RunFailure,
	RunId,
	RunOutcome,
	RunResult,
	RunSource,
	ToolExecutionOutcome,
	ToolExecutionOutput,
	ToolExecutionProgress,
	ToolExecutionSettlement,
	ToolInvocation,
	ToolInvocationId,
	ToolPolicyDecision,
	ToolRejectionReason,
	TurnId,
} from "./types.ts";

class ListenerFailureSignal extends Error {}

interface RunContext {
	readonly id: RunId;
	sequence: number;
	readonly controller: AbortController;
	readonly listenerFailures: unknown[];
	readonly budget?: RunBudgetMeter;
	tools: readonly AgentTool[];
	toolsByName: ReadonlyMap<string, AgentTool>;
	systemPrompt?: string;
}

interface AttemptResult {
	readonly attemptId: AttemptId;
	readonly outcome: "success" | "error" | "aborted";
	readonly message: AgentMessage<AssistantMessage>;
	readonly budgetExhaustion?: RunBudgetExhaustion;
}

interface BudgetResult {
	readonly outcome: "budget";
	readonly exhaustion: RunBudgetExhaustion;
}

interface AcceptedTool {
	readonly call: ToolCall;
	readonly tool: AgentTool;
	readonly arguments: Record<string, unknown>;
	readonly invocation: ToolInvocation;
}

interface ToolSettlement {
	readonly entry: AcceptedTool;
	readonly settlement: ToolExecutionSettlement;
	readonly outcome: ToolExecutionOutcome;
	readonly result: AgentMessage<ToolResultMessage>;
	readonly error?: unknown;
}

interface ToolBatchResult {
	readonly outcome: RunOutcome;
	readonly fatal?: unknown;
	readonly budgetExhaustion?: RunBudgetExhaustion;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolExecutionOutcome(status: ToolObservation["status"]): ToolExecutionOutcome {
	if (status === "ok") return "success";
	if (status === "aborted") return "aborted";
	return "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInput(input: AgentInput): void {
	if (typeof input === "string") {
		if (input.trim().length === 0) throw new AgentError("invalid_input", "Agent input must not be empty");
		return;
	}
	if (!Array.isArray(input) || input.length === 0) {
		throw new AgentError("invalid_input", "Agent input must contain at least one content block");
	}
	for (const block of input) {
		if (!isRecord(block) || (block.type !== "text" && block.type !== "image" && block.type !== "skill")) {
			throw new AgentError("invalid_input", "Agent input contains an invalid content block");
		}
		if (
			block.type === "skill" &&
			(typeof block.name !== "string" ||
				block.name.length === 0 ||
				typeof block.path !== "string" ||
				block.path.length === 0)
		) {
			throw new AgentError("invalid_input", "Skill input blocks require a name and path");
		}
		if (block.type === "text" && (typeof block.text !== "string" || block.text.length === 0)) {
			throw new AgentError("invalid_input", "Text input blocks must not be empty");
		}
		if (
			block.type === "image" &&
			(typeof block.data !== "string" || block.data.length === 0 || typeof block.mimeType !== "string")
		) {
			throw new AgentError("invalid_input", "Image input blocks require data and a MIME type");
		}
	}
}

function eventDelta(event: AssistantMessageEvent): MessageDelta | undefined {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return { type: event.type, contentIndex: event.contentIndex };
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
		case "thinking_end":
			return { type: event.type, contentIndex: event.contentIndex, content: event.content };
		case "toolcall_end":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				toolCall: cloneFrozen(event.toolCall),
			};
		default:
			return undefined;
	}
}

function normalizedToolContent(content: ToolExecutionOutput["content"]): readonly (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) throw new Error("Tool output content must be a string or content block array");
	return structuredClone(content) as (TextContent | ImageContent)[];
}

const RETRYABLE_TRANSPORT_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
]);

const RETRYABLE_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"]);

function isTransientAssistantFailure(message: AgentMessage<AssistantMessage>): boolean {
	const neverRetryCodes = new Set([
		"auth",
		"oauth",
		"quota",
		"billing",
		"validation",
		"invalid_request",
		"context_overflow",
		"context_length_exceeded",
	]);
	for (const diagnostic of message.message.diagnostics ?? []) {
		const code = diagnostic.error?.code;
		if (typeof code === "string" && neverRetryCodes.has(code.toLowerCase())) return false;
		const status = diagnostic.details?.status;
		if (status === 400 || status === 401 || status === 402 || status === 403 || status === 404 || status === 413) {
			return false;
		}
		if (diagnostic.details?.retryable !== true) continue;
		if (
			status === 408 ||
			status === 409 ||
			status === 429 ||
			(typeof status === "number" && status >= 500 && status <= 599)
		) {
			return true;
		}
		if (typeof code === "string" && RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase())) return true;
		if (diagnostic.error?.name && RETRYABLE_ERROR_NAMES.has(diagnostic.error.name)) return true;
	}
	return false;
}

function snapshotTools(input: readonly AgentTool[]): {
	readonly tools: readonly AgentTool[];
	readonly byName: ReadonlyMap<string, AgentTool>;
} {
	if (!Array.isArray(input)) throw new AgentError("invalid_input", "Agent Tools factory must return an array");
	const byName = new Map<string, AgentTool>();
	const tools: AgentTool[] = [];
	for (const tool of input) {
		if (byName.has(tool.name)) {
			throw new AgentError("invalid_input", `Tool names must be unique; received "${tool.name}" more than once`);
		}
		const snapshot = Object.freeze({ ...tool });
		byName.set(snapshot.name, snapshot);
		tools.push(snapshot);
	}
	return Object.freeze({ tools: Object.freeze(tools), byName });
}

export class Agent {
	readonly #options: AgentOptions;
	readonly #listeners: AgentEventListener[] = [];
	readonly #issuedIds = new Set<string>();
	readonly #consumedQueueItems = new Set<string>();
	#runtimeState: RuntimeState;
	#operation?: Promise<RunResult>;
	#activeRun?: RunContext;
	#followUpsPaused: boolean;

	constructor(options: AgentOptions) {
		if (
			options.systemPrompt !== undefined &&
			typeof options.systemPrompt !== "string" &&
			typeof options.systemPrompt !== "function"
		) {
			throw new AgentError("invalid_input", "systemPrompt must be a string or factory");
		}
		const tools = typeof options.tools === "function" ? options.tools : snapshotTools(options.tools).tools;
		this.#options = { ...options, tools, runBudget: snapshotRunBudget(options.runBudget) };
		const seed =
			options.seed === undefined ? { messages: [], pendingFollowUps: [] } : validateAgentSeed(options.seed);
		for (const message of seed.messages) this.#issuedIds.add(message.id);
		for (const followUp of seed.pendingFollowUps) this.#issuedIds.add(followUp.id);
		this.#runtimeState = initialRuntimeState(seed.messages, seed.pendingFollowUps);
		this.#followUpsPaused = seed.pendingFollowUps.length > 0;
	}

	get state(): AgentState {
		return this.#runtimeState.public;
	}

	onEvent(listener: AgentEventListener): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}

	prompt(input: AgentInput): Promise<RunResult> {
		validateInput(input);
		if (this.#operation) {
			return Promise.reject(new AgentError("busy", "Agent is running; use steer() or followUp() for queued input"));
		}
		if (this.#runtimeState.public.pendingFollowUps.length > 0) {
			return Promise.reject(
				new AgentError("invalid_lifecycle", "Pending Follow-ups must be resumed before starting a new Prompt"),
			);
		}
		this.#followUpsPaused = false;
		const runId = this.#allocate("run") as RunId;
		const inputMessage = this.#createUserMessage(input);
		let resolveOperation!: (result: RunResult) => void;
		let rejectOperation!: (error: unknown) => void;
		const operation = new Promise<RunResult>((resolve, reject) => {
			resolveOperation = resolve;
			rejectOperation = reject;
		});
		this.#operation = operation;
		void this.#drive(runId, inputMessage).then(
			(result) => {
				if (this.#operation === operation) this.#operation = undefined;
				resolveOperation(result);
			},
			(error) => {
				if (this.#operation === operation) this.#operation = undefined;
				rejectOperation(error);
			},
		);
		return operation;
	}

	async waitForIdle(): Promise<void> {
		await this.#operation;
	}

	abort(): void {
		if (!this.#activeRun || this.#runtimeState.public.status !== "running") {
			throw new AgentError("invalid_lifecycle", "Agent has no active Run to abort");
		}
		this.#runtimeState = reduceState(this.#runtimeState, { type: "clear_steering" });
		this.#followUpsPaused = true;
		this.#activeRun.controller.abort();
	}

	resumeFollowUps(): Promise<RunResult> {
		return this.#startFollowUpDrain(Number.POSITIVE_INFINITY);
	}

	runNextFollowUp(): Promise<RunResult> {
		return this.#startFollowUpDrain(1);
	}

	#startFollowUpDrain(limit: number): Promise<RunResult> {
		if (this.#operation) {
			return Promise.reject(new AgentError("busy", "Agent is already running"));
		}
		if (this.#runtimeState.public.pendingFollowUps.length === 0) {
			return Promise.reject(new AgentError("invalid_lifecycle", "Agent has no pending Follow-ups to resume"));
		}
		this.#followUpsPaused = false;
		let resolveOperation!: (result: RunResult) => void;
		let rejectOperation!: (error: unknown) => void;
		const operation = new Promise<RunResult>((resolve, reject) => {
			resolveOperation = resolve;
			rejectOperation = reject;
		});
		this.#operation = operation;
		void this.#drainFollowUps(limit).then(
			(result) => {
				if (this.#operation === operation) this.#operation = undefined;
				resolveOperation(result);
			},
			(error) => {
				if (this.#operation === operation) this.#operation = undefined;
				rejectOperation(error);
			},
		);
		return operation;
	}

	steer(input: AgentInput): QueueItemId {
		validateInput(input);
		if (!this.#activeRun || this.#runtimeState.public.status !== "running") {
			throw new AgentError("invalid_lifecycle", "Steering requires an active Run");
		}
		if (this.#activeRun.controller.signal.aborted) {
			throw new AgentError("invalid_lifecycle", "An aborted Run cannot accept Steering");
		}
		const id = this.#allocate("queue_item") as QueueItemId;
		this.#runtimeState = reduceState(this.#runtimeState, {
			type: "queue_steering",
			item: cloneFrozen({ id, content: structuredClone(input) }),
		});
		return id;
	}

	followUp(input: AgentInput): QueueItemId {
		validateInput(input);
		if (
			!this.#activeRun &&
			this.#runtimeState.public.pendingFollowUps.length === 0 &&
			this.#options.autoDrainFollowUps !== false
		) {
			throw new AgentError("invalid_lifecycle", "Follow-up requires an active or settling Run");
		}
		const id = this.#allocate("queue_item") as QueueItemId;
		this.#runtimeState = reduceState(this.#runtimeState, {
			type: "queue_follow_up",
			item: cloneFrozen({ id, content: structuredClone(input) }),
		});
		return id;
	}

	cancelQueueItem(id: QueueItemId): void {
		const pending =
			this.#runtimeState.public.pendingSteering.some((item) => item.id === id) ||
			this.#runtimeState.public.pendingFollowUps.some((item) => item.id === id);
		if (pending) {
			this.#runtimeState = reduceState(this.#runtimeState, { type: "remove_queue_item", id });
			return;
		}
		if (this.#consumedQueueItems.has(id)) {
			throw new AgentError("queue_item_not_cancellable", `Queue item "${id}" has already been consumed`);
		}
		throw new AgentError("queue_item_not_found", `Queue item "${id}" was not found`);
	}

	#createUserMessage(input: AgentInput): AgentMessage<UserMessage> {
		return cloneFrozen({
			id: this.#allocate("message") as MessageId,
			message: {
				role: "user",
				content: structuredClone(input),
				timestamp: this.#options.clock.now(),
			},
		});
	}

	#allocate(kind: IdKind): string {
		const value = this.#options.idGenerator.generate(kind);
		if (!isPersistenceSafeId(value) || this.#issuedIds.has(value)) {
			throw new AgentError("invalid_lifecycle", `IdGenerator returned an invalid or duplicate ${kind} ID`);
		}
		this.#issuedIds.add(value);
		return value;
	}

	async #drive(runId: RunId, inputMessage: AgentMessage<UserMessage>): Promise<RunResult> {
		const initialResult = await this.#run(runId, "prompt", inputMessage);
		if (initialResult.outcome !== "success") this.#followUpsPaused = true;
		if (
			this.#options.autoDrainFollowUps !== false &&
			!this.#followUpsPaused &&
			this.#runtimeState.public.pendingFollowUps.length > 0
		) {
			await this.#drainFollowUps();
		}
		return initialResult;
	}

	async #drainFollowUps(limit = Number.POSITIVE_INFINITY): Promise<RunResult> {
		let firstResult: RunResult | undefined;
		let consumed = 0;
		while (!this.#followUpsPaused && this.#runtimeState.public.pendingFollowUps.length > 0 && consumed < limit) {
			const followUp = this.#runtimeState.public.pendingFollowUps[0]!;
			const followUpRunId = this.#allocate("run") as RunId;
			const followUpMessage = this.#createUserMessage(followUp.content as AgentInput);
			this.#consumedQueueItems.add(followUp.id);
			this.#runtimeState = reduceState(this.#runtimeState, { type: "remove_queue_item", id: followUp.id });
			let result: RunResult;
			try {
				result = await this.#run(followUpRunId, "follow_up", followUpMessage, followUp.id);
			} catch (error) {
				if (!this.#runtimeState.public.messages.some(({ id }) => id === followUpMessage.id)) {
					this.#consumedQueueItems.delete(followUp.id);
					this.#runtimeState = reduceState(this.#runtimeState, { type: "restore_follow_up", item: followUp });
				}
				this.#followUpsPaused = true;
				throw error;
			}
			firstResult ??= result;
			consumed++;
			if (result.outcome === "aborted") {
				this.#followUpsPaused = true;
			} else if (result.outcome === "error") {
				this.#followUpsPaused = true;
			}
		}
		if (!firstResult) {
			throw new AgentError("invalid_lifecycle", "Agent has no pending Follow-ups to resume");
		}
		return firstResult;
	}

	async #run(
		runId: RunId,
		source: RunSource,
		inputMessage: AgentMessage<UserMessage>,
		queueItemId?: QueueItemId,
	): Promise<RunResult> {
		const run: RunContext = {
			id: runId,
			sequence: 0,
			controller: new AbortController(),
			listenerFailures: [],
			budget:
				this.#options.runBudget === undefined
					? undefined
					: new RunBudgetMeter(this.#options.runBudget, this.#options.clock.now()),
			tools: [],
			toolsByName: new Map(),
		};
		this.#activeRun = run;
		let outcome: RunOutcome = "error";
		let failure: RunFailure | undefined;
		let finalMessageId: MessageId | undefined;
		let activeTurnId: TurnId | undefined;
		let turnEnded = true;
		let unexpected: unknown;

		try {
			await this.#options.beforeRun?.(
				deepFreeze({
					runId,
					source,
					inputMessage,
					...(queueItemId === undefined ? {} : { queueItemId }),
				}),
			);
			const runTools = snapshotTools(
				typeof this.#options.tools === "function" ? this.#options.tools() : this.#options.tools,
			);
			run.tools = runTools.tools;
			run.toolsByName = runTools.byName;
			const systemPrompt =
				typeof this.#options.systemPrompt === "function"
					? this.#options.systemPrompt()
					: this.#options.systemPrompt;
			if (systemPrompt !== undefined && typeof systemPrompt !== "string") {
				throw new AgentError("invalid_input", "System Prompt factory must return a string");
			}
			run.systemPrompt = systemPrompt;
			await this.#emit(run, {
				type: "run_start",
				source,
				inputMessage,
				queueItemId,
				...(run.budget ? { budget: run.budget.budget } : {}),
			});
			while (true) {
				if (run.controller.signal.aborted) {
					outcome = "aborted";
					break;
				}
				const turnBudgetExhaustion = run.budget?.beginTurn(this.#options.clock.now());
				if (turnBudgetExhaustion) {
					outcome = "error";
					failure = await this.#recordBudgetExhaustion(run, turnBudgetExhaustion);
					break;
				}
				activeTurnId = this.#allocate("turn") as TurnId;
				turnEnded = false;
				const steeringMessages = this.#consumeSteering();
				await this.#emit(run, { type: "turn_start", turnId: activeTurnId, steeringMessages });
				if (run.controller.signal.aborted) {
					outcome = "aborted";
					await this.#emit(run, { type: "turn_end", turnId: activeTurnId, outcome });
					turnEnded = true;
					break;
				}

				const attempt = await this.#streamTurn(run, activeTurnId);
				if (attempt.outcome === "budget") {
					outcome = "error";
					failure = await this.#recordBudgetExhaustion(run, attempt.exhaustion);
					await this.#emit(run, { type: "turn_end", turnId: activeTurnId, outcome });
					turnEnded = true;
					break;
				}
				outcome = attempt.outcome;
				if (run.controller.signal.aborted) {
					outcome = "aborted";
					await this.#emit(run, { type: "turn_end", turnId: activeTurnId, outcome });
					turnEnded = true;
					break;
				}
				if (attempt.outcome !== "success") {
					if (attempt.budgetExhaustion) {
						outcome = "error";
						failure = await this.#recordBudgetExhaustion(run, attempt.budgetExhaustion);
					} else if (attempt.outcome === "error") {
						failure = { kind: "model", message: attempt.message.message.errorMessage ?? "Model call failed" };
					}
					await this.#emit(run, { type: "turn_end", turnId: activeTurnId, outcome });
					turnEnded = true;
					break;
				}

				finalMessageId = attempt.message.id;
				await this.#emit(run, {
					type: "message_end",
					turnId: activeTurnId,
					attemptId: attempt.attemptId,
					message: attempt.message,
				});
				const toolCalls = attempt.message.message.content.filter(
					(block): block is ToolCall => block.type === "toolCall",
				);
				if (attempt.budgetExhaustion && !run.controller.signal.aborted) {
					if (toolCalls.length > 0) {
						await this.#rejectBudgetToolCalls(run, activeTurnId, toolCalls, attempt.budgetExhaustion);
					}
					if (run.controller.signal.aborted) {
						outcome = "aborted";
					} else {
						outcome = "error";
						failure = await this.#recordBudgetExhaustion(run, attempt.budgetExhaustion);
					}
				} else if (toolCalls.length > 0) {
					const batch = await this.#executeToolBatch(
						run,
						activeTurnId,
						toolCalls,
						attempt.message.message.stopReason === "length",
					);
					outcome = batch.outcome;
					if (batch.budgetExhaustion !== undefined) {
						failure = await this.#recordBudgetExhaustion(run, batch.budgetExhaustion);
					} else if (batch.fatal !== undefined) {
						unexpected = batch.fatal;
						failure = { kind: "tool", message: errorMessage(batch.fatal) };
					}
				} else {
					run.budget?.completeWithoutToolBatch();
					outcome = run.controller.signal.aborted ? "aborted" : "success";
				}

				await this.#emit(run, { type: "turn_end", turnId: activeTurnId, outcome });
				turnEnded = true;
				activeTurnId = undefined;
				if (run.controller.signal.aborted) outcome = "aborted";
				if (
					outcome !== "success" ||
					(toolCalls.length === 0 && this.#runtimeState.public.pendingSteering.length === 0)
				) {
					break;
				}
			}
		} catch (error) {
			if (error instanceof ListenerFailureSignal) {
				run.controller.abort();
				failure = { kind: "listener", message: "An Agent event listener failed" };
			} else if (run.controller.signal.aborted) {
				failure = undefined;
			} else {
				unexpected = error;
				failure = { kind: "runtime", message: errorMessage(error) };
			}
			outcome = run.controller.signal.aborted && !(error instanceof ListenerFailureSignal) ? "aborted" : "error";
		} finally {
			if (run.sequence > 0) {
				if (activeTurnId && !turnEnded) {
					await this.#emitCleanup(run, { type: "turn_end", turnId: activeTurnId, outcome });
				}
				await this.#emitCleanup(run, { type: "run_end", outcome, failure });
				this.#runtimeState = reduceState(this.#runtimeState, { type: "settled" });
			}
			this.#activeRun = undefined;
		}

		if (run.listenerFailures.length > 0) {
			throw new AgentError("listener_failed", "An Agent event listener failed", {
				cause: run.listenerFailures[0],
			});
		}
		if (unexpected !== undefined) throw unexpected;
		return deepFreeze({ runId, outcome, failure, finalMessageId });
	}

	async #recordBudgetExhaustion(run: RunContext, exhaustion: RunBudgetExhaustion): Promise<RunFailure> {
		this.#runtimeState = reduceState(this.#runtimeState, { type: "clear_steering" });
		await this.#emit(run, { type: "run_budget_exhausted", exhaustion });
		this.#runtimeState = reduceState(this.#runtimeState, { type: "clear_steering" });
		return runBudgetFailure(exhaustion);
	}

	#consumeSteering(): AgentMessage<UserMessage>[] {
		const queued = [...this.#runtimeState.public.pendingSteering];
		const messages = queued.map((item) => this.#createUserMessage(item.content as AgentInput));
		for (const item of queued) {
			this.#consumedQueueItems.add(item.id);
			this.#runtimeState = reduceState(this.#runtimeState, { type: "remove_queue_item", id: item.id });
		}
		return messages;
	}

	async #streamTurn(run: RunContext, turnId: TurnId): Promise<AttemptResult | BudgetResult> {
		let attempt = 1;
		let recoveryUsed = false;
		while (true) {
			const attemptBudgetExhaustion = run.budget?.beginModelAttempt(this.#options.clock.now());
			if (attemptBudgetExhaustion) return { outcome: "budget", exhaustion: attemptBudgetExhaustion };
			const result = await this.#streamAttempt(run, turnId, attempt);
			if (result.budgetExhaustion) return result;
			if (result.outcome !== "error") return result;
			const transient = isTransientAssistantFailure(result.message);
			if (!recoveryUsed && this.#options.recoverFailedAttempt) {
				const recovery = await this.#options.recoverFailedAttempt(
					deepFreeze({
						runId: run.id,
						turnId,
						attemptId: result.attemptId,
						attempt,
						message: result.message,
						transient,
					}),
				);
				if (recovery.retry) {
					recoveryUsed = true;
					if (recovery.reason.length === 0) {
						throw new Error("FailedAttemptRecovery returned an empty retry reason");
					}
					if (run.controller.signal.aborted) return { ...result, outcome: "aborted" };
					const exhaustion = run.budget?.checkModelAttempt(this.#options.clock.now());
					if (exhaustion) return { outcome: "budget", exhaustion };
					await this.#emit(run, {
						type: "retry_scheduled",
						turnId,
						attemptId: result.attemptId,
						attempt,
						delayMs: 0,
						reason: recovery.reason,
					});
					attempt++;
					continue;
				}
			}
			if (!this.#options.retry || !transient) return result;
			const decision = await this.#options.retry.policy.decide(
				deepFreeze({
					runId: run.id,
					turnId,
					attemptId: result.attemptId,
					attempt,
					message: result.message,
					transient: true,
				}),
			);
			if (!decision.retry) return result;
			if (!Number.isFinite(decision.delayMs) || decision.delayMs < 0 || decision.reason.length === 0) {
				throw new Error("TurnRetryPolicy returned an invalid retry schedule");
			}
			if (run.controller.signal.aborted) return { ...result, outcome: "aborted" };
			const exhaustion = run.budget?.checkModelAttempt(this.#options.clock.now());
			if (exhaustion) return { outcome: "budget", exhaustion };
			await this.#emit(run, {
				type: "retry_scheduled",
				turnId,
				attemptId: result.attemptId,
				attempt,
				delayMs: decision.delayMs,
				reason: decision.reason,
			});
			try {
				await this.#options.retry.delay.wait(decision.delayMs, run.controller.signal);
			} catch (error) {
				if (run.controller.signal.aborted) return { ...result, outcome: "aborted" };
				throw error;
			}
			if (run.controller.signal.aborted) return { ...result, outcome: "aborted" };
			attempt++;
		}
	}

	async #streamAttempt(run: RunContext, turnId: TurnId, attempt: number): Promise<AttemptResult> {
		const attemptId = this.#allocate("attempt") as AttemptId;
		const messageId = this.#allocate("message") as MessageId;
		await this.#emit(run, { type: "attempt_start", turnId, attemptId, messageId, attempt });

		const context: Context = {
			systemPrompt: run.systemPrompt,
			messages: this.#runtimeState.public.messages.map(({ message }) => structuredClone(message) as Message),
			tools: run.tools.map(({ name, description, parameters, constrainedSampling }) => ({
				name,
				description,
				parameters,
				constrainedSampling,
			})),
		};
		const stream = await this.#options.stream({
			context,
			signal: run.controller.signal,
			runId: run.id,
			turnId,
			attemptId,
		});
		let terminal: AssistantMessageEvent | undefined;
		for await (const event of stream) {
			if (event.type === "start") {
				await this.#emit(run, { type: "message_start", turnId, attemptId, messageId });
				continue;
			}
			const delta = eventDelta(event);
			if (delta) {
				await this.#emit(run, { type: "message_update", turnId, attemptId, messageId, delta });
				continue;
			}
			terminal = event;
		}
		if (!terminal || (terminal.type !== "done" && terminal.type !== "error")) {
			throw new Error("Model stream ended without a terminal event");
		}
		const message = cloneFrozen({
			id: messageId,
			message: terminal.type === "done" ? terminal.message : terminal.error,
		});
		const outcome = terminal.type === "done" ? "success" : terminal.reason;
		await this.#emit(run, {
			type: "attempt_end",
			turnId,
			attemptId,
			messageId,
			attempt,
			outcome,
			discarded: outcome !== "success",
			candidate: message,
		});
		const budgetExhaustion = run.budget?.completeModelAttempt(message.message.usage, this.#options.clock.now());
		return {
			attemptId,
			outcome,
			message,
			...(budgetExhaustion && outcome !== "aborted" && !run.controller.signal.aborted ? { budgetExhaustion } : {}),
		};
	}

	async #executeToolBatch(
		run: RunContext,
		turnId: TurnId,
		toolCalls: readonly ToolCall[],
		truncated: boolean,
	): Promise<ToolBatchResult> {
		if (!run.controller.signal.aborted) {
			const exhaustion = run.budget?.beginToolBatch(toolCalls, this.#options.clock.now());
			if (exhaustion) {
				await this.#rejectBudgetToolCalls(run, turnId, toolCalls, exhaustion);
				return run.controller.signal.aborted
					? { outcome: "aborted" }
					: { outcome: "error", budgetExhaustion: exhaustion };
			}
		}
		const result = await this.#executeToolBatchWithinBudget(run, turnId, toolCalls, truncated);
		if (result.outcome !== "success" || run.controller.signal.aborted) return result;
		const exhaustion = run.budget?.completeToolBatch(this.#options.clock.now());
		return exhaustion ? { outcome: "error", budgetExhaustion: exhaustion } : result;
	}

	async #executeToolBatchWithinBudget(
		run: RunContext,
		turnId: TurnId,
		toolCalls: readonly ToolCall[],
		truncated: boolean,
	): Promise<ToolBatchResult> {
		if (truncated) {
			await this.#rejectTruncatedToolCalls(run, turnId, toolCalls);
			return { outcome: run.controller.signal.aborted ? "aborted" : "success" };
		}
		const accepted = await this.#preflightTools(run, turnId, toolCalls);
		let cursor = 0;
		while (cursor < accepted.length) {
			const first = accepted[cursor]!;
			if (run.controller.signal.aborted) {
				await this.#rejectUnstarted(run, turnId, accepted.slice(cursor), "aborted");
				return { outcome: "aborted" };
			}
			const batch = [first];
			if (first.tool.parallelSafe) {
				let next = cursor + 1;
				while (
					next < accepted.length &&
					accepted[next]!.tool.parallelSafe &&
					accepted[next]!.invocation.sourceIndex === accepted[next - 1]!.invocation.sourceIndex + 1
				) {
					batch.push(accepted[next]!);
					next++;
				}
			}

			let batchResult: ToolBatchResult;
			try {
				batchResult =
					batch.length === 1
						? await this.#executeSingleTool(run, turnId, batch[0]!)
						: await this.#executeParallelTools(run, turnId, batch);
			} catch (error) {
				run.controller.abort();
				await this.#rejectUnstarted(run, turnId, accepted.slice(cursor + batch.length), "aborted", true);
				throw error;
			}
			cursor += batch.length;
			if (batchResult.fatal !== undefined) {
				await this.#rejectUnstarted(run, turnId, accepted.slice(cursor), "not_started");
				return { outcome: "error", fatal: batchResult.fatal };
			}
			if (batchResult.outcome === "aborted" || run.controller.signal.aborted) {
				await this.#rejectUnstarted(run, turnId, accepted.slice(cursor), "aborted");
				return { outcome: "aborted" };
			}
		}
		return { outcome: run.controller.signal.aborted ? "aborted" : "success" };
	}

	async #rejectBudgetToolCalls(
		run: RunContext,
		turnId: TurnId,
		toolCalls: readonly ToolCall[],
		exhaustion: RunBudgetExhaustion,
	): Promise<void> {
		for (let sourceIndex = 0; sourceIndex < toolCalls.length; sourceIndex++) {
			const call = toolCalls[sourceIndex]!;
			const invocation = this.#invocation(
				call,
				sourceIndex,
				this.#allocate("tool_invocation") as ToolInvocationId,
				this.#allocate("message") as MessageId,
				run.toolsByName.get(call.name),
			);
			await this.#rejectDuringPreflight(
				run,
				turnId,
				invocation,
				"budget",
				`Tool "${call.name}" was not started because ${runBudgetFailure(exhaustion).message}`,
				[],
				toolCalls,
				sourceIndex + 1,
			);
		}
	}

	async #rejectTruncatedToolCalls(run: RunContext, turnId: TurnId, toolCalls: readonly ToolCall[]): Promise<void> {
		for (let sourceIndex = 0; sourceIndex < toolCalls.length; sourceIndex++) {
			const call = toolCalls[sourceIndex]!;
			const invocation = this.#invocation(
				call,
				sourceIndex,
				this.#allocate("tool_invocation") as ToolInvocationId,
				this.#allocate("message") as MessageId,
				run.toolsByName.get(call.name),
			);
			await this.#rejectDuringPreflight(
				run,
				turnId,
				invocation,
				"invalid",
				`Tool "${call.name}" was not executed because the assistant response was truncated`,
				[],
				toolCalls,
				sourceIndex + 1,
			);
		}
	}

	async #preflightTools(run: RunContext, turnId: TurnId, toolCalls: readonly ToolCall[]): Promise<AcceptedTool[]> {
		const accepted: AcceptedTool[] = [];
		for (let sourceIndex = 0; sourceIndex < toolCalls.length; sourceIndex++) {
			const call = toolCalls[sourceIndex]!;
			const invocationId = this.#allocate("tool_invocation") as ToolInvocationId;
			const resultMessageId = this.#allocate("message") as MessageId;
			const tool = run.toolsByName.get(call.name);
			if (!tool) {
				const invocation = this.#invocation(call, sourceIndex, invocationId, resultMessageId);
				await this.#rejectDuringPreflight(
					run,
					turnId,
					invocation,
					"missing",
					`Tool "${call.name}" is not available`,
					accepted,
					toolCalls,
					sourceIndex + 1,
				);
				continue;
			}

			let arguments_: Record<string, unknown>;
			try {
				arguments_ = validateToolArguments(tool, call) as Record<string, unknown>;
			} catch (error) {
				const invocation = this.#invocation(call, sourceIndex, invocationId, resultMessageId, tool);
				await this.#rejectDuringPreflight(
					run,
					turnId,
					invocation,
					"invalid",
					errorMessage(error),
					accepted,
					toolCalls,
					sourceIndex + 1,
				);
				continue;
			}
			const invocation = this.#invocation(
				{ ...call, arguments: arguments_ },
				sourceIndex,
				invocationId,
				resultMessageId,
				tool,
			);
			if (run.controller.signal.aborted) {
				await this.#rejectDuringPreflight(
					run,
					turnId,
					invocation,
					"aborted",
					`Tool "${call.name}" was not started`,
					accepted,
					toolCalls,
					sourceIndex + 1,
				);
				continue;
			}
			let decision: ToolPolicyDecision | undefined;
			try {
				decision = await this.#options.policyGate.check({
					runId: run.id,
					turnId,
					invocationId,
					resultMessageId,
					providerToolCallId: call.id,
					toolName: call.name,
					arguments: invocation.arguments,
					replaySafety: tool.replaySafety,
				});
				if (decision.decision !== "allow" && decision.decision !== "reject") {
					throw new Error("PolicyGate returned an invalid decision");
				}
			} catch (error) {
				await this.#finishPreflightFailure(run, turnId, accepted, toolCalls, sourceIndex + 1, error, invocation);
			}
			if (decision === undefined) throw new Error("PolicyGate did not produce a decision");
			if (run.controller.signal.aborted) {
				await this.#rejectDuringPreflight(
					run,
					turnId,
					invocation,
					"aborted",
					`Tool "${call.name}" was not started`,
					accepted,
					toolCalls,
					sourceIndex + 1,
				);
				continue;
			}
			if (decision.decision === "reject") {
				await this.#rejectDuringPreflight(
					run,
					turnId,
					invocation,
					"policy",
					decision.reason,
					accepted,
					toolCalls,
					sourceIndex + 1,
				);
				continue;
			}
			accepted.push({ call, tool, arguments: arguments_, invocation });
		}
		return accepted;
	}

	async #rejectDuringPreflight(
		run: RunContext,
		turnId: TurnId,
		invocation: ToolInvocation,
		reason: ToolRejectionReason,
		message: string,
		accepted: readonly AcceptedTool[],
		toolCalls: readonly ToolCall[],
		futureStartIndex: number,
	): Promise<void> {
		try {
			await this.#rejectTool(run, turnId, invocation, reason, message);
		} catch (error) {
			await this.#finishPreflightFailure(run, turnId, accepted, toolCalls, futureStartIndex, error);
		}
	}

	async #finishPreflightFailure(
		run: RunContext,
		turnId: TurnId,
		accepted: readonly AcceptedTool[],
		toolCalls: readonly ToolCall[],
		futureStartIndex: number,
		error: unknown,
		current?: ToolInvocation,
	): Promise<never> {
		run.controller.abort();
		await this.#rejectUnstarted(run, turnId, accepted, "aborted", true);
		if (current) {
			await this.#rejectTool(
				run,
				turnId,
				current,
				"not_started",
				`Tool "${current.toolName}" was not started after policy preflight failed`,
				true,
			);
		}
		for (let sourceIndex = futureStartIndex; sourceIndex < toolCalls.length; sourceIndex++) {
			const call = toolCalls[sourceIndex]!;
			const tool = run.toolsByName.get(call.name);
			const invocation = this.#invocation(
				call,
				sourceIndex,
				this.#allocate("tool_invocation") as ToolInvocationId,
				this.#allocate("message") as MessageId,
				tool,
			);
			await this.#rejectTool(
				run,
				turnId,
				invocation,
				"not_started",
				`Tool "${call.name}" was not started after preflight failed`,
				true,
			);
		}
		throw error;
	}

	#invocation(
		call: ToolCall,
		sourceIndex: number,
		id: ToolInvocationId,
		resultMessageId: MessageId,
		tool?: AgentTool,
	): ToolInvocation {
		return cloneFrozen({
			id,
			resultMessageId,
			providerToolCallId: call.id,
			toolName: call.name,
			arguments: structuredClone(call.arguments),
			sourceIndex,
			replaySafety: tool?.replaySafety,
		});
	}

	async #rejectUnstarted(
		run: RunContext,
		turnId: TurnId,
		entries: readonly AcceptedTool[],
		reason: Extract<ToolRejectionReason, "aborted" | "not_started">,
		cleanup = false,
	): Promise<void> {
		for (const entry of entries) {
			await this.#rejectTool(
				run,
				turnId,
				entry.invocation,
				reason,
				reason === "aborted"
					? `Tool "${entry.call.name}" was not started because the Run was aborted`
					: `Tool "${entry.call.name}" was not started after another Tool failed`,
				cleanup,
			);
		}
	}

	async #rejectTool(
		run: RunContext,
		turnId: TurnId,
		invocation: ToolInvocation,
		reason: ToolRejectionReason,
		message: string,
		cleanup = false,
	): Promise<void> {
		const result = this.#toolResult(invocation, {
			content: message,
			observation: {
				status:
					reason === "policy" ? "denied" : reason === "aborted" || reason === "not_started" ? "aborted" : "error",
				truncated: false,
				facts: { reason },
			},
			details: { status: "rejected", reason },
			isError: true,
		});
		const payload = {
			type: "tool_execution_rejected",
			turnId,
			invocation,
			reason,
			message,
			result,
		} as const;
		if (cleanup) await this.#emitCleanup(run, payload);
		else await this.#emit(run, payload);
	}

	async #executeSingleTool(run: RunContext, turnId: TurnId, entry: AcceptedTool): Promise<ToolBatchResult> {
		try {
			await this.#emit(run, { type: "tool_execution_start", turnId, invocation: entry.invocation });
		} catch (error) {
			run.controller.abort();
			const settlement = this.#abortedSettlement(entry);
			await this.#emitCleanup(run, {
				type: "tool_execution_end",
				turnId,
				invocation: entry.invocation,
				settlement: settlement.settlement,
				outcome: settlement.outcome,
				result: settlement.result,
			});
			throw error;
		}
		const settlement = run.controller.signal.aborted
			? this.#abortedSettlement(entry)
			: await this.#settleTool(run, turnId, entry);
		await this.#emit(run, {
			type: "tool_execution_end",
			turnId,
			invocation: entry.invocation,
			settlement: settlement.settlement,
			outcome: settlement.outcome,
			result: settlement.result,
		});
		return settlement.error === undefined
			? { outcome: settlement.outcome === "aborted" ? "aborted" : "success" }
			: { outcome: "error", fatal: settlement.error };
	}

	async #executeParallelTools(
		run: RunContext,
		turnId: TurnId,
		entries: readonly AcceptedTool[],
	): Promise<ToolBatchResult> {
		const completed: ToolSettlement[] = [];
		let wake: (() => void) | undefined;
		let launched = 0;
		let dispatchFailure: unknown;
		for (const [index, entry] of entries.entries()) {
			if (run.controller.signal.aborted) break;
			try {
				await this.#emit(run, { type: "tool_execution_start", turnId, invocation: entry.invocation });
			} catch (error) {
				dispatchFailure = error;
				run.controller.abort();
				launched++;
				completed.push(this.#abortedSettlement(entry));
				await this.#rejectUnstarted(run, turnId, entries.slice(index + 1), "aborted", true);
				break;
			}
			launched++;
			const settlement = run.controller.signal.aborted
				? Promise.resolve(this.#abortedSettlement(entry))
				: this.#settleTool(run, turnId, entry);
			void settlement.then((value) => {
				completed.push(value);
				wake?.();
				wake = undefined;
			});
		}
		if (dispatchFailure === undefined && launched < entries.length) {
			await this.#rejectUnstarted(run, turnId, entries.slice(launched), "aborted");
		}

		let settled = 0;
		let fatal: unknown;
		while (settled < launched) {
			if (completed.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
			const next = completed.shift();
			if (!next) continue;
			settled++;
			const payload = {
				type: "tool_execution_end",
				turnId,
				invocation: next.entry.invocation,
				settlement: next.settlement,
				outcome: next.outcome,
				result: next.result,
			} as const;
			if (dispatchFailure !== undefined) {
				await this.#emitCleanup(run, payload);
			} else {
				try {
					await this.#emit(run, payload);
				} catch (error) {
					dispatchFailure = error;
					run.controller.abort();
				}
			}
			fatal ??= next.error;
		}
		if (dispatchFailure !== undefined) throw dispatchFailure;
		if (fatal !== undefined) return { outcome: "error", fatal };
		return { outcome: run.controller.signal.aborted ? "aborted" : "success" };
	}

	async #settleTool(run: RunContext, turnId: TurnId, entry: AcceptedTool): Promise<ToolSettlement> {
		let acceptsProgress = true;
		let progressFailure: unknown;
		let progressQueue = Promise.resolve();
		const reportProgress = (progress: ToolExecutionProgress): void => {
			if (!acceptsProgress || run.controller.signal.aborted) return;
			const snapshot = cloneFrozen(progress);
			progressQueue = progressQueue.then(async () => {
				if (run.controller.signal.aborted) return;
				try {
					await this.#emit(run, {
						type: "tool_execution_progress",
						turnId,
						invocation: entry.invocation,
						progress: snapshot,
					});
				} catch (error) {
					progressFailure ??= error;
					run.controller.abort();
				}
			});
		};
		try {
			const output = await entry.tool.execute(entry.arguments, {
				signal: run.controller.signal,
				runId: run.id,
				turnId,
				invocationId: entry.invocation.id,
				resultMessageId: entry.invocation.resultMessageId,
				providerToolCallId: entry.invocation.providerToolCallId,
				reportProgress,
			});
			acceptsProgress = false;
			await progressQueue;
			if (progressFailure !== undefined) throw progressFailure;
			if (run.controller.signal.aborted) return this.#abortedSettlement(entry);
			const result = this.#toolResult(entry.invocation, output);
			return {
				entry,
				settlement: "returned",
				outcome: toolExecutionOutcome(resolveToolObservation(result.message).status),
				result,
			};
		} catch (error) {
			acceptsProgress = false;
			await progressQueue;
			if (run.controller.signal.aborted) return this.#abortedSettlement(entry);
			return {
				entry,
				settlement: "threw",
				outcome: "error",
				error,
				result: this.#toolResult(entry.invocation, {
					content: `Tool "${entry.call.name}" failed: ${errorMessage(error)}`,
					observation: { status: "error", truncated: false },
					details: { status: "failed", error: { message: errorMessage(error) } },
					isError: true,
				}),
			};
		}
	}

	#abortedSettlement(entry: AcceptedTool): ToolSettlement {
		return {
			entry,
			settlement: "aborted",
			outcome: "aborted",
			result: this.#toolResult(entry.invocation, {
				content: `Tool "${entry.call.name}" was aborted`,
				observation: { status: "aborted", truncated: false },
				details: { status: "aborted" },
				isError: true,
			}),
		};
	}

	#toolResult(invocation: ToolInvocation, output: ToolExecutionOutput): AgentMessage<ToolResultMessage> {
		const observation = resolveToolObservation(output);
		return cloneFrozen({
			id: invocation.resultMessageId,
			message: {
				role: "toolResult",
				toolCallId: invocation.providerToolCallId,
				toolName: invocation.toolName,
				content: normalizedToolContent(output.content),
				observation,
				details: structuredClone(output.details),
				isError: observation.status !== "ok",
				timestamp: this.#options.clock.now(),
			},
		});
	}

	async #emit(run: RunContext, payload: AgentEventPayload): Promise<void> {
		await this.#dispatch(run, payload);
		if (run.listenerFailures.length > 0) throw new ListenerFailureSignal();
	}

	async #emitCleanup(run: RunContext, payload: AgentEventPayload): Promise<void> {
		try {
			await this.#dispatch(run, payload);
		} catch (error) {
			run.listenerFailures.push(error);
		}
	}

	async #dispatch(run: RunContext, payload: AgentEventPayload): Promise<void> {
		const event = deepFreeze({
			...payload,
			runId: run.id,
			sequence: ++run.sequence,
			timestamp: this.#options.clock.now(),
		}) as AgentEvent;
		this.#runtimeState = reduceState(this.#runtimeState, { type: "event", event });
		for (const listener of [...this.#listeners]) {
			try {
				await listener(event);
			} catch (error) {
				run.listenerFailures.push(error);
			}
		}
	}
}
