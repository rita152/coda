import { basename } from "node:path";
import {
	DEEP_SWE_REPORT_RECOVERY_METADATA_KEY,
	type DeepSweCoverageStatus,
	type DeepSweRecoveredTrialResources,
	type DeepSweResourceSource,
	type DeepSweTrialCostTotal,
	type DeepSweTrialResourceTotal,
} from "./deep-swe-resources.ts";

export const DEEP_SWE_REPORT_SCHEMA_VERSION = 2 as const;

export interface DeepSweResourceAggregate {
	readonly knownTotal: number | null;
	readonly observedTrials: number;
	readonly expectedTrials: number;
	readonly status: DeepSweCoverageStatus;
	readonly sources: readonly DeepSweResourceSource[];
}

export interface DeepSweCostAggregate {
	readonly knownTotalUsd: number | null;
	readonly observedTrials: number;
	readonly expectedTrials: number;
	readonly status: DeepSweCoverageStatus;
	readonly sources: readonly DeepSweResourceSource[];
	readonly pricedAttempts: number | null;
	readonly unpricedAttempts: number | null;
	readonly attemptCoverage: DeepSweCoverageStatus;
}

export interface DeepSweTrialResources extends DeepSweRecoveredTrialResources {
	readonly trialElapsedMs: DeepSweTrialResourceTotal;
}

export interface DeepSweTrialReport {
	readonly taskId: string;
	readonly trialName: string;
	readonly status: "passed" | "failed" | "error";
	readonly reward?: number;
	readonly f2p?: number;
	readonly f2pPassed?: number;
	readonly f2pTotal?: number;
	readonly p2p?: number;
	readonly p2pPassed?: number;
	readonly p2pTotal?: number;
	readonly partial?: number;
	readonly applyFailed?: number;
	readonly exceptionType?: string;
	readonly exceptionMessage?: string;
	readonly elapsedMs?: number;
	readonly inputTokens?: number;
	readonly cacheTokens?: number;
	readonly outputTokens?: number;
	readonly costUsd?: number;
	readonly codaExitCode?: number;
	readonly committed?: boolean;
	readonly runOutcome?: string;
	readonly turnCount?: number;
	readonly peakContextTokens?: number;
	readonly agentElapsedMs?: number;
	readonly changedPathCount?: number;
	readonly toolIssueCount?: number;
	readonly toolRejectionCount?: number;
	readonly policyRejectionCount?: number;
	readonly invalidToolCallCount?: number;
	readonly unresolvedFailureCount?: number;
	readonly lengthTruncationCount?: number;
	readonly budgetExhaustionLimits?: readonly string[];
	readonly resources: DeepSweTrialResources;
}

export interface DeepSweEvaluationReport {
	readonly schemaVersion: typeof DEEP_SWE_REPORT_SCHEMA_VERSION;
	readonly benchmark: "deep-swe";
	readonly summary: {
		readonly trials: number;
		readonly expectedTrials: number;
		readonly passed: number;
		readonly failed: number;
		readonly errors: number;
		readonly passRate: number;
		readonly f2pPassed: number;
		readonly f2pTotal: number;
		readonly p2pPassed: number;
		readonly p2pTotal: number;
		readonly averagePartial: number;
		readonly wallElapsedMs: number | null;
		readonly wallElapsedStatus: "complete" | "unavailable";
		readonly cumulativeTrialElapsedMs: DeepSweResourceAggregate;
		readonly inputTokens: DeepSweResourceAggregate;
		readonly cacheTokens: DeepSweResourceAggregate;
		readonly outputTokens: DeepSweResourceAggregate;
		readonly costUsd: DeepSweCostAggregate;
		readonly turnCount: DeepSweResourceAggregate;
		readonly cumulativeAgentElapsedMs: DeepSweResourceAggregate;
		readonly committedTrials: number;
		readonly nonzeroCodaExits: number;
		readonly toolIssueCount: number;
		readonly toolRejectionCount: number;
		readonly policyRejectionCount: number;
		readonly invalidToolCallCount: number;
		readonly unresolvedFailureCount: number;
		readonly lengthTruncationCount: number;
		readonly budgetExhaustedTrials: number;
	};
	readonly trials: readonly DeepSweTrialReport[];
}

export interface DeepSweRoundReport {
	readonly round: number;
	readonly harnessRevision: string;
	readonly maxOutputTokens?: number;
	readonly maxTurns?: number;
	readonly runBudgetEnabled?: boolean;
	readonly allowAllCommands?: boolean;
	readonly report: DeepSweEvaluationReport;
}

export interface DeepSweCampaignReport {
	readonly schemaVersion: typeof DEEP_SWE_REPORT_SCHEMA_VERSION;
	readonly benchmark: "deep-swe";
	readonly campaignKind: "development-rounds";
	readonly rounds: readonly {
		readonly round: number;
		readonly harnessRevision: string;
		readonly maxOutputTokens?: number;
		readonly maxTurns?: number;
		readonly runBudgetEnabled?: boolean;
		readonly allowAllCommands?: boolean;
		readonly summary: DeepSweEvaluationReport["summary"];
		readonly deltaPassedFromPrevious: number;
		readonly deltaPassRateFromPrevious: number;
		readonly deltaAveragePartialFromPrevious: number;
	}[];
	readonly tasks: readonly {
		readonly taskId: string;
		readonly rounds: readonly {
			readonly round: number;
			readonly status: DeepSweTrialReport["status"];
			readonly reward?: number;
			readonly partial?: number;
			readonly costUsd?: number;
			readonly turnCount?: number;
		}[];
	}[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && number >= 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	const number = finiteNumber(value);
	return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

function textValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => textValue(item) === undefined)) return undefined;
	return value as string[];
}

function dateMs(value: unknown): number | undefined {
	const text = textValue(value);
	if (!text) return undefined;
	const parsed = Date.parse(text);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function sumKnown(values: readonly (number | undefined)[]): number {
	return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function unavailableResource(source: DeepSweResourceSource = "missing"): DeepSweTrialResourceTotal {
	return { knownTotal: null, status: "unavailable", source };
}

function unavailableCost(source: DeepSweResourceSource = "missing"): DeepSweTrialCostTotal {
	return {
		knownTotalUsd: null,
		status: "unavailable",
		source,
		pricedAttempts: null,
		unpricedAttempts: null,
		attemptCoverage: "unavailable",
	};
}

function trialResource(
	value: unknown,
	status: Exclude<DeepSweCoverageStatus, "unavailable">,
	source: DeepSweResourceSource,
): DeepSweTrialResourceTotal {
	const knownTotal = nonNegativeNumber(value);
	return knownTotal === undefined ? unavailableResource() : { knownTotal, status, source };
}

function trialCost(
	value: unknown,
	status: Exclude<DeepSweCoverageStatus, "unavailable">,
	source: DeepSweResourceSource,
): DeepSweTrialCostTotal {
	const knownTotalUsd = nonNegativeNumber(value);
	return knownTotalUsd === undefined
		? unavailableCost()
		: {
				knownTotalUsd,
				status,
				source,
				pricedAttempts: null,
				unpricedAttempts: null,
				attemptCoverage: "unavailable",
			};
}

function coverageStatus(value: unknown): DeepSweCoverageStatus | undefined {
	return value === "complete" || value === "partial" || value === "unavailable" ? value : undefined;
}

function resourceSource(value: unknown): DeepSweResourceSource | undefined {
	return value === "run_evidence" ||
		value === "terminal_events" ||
		value === "pier_result" ||
		value === "legacy_report" ||
		value === "missing"
		? value
		: undefined;
}

function parseTrialResource(value: unknown): DeepSweTrialResourceTotal | undefined {
	const resource = record(value);
	const status = coverageStatus(resource?.status);
	const source = resourceSource(resource?.source);
	if (!resource || !status || !source) return undefined;
	const knownTotal = nonNegativeNumber(resource.knownTotal);
	if (status === "unavailable") return unavailableResource(source);
	return knownTotal === undefined ? undefined : { knownTotal, status, source };
}

function parseTrialCost(value: unknown): DeepSweTrialCostTotal | undefined {
	const resource = record(value);
	const status = coverageStatus(resource?.status);
	const source = resourceSource(resource?.source);
	const attemptCoverage = coverageStatus(resource?.attemptCoverage);
	if (!resource || !status || !source || !attemptCoverage) return undefined;
	const knownTotalUsd = nonNegativeNumber(resource.knownTotalUsd);
	const pricedAttempts = nonNegativeNumber(resource.pricedAttempts);
	const unpricedAttempts = nonNegativeNumber(resource.unpricedAttempts);
	if (status !== "unavailable" && knownTotalUsd === undefined) return undefined;
	return {
		knownTotalUsd: status === "unavailable" ? null : (knownTotalUsd ?? null),
		status,
		source,
		pricedAttempts: pricedAttempts ?? null,
		unpricedAttempts: unpricedAttempts ?? null,
		attemptCoverage,
	};
}

function recoveredResources(metadata: Record<string, unknown> | undefined): DeepSweRecoveredTrialResources | undefined {
	const recovery = record(metadata?.[DEEP_SWE_REPORT_RECOVERY_METADATA_KEY]);
	if (recovery?.schemaVersion !== 1) return undefined;
	const resources = record(recovery.resources);
	const inputTokens = parseTrialResource(resources?.inputTokens);
	const cacheTokens = parseTrialResource(resources?.cacheTokens);
	const outputTokens = parseTrialResource(resources?.outputTokens);
	const costUsd = parseTrialCost(resources?.costUsd);
	const turnCount = parseTrialResource(resources?.turnCount);
	const agentElapsedMs = parseTrialResource(resources?.agentElapsedMs);
	if (!inputTokens || !cacheTokens || !outputTokens || !costUsd || !turnCount || !agentElapsedMs) {
		return undefined;
	}
	return { inputTokens, cacheTokens, outputTokens, costUsd, turnCount, agentElapsedMs };
}

function preferResource(
	recovered: DeepSweTrialResourceTotal | undefined,
	fallback: DeepSweTrialResourceTotal,
): DeepSweTrialResourceTotal {
	return recovered && recovered.knownTotal !== null ? recovered : fallback;
}

function preferCost(
	recovered: DeepSweTrialCostTotal | undefined,
	fallback: DeepSweTrialCostTotal,
): DeepSweTrialCostTotal {
	return recovered && (recovered.knownTotalUsd !== null || recovered.attemptCoverage !== "unavailable")
		? recovered
		: fallback;
}

function resourcesFromPier(
	agent: Record<string, unknown> | undefined,
	metadata: Record<string, unknown> | undefined,
	exceptionType: string | undefined,
	trialElapsedMs: number | undefined,
): DeepSweTrialResources {
	const runEvidenceAvailable = textValue(metadata?.run_outcome) !== undefined;
	const source: DeepSweResourceSource = runEvidenceAvailable ? "run_evidence" : "pier_result";
	const status: Exclude<DeepSweCoverageStatus, "unavailable"> =
		runEvidenceAvailable || exceptionType === undefined ? "complete" : "partial";
	const recovered = recoveredResources(metadata);
	return {
		inputTokens: preferResource(recovered?.inputTokens, trialResource(agent?.n_input_tokens, status, source)),
		cacheTokens: preferResource(recovered?.cacheTokens, trialResource(agent?.n_cache_tokens, status, source)),
		outputTokens: preferResource(recovered?.outputTokens, trialResource(agent?.n_output_tokens, status, source)),
		costUsd: preferCost(recovered?.costUsd, trialCost(agent?.cost_usd, status, source)),
		turnCount: preferResource(recovered?.turnCount, trialResource(agent?.n_agent_steps, status, source)),
		agentElapsedMs: preferResource(recovered?.agentElapsedMs, trialResource(metadata?.elapsed_ms, status, source)),
		trialElapsedMs:
			trialElapsedMs === undefined
				? unavailableResource()
				: { knownTotal: trialElapsedMs, status: "complete", source: "pier_result" },
	};
}

function completeAlias(resource: DeepSweTrialResourceTotal): number | undefined {
	return resource.status === "complete" && resource.knownTotal !== null ? resource.knownTotal : undefined;
}

function completeCostAlias(resource: DeepSweTrialCostTotal): number | undefined {
	return resource.status === "complete" && resource.knownTotalUsd !== null ? resource.knownTotalUsd : undefined;
}

function projectPierTrial(value: unknown, index: number): DeepSweTrialReport {
	const trial = record(value);
	if (!trial) throw new Error(`Pier trial_results[${index}] must be an object`);
	const taskPath = textValue(record(trial.task_id)?.path);
	const taskName = textValue(trial.task_name);
	const taskId = taskPath ? basename(taskPath) : taskName?.split("/").at(-1);
	const trialName = textValue(trial.trial_name);
	if (!taskId || !trialName) throw new Error(`Pier trial_results[${index}] is missing task_name or trial_name`);
	const verifier = record(trial.verifier_result);
	const rewards = record(verifier?.rewards);
	const reward = finiteNumber(rewards?.reward);
	const f2p = finiteNumber(rewards?.f2p);
	const f2pPassed = finiteNumber(rewards?.f2p_passed);
	const f2pTotal = finiteNumber(rewards?.f2p_total);
	const p2p = finiteNumber(rewards?.p2p);
	const p2pPassed = finiteNumber(rewards?.p2p_passed);
	const p2pTotal = finiteNumber(rewards?.p2p_total);
	const partial = finiteNumber(rewards?.partial);
	const applyFailed = finiteNumber(rewards?.apply_failed);
	const exception = record(trial.exception_info);
	const exceptionType = textValue(exception?.exception_type);
	const agent = record(trial.agent_result);
	const metadata = record(agent?.metadata);
	const changedPaths = Array.isArray(metadata?.changed_paths) ? metadata.changed_paths : undefined;
	const budgetExhaustionLimits = textArray(metadata?.budget_exhaustion_limits);
	const startedAt = dateMs(trial.started_at);
	const finishedAt = dateMs(trial.finished_at);
	const elapsedMs =
		startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined;
	const resources = resourcesFromPier(agent, metadata, exceptionType, elapsedMs);
	const inputTokens = completeAlias(resources.inputTokens);
	const cacheTokens = completeAlias(resources.cacheTokens);
	const outputTokens = completeAlias(resources.outputTokens);
	const costUsd = completeCostAlias(resources.costUsd);
	const turnCount = completeAlias(resources.turnCount);
	const agentElapsedMs = completeAlias(resources.agentElapsedMs);
	return {
		taskId,
		trialName,
		status: exceptionType ? "error" : reward === 1 ? "passed" : "failed",
		...(reward !== undefined ? { reward } : {}),
		...(f2p !== undefined ? { f2p } : {}),
		...(f2pPassed !== undefined ? { f2pPassed } : {}),
		...(f2pTotal !== undefined ? { f2pTotal } : {}),
		...(p2p !== undefined ? { p2p } : {}),
		...(p2pPassed !== undefined ? { p2pPassed } : {}),
		...(p2pTotal !== undefined ? { p2pTotal } : {}),
		...(partial !== undefined ? { partial } : {}),
		...(applyFailed !== undefined ? { applyFailed } : {}),
		...(exceptionType ? { exceptionType } : {}),
		...(textValue(exception?.exception_message)
			? { exceptionMessage: textValue(exception?.exception_message)! }
			: {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(cacheTokens !== undefined ? { cacheTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(finiteNumber(metadata?.coda_exit_code) !== undefined
			? { codaExitCode: finiteNumber(metadata?.coda_exit_code)! }
			: {}),
		...(typeof metadata?.committed === "boolean" || changedPaths
			? { committed: metadata?.committed === true || Boolean(changedPaths?.length) }
			: {}),
		...(textValue(metadata?.run_outcome) ? { runOutcome: textValue(metadata?.run_outcome)! } : {}),
		...(turnCount !== undefined ? { turnCount } : {}),
		...(finiteNumber(agent?.peak_context_tokens) !== undefined
			? { peakContextTokens: finiteNumber(agent?.peak_context_tokens)! }
			: {}),
		...(agentElapsedMs !== undefined ? { agentElapsedMs } : {}),
		...(changedPaths ? { changedPathCount: changedPaths.length } : {}),
		...(finiteNumber(metadata?.tool_issue_count) !== undefined
			? { toolIssueCount: finiteNumber(metadata?.tool_issue_count)! }
			: {}),
		...(finiteNumber(metadata?.tool_rejection_count) !== undefined
			? { toolRejectionCount: finiteNumber(metadata?.tool_rejection_count)! }
			: {}),
		...(finiteNumber(metadata?.policy_rejection_count) !== undefined
			? { policyRejectionCount: finiteNumber(metadata?.policy_rejection_count)! }
			: {}),
		...(finiteNumber(metadata?.invalid_tool_call_count) !== undefined
			? { invalidToolCallCount: finiteNumber(metadata?.invalid_tool_call_count)! }
			: {}),
		...(finiteNumber(metadata?.unresolved_failure_count) !== undefined
			? { unresolvedFailureCount: finiteNumber(metadata?.unresolved_failure_count)! }
			: {}),
		...(finiteNumber(metadata?.length_truncation_count) !== undefined
			? { lengthTruncationCount: finiteNumber(metadata?.length_truncation_count)! }
			: {}),
		...(budgetExhaustionLimits ? { budgetExhaustionLimits } : {}),
		resources,
	};
}

function sourceOrder(source: DeepSweResourceSource): number {
	return ["run_evidence", "terminal_events", "pier_result", "legacy_report", "missing"].indexOf(source);
}

function aggregateResource(
	trials: readonly DeepSweTrialReport[],
	expectedTrials: number,
	select: (trial: DeepSweTrialReport) => DeepSweTrialResourceTotal,
): DeepSweResourceAggregate {
	const resources = trials.map(select);
	const observed = resources.filter(
		(resource): resource is DeepSweTrialResourceTotal & { readonly knownTotal: number } =>
			resource.knownTotal !== null,
	);
	const status: DeepSweCoverageStatus =
		observed.length === 0
			? "unavailable"
			: observed.length === expectedTrials && resources.every((resource) => resource.status === "complete")
				? "complete"
				: "partial";
	return {
		knownTotal: observed.length === 0 ? null : observed.reduce((sum, resource) => sum + resource.knownTotal, 0),
		observedTrials: observed.length,
		expectedTrials,
		status,
		sources: [...new Set(resources.map(({ source }) => source).filter((source) => source !== "missing"))].sort(
			(left, right) => sourceOrder(left) - sourceOrder(right),
		),
	};
}

function aggregateCost(trials: readonly DeepSweTrialReport[], expectedTrials: number): DeepSweCostAggregate {
	const resources = trials.map(({ resources }) => resources.costUsd);
	const observed = resources.filter(
		(resource): resource is DeepSweTrialCostTotal & { readonly knownTotalUsd: number } =>
			resource.knownTotalUsd !== null,
	);
	const attemptCounts = resources.filter(
		(
			resource,
		): resource is DeepSweTrialCostTotal & {
			readonly pricedAttempts: number;
			readonly unpricedAttempts: number;
		} => resource.pricedAttempts !== null && resource.unpricedAttempts !== null,
	);
	const status: DeepSweCoverageStatus =
		observed.length === 0
			? "unavailable"
			: observed.length === expectedTrials && resources.every((resource) => resource.status === "complete")
				? "complete"
				: "partial";
	const attemptCoverage: DeepSweCoverageStatus =
		attemptCounts.length === 0
			? "unavailable"
			: attemptCounts.length === expectedTrials &&
					resources.every((resource) => resource.attemptCoverage === "complete")
				? "complete"
				: "partial";
	return {
		knownTotalUsd: observed.length === 0 ? null : observed.reduce((sum, resource) => sum + resource.knownTotalUsd, 0),
		observedTrials: observed.length,
		expectedTrials,
		status,
		sources: [...new Set(resources.map(({ source }) => source).filter((source) => source !== "missing"))].sort(
			(left, right) => sourceOrder(left) - sourceOrder(right),
		),
		pricedAttempts:
			attemptCounts.length === 0 ? null : attemptCounts.reduce((sum, resource) => sum + resource.pricedAttempts, 0),
		unpricedAttempts:
			attemptCounts.length === 0
				? null
				: attemptCounts.reduce((sum, resource) => sum + resource.unpricedAttempts, 0),
		attemptCoverage,
	};
}

function buildReport(
	trials: readonly DeepSweTrialReport[],
	expectedTrials: number,
	wallElapsedMs: number | undefined,
): DeepSweEvaluationReport {
	const ordered = [...trials].sort(
		(left, right) => left.taskId.localeCompare(right.taskId) || left.trialName.localeCompare(right.trialName),
	);
	const passed = ordered.filter(({ status }) => status === "passed").length;
	const errors = ordered.filter(({ status }) => status === "error").length;
	const failed = ordered.length - passed - errors;
	const partials = ordered.flatMap(({ partial }) => (partial === undefined ? [] : [partial]));
	return Object.freeze({
		schemaVersion: DEEP_SWE_REPORT_SCHEMA_VERSION,
		benchmark: "deep-swe",
		summary: {
			trials: ordered.length,
			expectedTrials,
			passed,
			failed,
			errors,
			passRate: ordered.length === 0 ? 0 : passed / ordered.length,
			f2pPassed: sumKnown(ordered.map(({ f2pPassed }) => f2pPassed)),
			f2pTotal: sumKnown(ordered.map(({ f2pTotal }) => f2pTotal)),
			p2pPassed: sumKnown(ordered.map(({ p2pPassed }) => p2pPassed)),
			p2pTotal: sumKnown(ordered.map(({ p2pTotal }) => p2pTotal)),
			averagePartial: partials.length === 0 ? 0 : sumKnown(partials) / partials.length,
			wallElapsedMs: wallElapsedMs ?? null,
			wallElapsedStatus: wallElapsedMs === undefined ? ("unavailable" as const) : ("complete" as const),
			cumulativeTrialElapsedMs: aggregateResource(
				ordered,
				expectedTrials,
				({ resources }) => resources.trialElapsedMs,
			),
			inputTokens: aggregateResource(ordered, expectedTrials, ({ resources }) => resources.inputTokens),
			cacheTokens: aggregateResource(ordered, expectedTrials, ({ resources }) => resources.cacheTokens),
			outputTokens: aggregateResource(ordered, expectedTrials, ({ resources }) => resources.outputTokens),
			costUsd: aggregateCost(ordered, expectedTrials),
			turnCount: aggregateResource(ordered, expectedTrials, ({ resources }) => resources.turnCount),
			cumulativeAgentElapsedMs: aggregateResource(
				ordered,
				expectedTrials,
				({ resources }) => resources.agentElapsedMs,
			),
			committedTrials: ordered.filter(({ committed }) => committed).length,
			nonzeroCodaExits: ordered.filter(({ codaExitCode }) => codaExitCode !== undefined && codaExitCode !== 0)
				.length,
			toolIssueCount: sumKnown(ordered.map(({ toolIssueCount }) => toolIssueCount)),
			toolRejectionCount: sumKnown(ordered.map(({ toolRejectionCount }) => toolRejectionCount)),
			policyRejectionCount: sumKnown(ordered.map(({ policyRejectionCount }) => policyRejectionCount)),
			invalidToolCallCount: sumKnown(ordered.map(({ invalidToolCallCount }) => invalidToolCallCount)),
			unresolvedFailureCount: sumKnown(ordered.map(({ unresolvedFailureCount }) => unresolvedFailureCount)),
			lengthTruncationCount: sumKnown(ordered.map(({ lengthTruncationCount }) => lengthTruncationCount)),
			budgetExhaustedTrials: ordered.filter(({ budgetExhaustionLimits }) => Boolean(budgetExhaustionLimits?.length))
				.length,
		},
		trials: ordered,
	});
}

/** Projects raw Pier job/trial JSON into the coverage-aware report schema. */
export function summarizeDeepSweJobResult(input: unknown): DeepSweEvaluationReport {
	const result = record(input);
	if (!result || !Array.isArray(result.trial_results)) throw new Error("Pier result must contain trial_results");
	const trials = result.trial_results.map(projectPierTrial);
	const expectedTrials = Math.max(positiveInteger(result.n_total_trials) ?? trials.length, trials.length);
	const startedAt = dateMs(result.started_at);
	const finishedAt = dateMs(result.finished_at);
	const wallElapsedMs =
		startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined;
	return buildReport(trials, expectedTrials, wallElapsedMs);
}

function legacyStatus(value: unknown): DeepSweTrialReport["status"] | undefined {
	return value === "passed" || value === "failed" || value === "error" ? value : undefined;
}

function legacyResource(value: unknown): DeepSweTrialResourceTotal {
	return trialResource(value, "complete", "legacy_report");
}

function legacyCost(value: unknown): DeepSweTrialCostTotal {
	return trialCost(value, "complete", "legacy_report");
}

function projectLegacyTrial(value: unknown, index: number): DeepSweTrialReport {
	const trial = record(value);
	const taskId = textValue(trial?.taskId);
	const trialName = textValue(trial?.trialName);
	const status = legacyStatus(trial?.status);
	if (!trial || !taskId || !trialName || !status) throw new Error(`Legacy DeepSWE report trial[${index}] is invalid`);
	const elapsedMs = nonNegativeNumber(trial.elapsedMs);
	const inputTokens = nonNegativeNumber(trial.inputTokens);
	const cacheTokens = nonNegativeNumber(trial.cacheTokens);
	const outputTokens = nonNegativeNumber(trial.outputTokens);
	const costUsd = nonNegativeNumber(trial.costUsd);
	const turnCount = nonNegativeNumber(trial.turnCount);
	const agentElapsedMs = nonNegativeNumber(trial.agentElapsedMs);
	const resources: DeepSweTrialResources = {
		trialElapsedMs: legacyResource(elapsedMs),
		inputTokens: legacyResource(inputTokens),
		cacheTokens: legacyResource(cacheTokens),
		outputTokens: legacyResource(outputTokens),
		costUsd: legacyCost(costUsd),
		turnCount: legacyResource(turnCount),
		agentElapsedMs: legacyResource(agentElapsedMs),
	};
	const optionalNumber = <TKey extends keyof DeepSweTrialReport>(key: TKey): Record<string, number> => {
		const number = finiteNumber(trial[key as string]);
		return number === undefined ? {} : { [key]: number };
	};
	return {
		taskId,
		trialName,
		status,
		...optionalNumber("reward"),
		...optionalNumber("f2p"),
		...optionalNumber("f2pPassed"),
		...optionalNumber("f2pTotal"),
		...optionalNumber("p2p"),
		...optionalNumber("p2pPassed"),
		...optionalNumber("p2pTotal"),
		...optionalNumber("partial"),
		...optionalNumber("applyFailed"),
		...(textValue(trial.exceptionType) ? { exceptionType: textValue(trial.exceptionType)! } : {}),
		...(textValue(trial.exceptionMessage) ? { exceptionMessage: textValue(trial.exceptionMessage)! } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(cacheTokens !== undefined ? { cacheTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...optionalNumber("codaExitCode"),
		...(typeof trial.committed === "boolean" ? { committed: trial.committed } : {}),
		...(textValue(trial.runOutcome) ? { runOutcome: textValue(trial.runOutcome)! } : {}),
		...(turnCount !== undefined ? { turnCount } : {}),
		...optionalNumber("peakContextTokens"),
		...(agentElapsedMs !== undefined ? { agentElapsedMs } : {}),
		...optionalNumber("changedPathCount"),
		...optionalNumber("toolIssueCount"),
		...optionalNumber("toolRejectionCount"),
		...optionalNumber("policyRejectionCount"),
		...optionalNumber("invalidToolCallCount"),
		...optionalNumber("unresolvedFailureCount"),
		...optionalNumber("lengthTruncationCount"),
		...(textArray(trial.budgetExhaustionLimits)
			? { budgetExhaustionLimits: textArray(trial.budgetExhaustionLimits)! }
			: {}),
		resources,
	};
}

/** Reads schema v2 reports and upgrades schema v1 round 5-11 summaries. */
export function readDeepSweEvaluationReport(input: unknown): DeepSweEvaluationReport {
	const report = record(input);
	if (!report || report.benchmark !== "deep-swe") throw new Error("DeepSWE report must use benchmark deep-swe");
	if (report.schemaVersion === 2) {
		if (!record(report.summary) || !Array.isArray(report.trials))
			throw new Error("DeepSWE schema v2 report is invalid");
		return report as unknown as DeepSweEvaluationReport;
	}
	if (report.schemaVersion !== 1 || !Array.isArray(report.trials)) {
		throw new Error(`Unsupported DeepSWE report schema version: ${String(report.schemaVersion)}`);
	}
	const trials = report.trials.map(projectLegacyTrial);
	const expectedTrials = Math.max(positiveInteger(record(report.summary)?.trials) ?? trials.length, trials.length);
	return buildReport(trials, expectedTrials, undefined);
}

function requirePositiveRound(value: number): void {
	if (!Number.isInteger(value) || value < 1) throw new Error("round must be a positive integer");
}

export function compareDeepSweRounds(inputs: readonly DeepSweRoundReport[]): DeepSweCampaignReport {
	if (inputs.length === 0) throw new Error("DeepSWE comparison requires at least one round");
	const ordered = [...inputs].sort((left, right) => left.round - right.round);
	if (new Set(ordered.map(({ round }) => round)).size !== ordered.length) {
		throw new Error("DeepSWE comparison round numbers must be unique");
	}
	for (const input of ordered) requirePositiveRound(input.round);

	const taskIds = [...new Set(ordered.flatMap(({ report }) => report.trials.map(({ taskId }) => taskId)))].sort();
	return Object.freeze({
		schemaVersion: DEEP_SWE_REPORT_SCHEMA_VERSION,
		benchmark: "deep-swe",
		campaignKind: "development-rounds",
		rounds: ordered.map((current, index) => {
			const previous = ordered[index - 1];
			return {
				round: current.round,
				harnessRevision: current.harnessRevision,
				...(current.maxOutputTokens !== undefined ? { maxOutputTokens: current.maxOutputTokens } : {}),
				...(current.maxTurns !== undefined ? { maxTurns: current.maxTurns } : {}),
				...(current.runBudgetEnabled !== undefined ? { runBudgetEnabled: current.runBudgetEnabled } : {}),
				...(current.allowAllCommands !== undefined ? { allowAllCommands: current.allowAllCommands } : {}),
				summary: current.report.summary,
				deltaPassedFromPrevious: previous ? current.report.summary.passed - previous.report.summary.passed : 0,
				deltaPassRateFromPrevious: previous
					? current.report.summary.passRate - previous.report.summary.passRate
					: 0,
				deltaAveragePartialFromPrevious: previous
					? current.report.summary.averagePartial - previous.report.summary.averagePartial
					: 0,
			};
		}),
		tasks: taskIds.map((taskId) => ({
			taskId,
			rounds: ordered.flatMap(({ round, report }) => {
				const trial = report.trials.find((candidate) => candidate.taskId === taskId);
				return trial
					? [
							{
								round,
								status: trial.status,
								...(trial.reward !== undefined ? { reward: trial.reward } : {}),
								...(trial.partial !== undefined ? { partial: trial.partial } : {}),
								...(trial.costUsd !== undefined ? { costUsd: trial.costUsd } : {}),
								...(trial.turnCount !== undefined ? { turnCount: trial.turnCount } : {}),
							},
						]
					: [];
			}),
		})),
	});
}
