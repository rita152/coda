import type { AssistantMessage, ToolCall } from "@coda/ai";
import { cloneFrozen } from "./immutable.ts";
import type {
	AgentEvent,
	AgentMessage,
	Immutable,
	RunBudgetExhaustion,
	RunFailure,
	RunOutcome,
	ToolExecutionOutcome,
	ToolExecutionSettlement,
	ToolInvocation,
} from "./types.ts";

export interface AgentAttemptTrace {
	readonly id: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly outcome: "success" | "error" | "aborted";
	readonly discarded: boolean;
	readonly candidate: AgentMessage<AssistantMessage>;
}

export interface AgentToolTrace {
	readonly invocation: ToolInvocation;
	readonly startedSequence?: number;
	readonly startedAt?: number;
	readonly completedSequence?: number;
	readonly completedAt?: number;
	readonly settlement?: ToolExecutionSettlement;
	readonly outcome?: ToolExecutionOutcome | "rejected";
	readonly rejectionReason?: string;
	readonly result?: AgentMessage;
}

export interface AgentRunTrace {
	readonly runId: string;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly completedSequence?: number;
	readonly outcome?: RunOutcome;
	readonly failure?: RunFailure;
	readonly turnCount: number;
	readonly retryCount: number;
	readonly attempts: readonly AgentAttemptTrace[];
	readonly tools: readonly AgentToolTrace[];
	readonly toolBatches: readonly (readonly ToolCall[])[];
	readonly finalText: string;
	readonly budgetExhaustions: readonly RunBudgetExhaustion[];
}

export interface AgentEventUsageSummary {
	readonly inputTokens: number;
	readonly inputObservedAttempts: number;
	readonly cacheReadTokens: number;
	readonly cacheReadObservedAttempts: number;
	readonly cacheWriteTokens: number;
	readonly outputTokens: number;
	readonly outputObservedAttempts: number;
	readonly knownCostUsd: number;
	readonly pricedAttempts: number;
	readonly unpricedAttempts: number;
	readonly attemptCount: number;
}

export interface AgentEventSummary {
	readonly turnCount: number;
	readonly runStartedAt?: number;
	readonly latestEventAt?: number;
	readonly usage: AgentEventUsageSummary;
	readonly lengthTruncationCount: number;
	readonly budgetExhaustionLimits: readonly string[];
	readonly toolRejectionCount: number;
	readonly invalidToolCallCount: number;
}

interface MutableRunTrace {
	runId: string;
	startedAt: number;
	completedAt?: number;
	completedSequence?: number;
	outcome?: RunOutcome;
	failure?: RunFailure;
	turnCount: number;
	retryCount: number;
	attempts: AgentAttemptTrace[];
	tools: Map<string, AgentToolTrace>;
	toolBatches: ToolCall[][];
	finalText: string;
	budgetExhaustions: RunBudgetExhaustion[];
}

interface MutableUsageSummary {
	inputTokens: number;
	inputObservedAttempts: number;
	cacheReadTokens: number;
	cacheReadObservedAttempts: number;
	cacheWriteTokens: number;
	outputTokens: number;
	outputObservedAttempts: number;
	knownCostUsd: number;
	pricedAttempts: number;
	unpricedAttempts: number;
	attemptCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
	const numeric = nonNegativeNumber(value);
	if (numeric !== undefined) return numeric;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function createUsageSummary(): MutableUsageSummary {
	return {
		inputTokens: 0,
		inputObservedAttempts: 0,
		cacheReadTokens: 0,
		cacheReadObservedAttempts: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		outputObservedAttempts: 0,
		knownCostUsd: 0,
		pricedAttempts: 0,
		unpricedAttempts: 0,
		attemptCount: 0,
	};
}

function createRun(runId: string, startedAt: number): MutableRunTrace {
	return {
		runId,
		startedAt,
		turnCount: 0,
		retryCount: 0,
		attempts: [],
		tools: new Map(),
		toolBatches: [],
		finalText: "",
		budgetExhaustions: [],
	};
}

function immutableRun(run: MutableRunTrace): Immutable<AgentRunTrace> {
	return cloneFrozen({
		runId: run.runId,
		startedAt: run.startedAt,
		...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
		...(run.completedSequence === undefined ? {} : { completedSequence: run.completedSequence }),
		...(run.outcome === undefined ? {} : { outcome: run.outcome }),
		...(run.failure === undefined ? {} : { failure: run.failure }),
		turnCount: run.turnCount,
		retryCount: run.retryCount,
		attempts: run.attempts,
		tools: [...run.tools.values()],
		toolBatches: run.toolBatches,
		finalText: run.finalText,
		budgetExhaustions: run.budgetExhaustions,
	}) as Immutable<AgentRunTrace>;
}

/** The only reducer over the live AgentEvent algebra outside the Agent kernel. */
export class AgentEventTraceReducer {
	readonly #runs = new Map<string, MutableRunTrace>();
	readonly #completed: Immutable<AgentRunTrace>[] = [];
	readonly #usage = createUsageSummary();
	readonly #budgetLimits = new Set<string>();
	readonly #retainDetails: boolean;
	readonly #retainCompleted: boolean;
	#turnCount = 0;
	#runStartedAt?: number;
	#latestEventAt?: number;
	#lengthTruncationCount = 0;
	#toolRejectionCount = 0;
	#invalidToolCallCount = 0;

	constructor(options: { readonly retainDetails?: boolean; readonly retainCompleted?: boolean } = {}) {
		this.#retainDetails = options.retainDetails ?? true;
		this.#retainCompleted = options.retainCompleted ?? true;
	}

	accept(event: AgentEvent): Immutable<AgentRunTrace> | undefined;
	accept(event: unknown): Immutable<AgentRunTrace> | undefined;
	accept(value: unknown): Immutable<AgentRunTrace> | undefined {
		const event = record(value);
		if (!event || typeof event.type !== "string") return undefined;
		const timestamp = timestampMs(event.timestamp);
		if (timestamp !== undefined) this.#latestEventAt = Math.max(this.#latestEventAt ?? timestamp, timestamp);
		this.#acceptSummary(event, timestamp);

		const runId = typeof event.runId === "string" ? event.runId : undefined;
		if (!this.#retainDetails || !runId || timestamp === undefined) return undefined;
		let run = this.#runs.get(runId);
		if (!run) {
			run = createRun(runId, timestamp);
			this.#runs.set(runId, run);
		}
		const sequence = Number.isSafeInteger(event.sequence) ? Number(event.sequence) : 0;
		switch (event.type) {
			case "run_start":
				run.startedAt = timestamp;
				break;
			case "turn_start":
				run.turnCount++;
				break;
			case "attempt_end": {
				const candidate = record(event.candidate);
				const message = record(candidate?.message);
				if (
					typeof event.attemptId === "string" &&
					typeof event.turnId === "string" &&
					(event.outcome === "success" || event.outcome === "error" || event.outcome === "aborted") &&
					message?.role === "assistant"
				) {
					run.attempts.push(
						cloneFrozen({
							id: event.attemptId,
							turnId: event.turnId,
							sequence,
							timestamp,
							outcome: event.outcome,
							discarded: event.discarded === true,
							candidate: candidate as unknown as AgentMessage<AssistantMessage>,
						}),
					);
				}
				break;
			}
			case "retry_scheduled":
				run.retryCount++;
				break;
			case "message_end": {
				const envelope = record(event.message);
				const message = record(envelope?.message);
				if (message?.role !== "assistant" || !Array.isArray(message.content)) break;
				const content = message.content as AssistantMessage["content"];
				const calls = content.filter((block): block is ToolCall => block.type === "toolCall");
				if (calls.length > 0) run.toolBatches.push(structuredClone(calls));
				const text = assistantText(message as unknown as AssistantMessage);
				if (text.length > 0) run.finalText = text;
				break;
			}
			case "tool_execution_start": {
				const invocation = event.invocation as ToolInvocation | undefined;
				if (!invocation || typeof invocation.id !== "string") break;
				run.tools.set(
					String(invocation.id),
					cloneFrozen({ invocation, startedSequence: sequence, startedAt: timestamp }),
				);
				break;
			}
			case "tool_execution_end":
			case "tool_execution_rejected": {
				const invocation = event.invocation as ToolInvocation | undefined;
				if (!invocation || typeof invocation.id !== "string") break;
				const existing = run.tools.get(String(invocation.id));
				const next: AgentToolTrace = {
					...(existing ?? { invocation }),
					completedSequence: sequence,
					completedAt: timestamp,
					...(event.type === "tool_execution_end"
						? {
								settlement: event.settlement as ToolExecutionSettlement,
								outcome: event.outcome as ToolExecutionOutcome,
							}
						: { outcome: "rejected" as const, rejectionReason: String(event.reason ?? "invalid") }),
					...(record(event.result) ? { result: event.result as unknown as AgentMessage } : {}),
				};
				run.tools.set(String(invocation.id), cloneFrozen(next));
				break;
			}
			case "run_budget_exhausted": {
				const exhaustion = record(event.exhaustion);
				if (
					typeof exhaustion?.limit === "string" &&
					typeof exhaustion.maximum === "number" &&
					typeof exhaustion.observed === "number"
				) {
					run.budgetExhaustions.push(exhaustion as unknown as RunBudgetExhaustion);
				}
				break;
			}
			case "run_end": {
				run.completedAt = timestamp;
				run.completedSequence = sequence;
				if (event.outcome === "success" || event.outcome === "error" || event.outcome === "aborted") {
					run.outcome = event.outcome;
				}
				if (record(event.failure)) run.failure = event.failure as unknown as RunFailure;
				const completed = immutableRun(run);
				this.#runs.delete(runId);
				if (this.#retainCompleted) this.#completed.push(completed);
				return completed;
			}
		}
		return undefined;
	}

	snapshot(runId: string): Immutable<AgentRunTrace> | undefined {
		const run = this.#runs.get(runId);
		return run ? immutableRun(run) : undefined;
	}

	completed(): readonly Immutable<AgentRunTrace>[] {
		return Object.freeze([...this.#completed]);
	}

	traces(): readonly Immutable<AgentRunTrace>[] {
		return Object.freeze([...this.#completed, ...[...this.#runs.values()].map(immutableRun)]);
	}

	summary(): Immutable<AgentEventSummary> {
		return cloneFrozen({
			turnCount: this.#turnCount,
			...(this.#runStartedAt === undefined ? {} : { runStartedAt: this.#runStartedAt }),
			...(this.#latestEventAt === undefined ? {} : { latestEventAt: this.#latestEventAt }),
			usage: this.#usage,
			lengthTruncationCount: this.#lengthTruncationCount,
			budgetExhaustionLimits: [...this.#budgetLimits],
			toolRejectionCount: this.#toolRejectionCount,
			invalidToolCallCount: this.#invalidToolCallCount,
		}) as Immutable<AgentEventSummary>;
	}

	#acceptSummary(event: Record<string, unknown>, timestamp: number | undefined): void {
		switch (event.type) {
			case "run_start":
				if (timestamp !== undefined) this.#runStartedAt = this.#runStartedAt ?? timestamp;
				break;
			case "turn_start":
				this.#turnCount++;
				break;
			case "attempt_end": {
				this.#usage.attemptCount++;
				const message = record(record(event.candidate)?.message);
				if (message?.stopReason === "length") this.#lengthTruncationCount++;
				const usage = record(message?.usage);
				const input = nonNegativeNumber(usage?.input);
				const cacheRead = nonNegativeNumber(usage?.cacheRead);
				const cacheWrite = nonNegativeNumber(usage?.cacheWrite);
				if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
					this.#usage.inputTokens += input ?? 0;
					this.#usage.cacheReadTokens += cacheRead ?? 0;
					this.#usage.cacheWriteTokens += cacheWrite ?? 0;
					this.#usage.inputObservedAttempts++;
				}
				if (cacheRead !== undefined) this.#usage.cacheReadObservedAttempts++;
				const output = nonNegativeNumber(usage?.output);
				if (output !== undefined) {
					this.#usage.outputTokens += output;
					this.#usage.outputObservedAttempts++;
				}
				const cost = nonNegativeNumber(record(usage?.cost)?.total);
				if (cost === undefined) this.#usage.unpricedAttempts++;
				else {
					this.#usage.knownCostUsd += cost;
					this.#usage.pricedAttempts++;
				}
				break;
			}
			case "run_budget_exhausted": {
				const limit = record(event.exhaustion)?.limit;
				if (typeof limit === "string" && this.#budgetLimits.size < 32) this.#budgetLimits.add(limit);
				break;
			}
			case "tool_execution_rejected":
				this.#toolRejectionCount++;
				if (event.reason === "invalid") this.#invalidToolCallCount++;
				break;
		}
	}
}
