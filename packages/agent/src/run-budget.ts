import type { ToolCall, Usage } from "@coda/ai";
import { AgentError } from "./errors.ts";
import { cloneFrozen } from "./immutable.ts";
import { snapshotRunLimits } from "./run-limits.ts";
import type { RunBudget, RunBudgetExhaustion, RunFailure, RunLimitKind } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function snapshotRunBudget(input: RunBudget | undefined): RunBudget | undefined {
	if (input === undefined) return undefined;
	if (!isRecord(input) || !isRecord(input.limits)) {
		throw new AgentError("invalid_input", "runBudget must contain a limits object");
	}

	try {
		return cloneFrozen({ limits: snapshotRunLimits(input.limits, "runBudget.limits") });
	} catch (error) {
		throw new AgentError("invalid_input", error instanceof Error ? error.message : String(error), { cause: error });
	}
}

function exhaustion(limit: RunLimitKind, maximum: number, observed: number): RunBudgetExhaustion {
	return cloneFrozen({ limit, maximum, observed });
}

function nonNegativeFinite(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageTokens(usage: Usage): number {
	if (usage.totalTokens > 0 && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	return (
		nonNegativeFinite(usage.input) +
		nonNegativeFinite(usage.output) +
		nonNegativeFinite(usage.cacheRead) +
		nonNegativeFinite(usage.cacheWrite)
	);
}

function exceeds(value: number, maximum: number): boolean {
	const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(maximum)) * 4;
	return value - maximum > tolerance;
}

function canonicalValue(value: unknown, references: Map<object, number>): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return `s:${JSON.stringify(value)}`;
		case "boolean":
			return value ? "b:1" : "b:0";
		case "number":
			if (Number.isNaN(value)) return "n:NaN";
			if (value === Number.POSITIVE_INFINITY) return "n:+Infinity";
			if (value === Number.NEGATIVE_INFINITY) return "n:-Infinity";
			return `n:${Object.is(value, -0) ? 0 : value}`;
		case "bigint":
			return `i:${value}`;
		case "undefined":
			return "u";
		case "symbol":
			return `y:${JSON.stringify(value.description ?? "")}`;
		case "function":
			return `f:${JSON.stringify(value.name)}`;
		case "object": {
			const existing = references.get(value);
			if (existing !== undefined) return `r:${existing}`;
			const reference = references.size;
			references.set(value, reference);
			if (Array.isArray(value)) {
				return `a:${reference}[${value.map((entry) => canonicalValue(entry, references)).join(",")}]`;
			}
			const entries = Object.keys(value)
				.sort()
				.map(
					(key) => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key], references)}`,
				);
			return `o:${reference}{${entries.join(",")}}`;
		}
	}
	throw new Error("Unsupported Tool argument value");
}

function toolBatchSignature(toolCalls: readonly ToolCall[]): string {
	return canonicalValue(
		toolCalls.map(({ name, arguments: arguments_ }) => ({ name, arguments: arguments_ })),
		new Map(),
	);
}

export function runBudgetFailure(value: RunBudgetExhaustion): RunFailure {
	return cloneFrozen({
		kind: "budget",
		message: `Run budget exhausted: ${value.limit} (maximum ${value.maximum}, observed ${value.observed})`,
		exhaustion: value,
	});
}

/** Mutable accounting hidden behind the immutable RunBudget and exhaustion snapshots. */
export class RunBudgetMeter {
	readonly budget: RunBudget;
	readonly #startedAt: number;
	#turns = 0;
	#modelAttempts = 0;
	#toolInvocations = 0;
	#totalTokens = 0;
	#totalCostUsd = 0;
	#lastToolBatch?: string;
	#consecutiveEquivalentToolBatches = 0;

	constructor(budget: RunBudget, startedAt: number) {
		this.budget = budget;
		this.#startedAt = startedAt;
	}

	beginTurn(now: number): RunBudgetExhaustion | undefined {
		const elapsed = this.#elapsedBefore(now);
		if (elapsed) return elapsed;
		const { maxTurns, maxModelAttempts } = this.budget.limits;
		if (maxTurns !== undefined && this.#turns >= maxTurns) {
			return exhaustion("turns", maxTurns, this.#turns);
		}
		if (maxModelAttempts !== undefined && this.#modelAttempts >= maxModelAttempts) {
			return exhaustion("model_attempts", maxModelAttempts, this.#modelAttempts);
		}
		this.#turns++;
		return undefined;
	}

	beginModelAttempt(now: number): RunBudgetExhaustion | undefined {
		const exhausted = this.checkModelAttempt(now);
		if (exhausted) return exhausted;
		this.#modelAttempts++;
		return undefined;
	}

	checkModelAttempt(now: number): RunBudgetExhaustion | undefined {
		const elapsed = this.#elapsedBefore(now);
		if (elapsed) return elapsed;
		const maximum = this.budget.limits.maxModelAttempts;
		return maximum !== undefined && this.#modelAttempts >= maximum
			? exhaustion("model_attempts", maximum, this.#modelAttempts)
			: undefined;
	}

	completeModelAttempt(usage: Usage, now: number): RunBudgetExhaustion | undefined {
		this.#totalTokens += usageTokens(usage);
		this.#totalCostUsd += nonNegativeFinite(usage.cost?.total);
		const { maxTotalTokens, maxTotalCostUsd } = this.budget.limits;
		if (maxTotalTokens !== undefined && exceeds(this.#totalTokens, maxTotalTokens)) {
			return exhaustion("total_tokens", maxTotalTokens, this.#totalTokens);
		}
		if (maxTotalCostUsd !== undefined && exceeds(this.#totalCostUsd, maxTotalCostUsd)) {
			return exhaustion("total_cost_usd", maxTotalCostUsd, this.#totalCostUsd);
		}
		return this.#elapsedAfter(now);
	}

	beginToolBatch(toolCalls: readonly ToolCall[], now: number): RunBudgetExhaustion | undefined {
		const elapsed = this.#elapsedBefore(now);
		if (elapsed) return elapsed;
		const { maxToolInvocations, maxConsecutiveEquivalentToolBatches } = this.budget.limits;
		const nextToolInvocations = this.#toolInvocations + toolCalls.length;
		if (maxToolInvocations !== undefined && nextToolInvocations > maxToolInvocations) {
			return exhaustion("tool_invocations", maxToolInvocations, nextToolInvocations);
		}

		const signature = toolBatchSignature(toolCalls);
		const nextConsecutive = signature === this.#lastToolBatch ? this.#consecutiveEquivalentToolBatches + 1 : 1;
		if (maxConsecutiveEquivalentToolBatches !== undefined && nextConsecutive > maxConsecutiveEquivalentToolBatches) {
			return exhaustion("consecutive_equivalent_tool_batches", maxConsecutiveEquivalentToolBatches, nextConsecutive);
		}

		this.#toolInvocations = nextToolInvocations;
		this.#lastToolBatch = signature;
		this.#consecutiveEquivalentToolBatches = nextConsecutive;
		return undefined;
	}

	completeToolBatch(now: number): RunBudgetExhaustion | undefined {
		return this.#elapsedAfter(now);
	}

	completeWithoutToolBatch(): void {
		this.#lastToolBatch = undefined;
		this.#consecutiveEquivalentToolBatches = 0;
	}

	#elapsedBefore(now: number): RunBudgetExhaustion | undefined {
		const maximum = this.budget.limits.maxElapsedMs;
		const elapsed = Math.max(0, now - this.#startedAt);
		return maximum !== undefined && elapsed >= maximum ? exhaustion("elapsed_ms", maximum, elapsed) : undefined;
	}

	#elapsedAfter(now: number): RunBudgetExhaustion | undefined {
		const maximum = this.budget.limits.maxElapsedMs;
		const elapsed = Math.max(0, now - this.#startedAt);
		return maximum !== undefined && elapsed > maximum ? exhaustion("elapsed_ms", maximum, elapsed) : undefined;
	}
}
