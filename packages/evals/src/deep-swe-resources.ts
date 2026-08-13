import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const DEEP_SWE_REPORT_RECOVERY_METADATA_KEY = "coda_report_recovery_v1";

export type DeepSweCoverageStatus = "complete" | "partial" | "unavailable";

export type DeepSweResourceSource = "run_evidence" | "terminal_events" | "pier_result" | "legacy_report" | "missing";

export interface DeepSweTrialResourceTotal {
	readonly knownTotal: number | null;
	readonly status: DeepSweCoverageStatus;
	readonly source: DeepSweResourceSource;
}

export interface DeepSweTrialCostTotal {
	readonly knownTotalUsd: number | null;
	readonly status: DeepSweCoverageStatus;
	readonly source: DeepSweResourceSource;
	readonly pricedAttempts: number | null;
	readonly unpricedAttempts: number | null;
	readonly attemptCoverage: DeepSweCoverageStatus;
}

export interface DeepSweRecoveredTrialResources {
	readonly inputTokens: DeepSweTrialResourceTotal;
	readonly cacheTokens: DeepSweTrialResourceTotal;
	readonly outputTokens: DeepSweTrialResourceTotal;
	readonly costUsd: DeepSweTrialCostTotal;
	readonly turnCount: DeepSweTrialResourceTotal;
	readonly agentElapsedMs: DeepSweTrialResourceTotal;
}

/**
 * Bounded projection of one Coda JSONL stream. It is safe to attach to an
 * in-memory Pier trial before the versioned report projection runs.
 */
export interface DeepSweJsonlReduction {
	readonly schemaVersion: 1;
	readonly resources: DeepSweRecoveredTrialResources;
	readonly lengthTruncationCount: number;
	readonly budgetExhaustionLimits: readonly string[];
	readonly toolRejectionCount: number;
	readonly policyRejectionCount: number;
	readonly invalidToolCallCount: number;
}

const MAX_BUDGET_EXHAUSTION_LIMITS = 32;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	const number = nonNegativeNumber(value);
	return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function timestampMs(value: unknown): number | undefined {
	const numeric = nonNegativeNumber(value);
	if (numeric !== undefined) return numeric;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function unavailableResource(source: DeepSweResourceSource = "missing"): DeepSweTrialResourceTotal {
	return { knownTotal: null, status: "unavailable", source };
}

function partialResource(knownTotal: number): DeepSweTrialResourceTotal {
	return { knownTotal, status: "partial", source: "terminal_events" };
}

function coverageStatus(value: unknown): DeepSweCoverageStatus | undefined {
	return value === "complete" || value === "partial" || value === "unavailable" ? value : undefined;
}

interface TerminalUsageTotals {
	inputTokens: number;
	inputObservedAttempts: number;
	cacheTokens: number;
	cacheObservedAttempts: number;
	outputTokens: number;
	outputObservedAttempts: number;
	knownCostUsd: number;
	pricedAttempts: number;
	unpricedAttempts: number;
	attemptEnds: number;
}

function createTerminalUsageTotals(): TerminalUsageTotals {
	return {
		inputTokens: 0,
		inputObservedAttempts: 0,
		cacheTokens: 0,
		cacheObservedAttempts: 0,
		outputTokens: 0,
		outputObservedAttempts: 0,
		knownCostUsd: 0,
		pricedAttempts: 0,
		unpricedAttempts: 0,
		attemptEnds: 0,
	};
}

/** Constant-space reducer for semantic or legacy raw Coda event streams. */
export class DeepSweEventResourceReducer {
	readonly #usage = createTerminalUsageTotals();
	readonly #budgetExhaustionLimits = new Set<string>();
	#runEvidenceResources: DeepSweRecoveredTrialResources | undefined;
	#turnCount = 0;
	#sawRunStart = false;
	#runStartedAt: number | undefined;
	#latestEventAt: number | undefined;
	#lengthTruncationCount = 0;
	#toolRejectionCount = 0;
	#policyRejectionCount = 0;
	#invalidToolCallCount = 0;

	accept(value: unknown): void {
		const event = record(value);
		if (!event) return;
		const timestamp = timestampMs(event.timestamp);
		if (timestamp !== undefined) {
			this.#latestEventAt = Math.max(this.#latestEventAt ?? timestamp, timestamp);
		}

		switch (event.type) {
			case "run_start":
				this.#sawRunStart = true;
				if (timestamp !== undefined) this.#runStartedAt = timestamp;
				break;
			case "turn_start":
				this.#turnCount++;
				break;
			case "attempt_end":
				this.#acceptAttemptEnd(event);
				break;
			case "run_evidence":
				this.#runEvidenceResources = this.#resourcesFromRunEvidence(event);
				break;
			case "run_budget_exhausted": {
				const limit = record(event.exhaustion)?.limit;
				if (typeof limit === "string" && this.#budgetExhaustionLimits.size < MAX_BUDGET_EXHAUSTION_LIMITS) {
					this.#budgetExhaustionLimits.add(limit);
				}
				break;
			}
			case "tool_execution_rejected":
				this.#toolRejectionCount++;
				if (event.reason === "policy") this.#policyRejectionCount++;
				if (event.reason === "invalid") this.#invalidToolCallCount++;
				break;
		}
	}

	finish(): DeepSweJsonlReduction {
		return {
			schemaVersion: 1,
			resources: this.#runEvidenceResources ?? this.#partialTerminalResources(),
			lengthTruncationCount: this.#lengthTruncationCount,
			budgetExhaustionLimits: [...this.#budgetExhaustionLimits],
			toolRejectionCount: this.#toolRejectionCount,
			policyRejectionCount: this.#policyRejectionCount,
			invalidToolCallCount: this.#invalidToolCallCount,
		};
	}

	#acceptAttemptEnd(event: Record<string, unknown>): void {
		this.#usage.attemptEnds++;
		const message = record(record(event.candidate)?.message);
		if (message?.stopReason === "length") this.#lengthTruncationCount++;
		const usage = record(message?.usage);
		const input = nonNegativeNumber(usage?.input);
		const cacheRead = nonNegativeNumber(usage?.cacheRead);
		const cacheWrite = nonNegativeNumber(usage?.cacheWrite);
		const knownInputComponents = [input, cacheRead, cacheWrite].filter(
			(component): component is number => component !== undefined,
		);
		if (knownInputComponents.length > 0) {
			this.#usage.inputTokens += knownInputComponents.reduce((sum, component) => sum + component, 0);
			this.#usage.inputObservedAttempts++;
		}
		if (cacheRead !== undefined) {
			this.#usage.cacheTokens += cacheRead;
			this.#usage.cacheObservedAttempts++;
		}
		const output = nonNegativeNumber(usage?.output);
		if (output !== undefined) {
			this.#usage.outputTokens += output;
			this.#usage.outputObservedAttempts++;
		}
		const costTotal = nonNegativeNumber(record(usage?.cost)?.total);
		if (costTotal === undefined) this.#usage.unpricedAttempts++;
		else {
			this.#usage.knownCostUsd += costTotal;
			this.#usage.pricedAttempts++;
		}
	}

	#partialTerminalResources(): DeepSweRecoveredTrialResources {
		const usage = this.#usage;
		const agentElapsedMs =
			this.#runStartedAt !== undefined && this.#latestEventAt !== undefined
				? Math.max(0, this.#latestEventAt - this.#runStartedAt)
				: undefined;
		const sawTerminalResources = usage.attemptEnds > 0 || this.#turnCount > 0 || this.#sawRunStart;
		return {
			inputTokens:
				usage.inputObservedAttempts > 0
					? partialResource(usage.inputTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			cacheTokens:
				usage.cacheObservedAttempts > 0
					? partialResource(usage.cacheTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			outputTokens:
				usage.outputObservedAttempts > 0
					? partialResource(usage.outputTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			costUsd: {
				knownTotalUsd: usage.pricedAttempts > 0 ? usage.knownCostUsd : null,
				status: usage.pricedAttempts > 0 ? "partial" : "unavailable",
				source: sawTerminalResources ? "terminal_events" : "missing",
				pricedAttempts: usage.attemptEnds > 0 ? usage.pricedAttempts : null,
				unpricedAttempts: usage.attemptEnds > 0 ? usage.unpricedAttempts : null,
				attemptCoverage: usage.attemptEnds > 0 ? "partial" : "unavailable",
			},
			turnCount: sawTerminalResources ? partialResource(this.#turnCount) : unavailableResource(),
			agentElapsedMs:
				agentElapsedMs !== undefined
					? partialResource(agentElapsedMs)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
		};
	}

	#resourcesFromRunEvidence(event: Record<string, unknown>): DeepSweRecoveredTrialResources {
		const usage = record(event.usage);
		const input = nonNegativeNumber(usage?.inputTokens);
		const cacheRead = nonNegativeNumber(usage?.cacheReadTokens);
		const cacheWrite = nonNegativeNumber(usage?.cacheWriteTokens);
		const output = nonNegativeNumber(usage?.outputTokens);
		const cost = record(usage?.cost);
		const pricedAttempts = nonNegativeInteger(cost?.pricedAttempts);
		const unpricedAttempts = nonNegativeInteger(cost?.unpricedAttempts);
		const reportedCostStatus = coverageStatus(cost?.status) ?? "unavailable";
		const knownTotalUsd = nonNegativeNumber(cost?.knownTotalUsd);
		const hasKnownCost = pricedAttempts !== undefined && pricedAttempts > 0 && knownTotalUsd !== undefined;
		const costStatus = hasKnownCost ? reportedCostStatus : "unavailable";
		const elapsedMs = nonNegativeNumber(event.elapsedMs);
		const terminalSource: DeepSweResourceSource = "run_evidence";
		return {
			inputTokens:
				input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
					? { knownTotal: input + cacheRead + cacheWrite, status: "complete", source: terminalSource }
					: unavailableResource(terminalSource),
			cacheTokens:
				cacheRead !== undefined
					? { knownTotal: cacheRead, status: "complete", source: terminalSource }
					: unavailableResource(terminalSource),
			outputTokens:
				output !== undefined
					? { knownTotal: output, status: "complete", source: terminalSource }
					: unavailableResource(terminalSource),
			costUsd: {
				knownTotalUsd: hasKnownCost ? knownTotalUsd : null,
				status: costStatus,
				source: terminalSource,
				pricedAttempts: pricedAttempts ?? null,
				unpricedAttempts: unpricedAttempts ?? null,
				attemptCoverage:
					pricedAttempts !== undefined && unpricedAttempts !== undefined ? "complete" : "unavailable",
			},
			turnCount: this.#sawRunStart
				? { knownTotal: this.#turnCount, status: "complete", source: "terminal_events" }
				: unavailableResource("terminal_events"),
			agentElapsedMs:
				elapsedMs !== undefined
					? { knownTotal: elapsedMs, status: "complete", source: terminalSource }
					: unavailableResource(terminalSource),
		};
	}
}

/** Reduces an async line source without retaining prior lines or parsed events. */
export async function reduceDeepSweJsonlLines(lines: AsyncIterable<string>): Promise<DeepSweJsonlReduction> {
	const reducer = new DeepSweEventResourceReducer();
	for await (const line of lines) {
		if (line.length === 0) continue;
		try {
			reducer.accept(JSON.parse(line));
		} catch {
			// A hard timeout may truncate the final record. Earlier valid records remain usable.
		}
	}
	return reducer.finish();
}

/** Streams a JSONL artifact from disk with memory bounded by one input line. */
export async function reduceDeepSweJsonlFile(path: string): Promise<DeepSweJsonlReduction> {
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		return await reduceDeepSweJsonlLines(lines);
	} finally {
		lines.close();
		input.destroy();
	}
}
