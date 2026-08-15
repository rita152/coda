import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { type AgentEventSummary, AgentEventTraceReducer } from "@coda/agent";

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
	readonly invalidToolCallCount: number;
}

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

function unavailableResource(source: DeepSweResourceSource = "missing"): DeepSweTrialResourceTotal {
	return { knownTotal: null, status: "unavailable", source };
}

function partialResource(knownTotal: number): DeepSweTrialResourceTotal {
	return { knownTotal, status: "partial", source: "terminal_events" };
}

function coverageStatus(value: unknown): DeepSweCoverageStatus | undefined {
	return value === "complete" || value === "partial" || value === "unavailable" ? value : undefined;
}

/** Constant-space reducer for semantic or legacy raw Coda event streams. */
export class DeepSweEventResourceReducer {
	readonly #trace = new AgentEventTraceReducer({ retainDetails: false });
	#runEvidenceResources: DeepSweRecoveredTrialResources | undefined;

	accept(value: unknown): void {
		this.#trace.accept(value);
		const event = record(value);
		if (!event) return;
		if (event.type === "run_evidence") this.#runEvidenceResources = this.#resourcesFromRunEvidence(event);
	}

	finish(): DeepSweJsonlReduction {
		const summary = this.#trace.summary();
		return {
			schemaVersion: 1,
			resources: this.#runEvidenceResources ?? this.#partialTerminalResources(summary),
			lengthTruncationCount: summary.lengthTruncationCount,
			budgetExhaustionLimits: summary.budgetExhaustionLimits,
			toolRejectionCount: summary.toolRejectionCount,
			invalidToolCallCount: summary.invalidToolCallCount,
		};
	}

	#partialTerminalResources(summary: AgentEventSummary): DeepSweRecoveredTrialResources {
		const usage = summary.usage;
		const agentElapsedMs =
			summary.runStartedAt !== undefined && summary.latestEventAt !== undefined
				? Math.max(0, summary.latestEventAt - summary.runStartedAt)
				: undefined;
		const sawTerminalResources =
			usage.attemptCount > 0 || summary.turnCount > 0 || summary.runStartedAt !== undefined;
		return {
			inputTokens:
				usage.inputObservedAttempts > 0
					? partialResource(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			cacheTokens:
				usage.cacheReadObservedAttempts > 0
					? partialResource(usage.cacheReadTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			outputTokens:
				usage.outputObservedAttempts > 0
					? partialResource(usage.outputTokens)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
			costUsd: {
				knownTotalUsd: usage.pricedAttempts > 0 ? usage.knownCostUsd : null,
				status: usage.pricedAttempts > 0 ? "partial" : "unavailable",
				source: sawTerminalResources ? "terminal_events" : "missing",
				pricedAttempts: usage.attemptCount > 0 ? usage.pricedAttempts : null,
				unpricedAttempts: usage.attemptCount > 0 ? usage.unpricedAttempts : null,
				attemptCoverage: usage.attemptCount > 0 ? "partial" : "unavailable",
			},
			turnCount: sawTerminalResources ? partialResource(summary.turnCount) : unavailableResource(),
			agentElapsedMs:
				agentElapsedMs !== undefined
					? partialResource(agentElapsedMs)
					: unavailableResource(sawTerminalResources ? "terminal_events" : "missing"),
		};
	}

	#resourcesFromRunEvidence(event: Record<string, unknown>): DeepSweRecoveredTrialResources {
		const summary = this.#trace.summary();
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
			turnCount:
				summary.runStartedAt !== undefined
					? { knownTotal: summary.turnCount, status: "complete", source: "terminal_events" }
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
