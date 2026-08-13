import { basename } from "node:path";
import {
	compareDeepSweExperimentRounds,
	createDeepSweAttemptId,
	type DeepSweExperimentComparison,
	type DeepSweExperimentPlan,
	type DeepSweExperimentRoundInput,
	type DeepSweRepeatedSamplingSummary,
	type DeepSweTaskSamplingSummary,
	summarizeDeepSweRepeatedTrials,
} from "./deep-swe-experiment.ts";
import {
	DEEP_SWE_REPORT_RECOVERY_METADATA_KEY,
	type DeepSweCoverageStatus,
	type DeepSweRecoveredTrialResources,
	type DeepSweResourceSource,
	type DeepSweTrialCostTotal,
	type DeepSweTrialResourceTotal,
} from "./deep-swe-resources.ts";

export const DEEP_SWE_REPORT_SCHEMA_VERSION = 3 as const;

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
	readonly attemptIndex: number;
	readonly attemptId: string;
	readonly attemptIdentitySource: "reported" | "derived";
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
	readonly sampling: DeepSweRepeatedSamplingSummary;
	readonly trials: readonly DeepSweTrialReport[];
}

export interface DeepSweSummaryOptions {
	readonly experiment?: DeepSweExperimentPlan;
}

export interface DeepSweRoundReport {
	readonly round: number;
	readonly harnessRevision: string;
	readonly concurrency?: number;
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly datasetRevision?: string;
	readonly pierRevision?: string;
	readonly maxOutputTokens?: number;
	readonly maxTurns?: number;
	readonly runBudgetEnabled?: boolean;
	readonly allowAllCommands?: boolean;
	readonly experiment?: DeepSweExperimentPlan;
	readonly report: DeepSweEvaluationReport;
}

export interface DeepSweCampaignReport {
	readonly schemaVersion: typeof DEEP_SWE_REPORT_SCHEMA_VERSION;
	readonly benchmark: "deep-swe";
	readonly campaignKind: "development-rounds";
	readonly rounds: readonly {
		readonly round: number;
		readonly harnessRevision: string;
		readonly concurrency?: number;
		readonly model?: string;
		readonly reasoningEffort?: string;
		readonly datasetRevision?: string;
		readonly pierRevision?: string;
		readonly maxOutputTokens?: number;
		readonly maxTurns?: number;
		readonly runBudgetEnabled?: boolean;
		readonly allowAllCommands?: boolean;
		readonly experiment?: DeepSweExperimentPlan;
		readonly summary: DeepSweEvaluationReport["summary"];
		readonly deltaPassedFromPrevious: number;
		readonly deltaPassRateFromPrevious: number;
		readonly deltaAveragePartialFromPrevious: number;
	}[];
	readonly tasks: readonly {
		readonly taskId: string;
		readonly rounds: readonly {
			readonly round: number;
			readonly sampling: DeepSweTaskSamplingSummary;
			readonly trials: readonly {
				readonly attemptIndex: number;
				readonly attemptId: string;
				readonly attemptIdentitySource: DeepSweTrialReport["attemptIdentitySource"];
				readonly trialName: string;
				readonly status: DeepSweTrialReport["status"];
				readonly reward?: number;
				readonly partial?: number;
				readonly costUsd?: number;
				readonly turnCount?: number;
			}[];
		}[];
	}[];
	readonly comparisons: readonly DeepSweExperimentComparison[];
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

interface AttemptIdentity {
	readonly attemptIndex: number;
	readonly attemptId: string;
	readonly attemptIdentitySource: "reported" | "derived";
}

function claimAttemptIdentity(
	trial: Record<string, unknown>,
	index: number,
	taskId: string,
	usedAttemptIndexes: Map<string, Set<number>>,
	label: string,
): AttemptIdentity {
	const taskIndexes = usedAttemptIndexes.get(taskId) ?? new Set<number>();
	const reportedAttemptIndex = finiteNumber(trial.attempt_index ?? trial.attemptIndex);
	if (
		(trial.attempt_index !== undefined || trial.attemptIndex !== undefined) &&
		(reportedAttemptIndex === undefined || !Number.isInteger(reportedAttemptIndex) || reportedAttemptIndex < 1)
	) {
		throw new Error(`${label}[${index}].attempt_index must be a positive integer`);
	}
	let attemptIndex = reportedAttemptIndex;
	if (attemptIndex === undefined) {
		attemptIndex = 1;
		while (taskIndexes.has(attemptIndex)) attemptIndex++;
	}
	if (taskIndexes.has(attemptIndex)) {
		throw new Error(`${label} task ${taskId} contains duplicate attempt_index ${attemptIndex}`);
	}
	taskIndexes.add(attemptIndex);
	usedAttemptIndexes.set(taskId, taskIndexes);
	const rawAttemptId = trial.attempt_id ?? trial.attemptId;
	const reportedAttemptId = textValue(rawAttemptId);
	if (rawAttemptId !== undefined && reportedAttemptId === undefined) {
		throw new Error(`${label}[${index}].attempt_id must be a non-empty string`);
	}
	const storedSource =
		trial.attemptIdentitySource === "reported" || trial.attemptIdentitySource === "derived"
			? trial.attemptIdentitySource
			: undefined;
	return {
		attemptIndex,
		attemptId: reportedAttemptId ?? createDeepSweAttemptId(taskId, attemptIndex, 1),
		attemptIdentitySource:
			storedSource ?? (reportedAttemptId || reportedAttemptIndex !== undefined ? "reported" : "derived"),
	};
}

function projectPierTrial(
	value: unknown,
	index: number,
	usedAttemptIndexes: Map<string, Set<number>>,
): DeepSweTrialReport {
	const trial = record(value);
	if (!trial) throw new Error(`Pier trial_results[${index}] must be an object`);
	const taskPath = textValue(record(trial.task_id)?.path);
	const taskName = textValue(trial.task_name);
	const taskId = taskPath ? basename(taskPath) : taskName?.split("/").at(-1);
	const trialName = textValue(trial.trial_name);
	if (!taskId || !trialName) throw new Error(`Pier trial_results[${index}] is missing task_name or trial_name`);
	const attemptIdentity = claimAttemptIdentity(trial, index, taskId, usedAttemptIndexes, "Pier trial_results");
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
		...attemptIdentity,
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
	options: DeepSweSummaryOptions = {},
): DeepSweEvaluationReport {
	const ordered = [...trials].sort(
		(left, right) =>
			left.taskId.localeCompare(right.taskId) ||
			left.attemptIndex - right.attemptIndex ||
			left.trialName.localeCompare(right.trialName),
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
		sampling: summarizeDeepSweRepeatedTrials(ordered, options.experiment?.plannedTrials),
		trials: ordered,
	});
}

/** Projects raw Pier job/trial JSON into the coverage-aware report schema. */
export function summarizeDeepSweJobResult(
	input: unknown,
	options: DeepSweSummaryOptions = {},
): DeepSweEvaluationReport {
	const result = record(input);
	if (!result || !Array.isArray(result.trial_results)) throw new Error("Pier result must contain trial_results");
	const usedAttemptIndexes = new Map<string, Set<number>>();
	const trials = result.trial_results.map((trial, index) => projectPierTrial(trial, index, usedAttemptIndexes));
	const expectedTrials = Math.max(
		positiveInteger(result.n_total_trials) ?? 0,
		options.experiment?.plannedTrials.length ?? 0,
		trials.length,
	);
	const startedAt = dateMs(result.started_at);
	const finishedAt = dateMs(result.finished_at);
	const wallElapsedMs =
		startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined;
	return buildReport(trials, expectedTrials, wallElapsedMs, options);
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

function parseCoverageResources(value: unknown, index: number): DeepSweTrialResources {
	const resources = record(value);
	const trialElapsedMs = parseTrialResource(resources?.trialElapsedMs);
	const inputTokens = parseTrialResource(resources?.inputTokens);
	const cacheTokens = parseTrialResource(resources?.cacheTokens);
	const outputTokens = parseTrialResource(resources?.outputTokens);
	const costUsd = parseTrialCost(resources?.costUsd);
	const turnCount = parseTrialResource(resources?.turnCount);
	const agentElapsedMs = parseTrialResource(resources?.agentElapsedMs);
	if (!trialElapsedMs || !inputTokens || !cacheTokens || !outputTokens || !costUsd || !turnCount || !agentElapsedMs) {
		throw new Error(`DeepSWE schema v2 report trial[${index}].resources is invalid`);
	}
	return { trialElapsedMs, inputTokens, cacheTokens, outputTokens, costUsd, turnCount, agentElapsedMs };
}

function projectStoredTrial(
	value: unknown,
	index: number,
	usedAttemptIndexes: Map<string, Set<number>>,
	coverageAware: boolean,
): DeepSweTrialReport {
	const trial = record(value);
	const taskId = textValue(trial?.taskId);
	const trialName = textValue(trial?.trialName);
	const status = legacyStatus(trial?.status);
	if (!trial || !taskId || !trialName || !status) throw new Error(`Stored DeepSWE report trial[${index}] is invalid`);
	const attemptIdentity = claimAttemptIdentity(trial, index, taskId, usedAttemptIndexes, "DeepSWE report trial");
	const elapsedMs = nonNegativeNumber(trial.elapsedMs);
	const inputTokens = nonNegativeNumber(trial.inputTokens);
	const cacheTokens = nonNegativeNumber(trial.cacheTokens);
	const outputTokens = nonNegativeNumber(trial.outputTokens);
	const costUsd = nonNegativeNumber(trial.costUsd);
	const turnCount = nonNegativeNumber(trial.turnCount);
	const agentElapsedMs = nonNegativeNumber(trial.agentElapsedMs);
	const resources: DeepSweTrialResources = coverageAware
		? parseCoverageResources(trial.resources, index)
		: {
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
		...attemptIdentity,
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

/** Reads schema v3 reports and upgrades coverage-aware v2 plus legacy round 5-11 schema v1. */
export function readDeepSweEvaluationReport(input: unknown): DeepSweEvaluationReport {
	const report = record(input);
	if (!report || report.benchmark !== "deep-swe") throw new Error("DeepSWE report must use benchmark deep-swe");
	if (report.schemaVersion === DEEP_SWE_REPORT_SCHEMA_VERSION) {
		if (!record(report.summary) || !record(report.sampling) || !Array.isArray(report.trials)) {
			throw new Error("DeepSWE schema v3 report is invalid");
		}
		return report as unknown as DeepSweEvaluationReport;
	}
	if ((report.schemaVersion !== 1 && report.schemaVersion !== 2) || !Array.isArray(report.trials)) {
		throw new Error(`Unsupported DeepSWE report schema version: ${String(report.schemaVersion)}`);
	}
	const usedAttemptIndexes = new Map<string, Set<number>>();
	const trials = report.trials.map((trial, index) =>
		projectStoredTrial(
			trial,
			index,
			usedAttemptIndexes,
			report.schemaVersion === 2 && record(trial)?.resources !== undefined,
		),
	);
	const summary = record(report.summary);
	const sampling = record(report.sampling);
	const expectedTrials = Math.max(
		positiveInteger(summary?.expectedTrials) ?? 0,
		positiveInteger(sampling?.expectedTrials) ?? 0,
		positiveInteger(summary?.trials) ?? 0,
		trials.length,
	);
	const wallElapsedMs =
		summary?.wallElapsedStatus === "complete" ? nonNegativeNumber(summary.wallElapsedMs) : undefined;
	return buildReport(trials, expectedTrials, wallElapsedMs);
}

function requirePositiveRound(value: number): void {
	if (!Number.isInteger(value) || value < 1) throw new Error("round must be a positive integer");
}

function experimentRoundInput(input: DeepSweRoundReport): DeepSweExperimentRoundInput {
	const experiment = input.experiment;
	const plannedTrials =
		experiment?.plannedTrials ??
		input.report.trials.map(({ attemptId: id, taskId, attemptIndex }) => ({
			id,
			taskId,
			attemptIndex,
			agentIndex: 1,
		}));
	const seedScheme =
		experiment?.seed.availability === "available"
			? experiment.seed.scheme
			: experiment?.seed.availability === "unavailable"
				? "unavailable"
				: undefined;
	return {
		round: input.round,
		harnessRevision: input.harnessRevision,
		controls: {
			harnessRevisionRecorded: input.harnessRevision === "unknown" ? undefined : true,
			datasetRevision: input.datasetRevision,
			pierRevision: input.pierRevision,
			concurrency: input.concurrency,
			model: input.model,
			reasoningEffort: input.reasoningEffort,
			maxOutputTokens: input.maxOutputTokens,
			runBudgetEnabled: input.runBudgetEnabled,
			maxTurns: input.runBudgetEnabled === false ? "disabled" : input.maxTurns,
			allowAllCommands: input.allowAllCommands,
			timeBlock: experiment?.timeBlock,
			attemptIdentityScheme: experiment?.attemptIdentityScheme,
			seedAvailability: experiment?.seed.availability,
			seedScheme,
		},
		plannedTrials,
		trials: input.report.trials,
	};
}

export function compareDeepSweRounds(inputs: readonly DeepSweRoundReport[]): DeepSweCampaignReport {
	if (inputs.length === 0) throw new Error("DeepSWE comparison requires at least one round");
	const ordered = [...inputs].sort((left, right) => left.round - right.round);
	if (new Set(ordered.map(({ round }) => round)).size !== ordered.length) {
		throw new Error("DeepSWE comparison round numbers must be unique");
	}
	for (const input of ordered) requirePositiveRound(input.round);

	const taskIds = [
		...new Set(ordered.flatMap(({ report }) => report.sampling.tasks.map(({ taskId }) => taskId))),
	].sort();
	const trialsByRoundAndTask = new Map<number, ReadonlyMap<string, readonly DeepSweTrialReport[]>>();
	const samplingByRoundAndTask = new Map<number, ReadonlyMap<string, DeepSweTaskSamplingSummary>>();
	for (const { round, report } of ordered) {
		const trialsByTask = new Map<string, DeepSweTrialReport[]>();
		for (const trial of report.trials) {
			const taskTrials = trialsByTask.get(trial.taskId) ?? [];
			taskTrials.push(trial);
			trialsByTask.set(trial.taskId, taskTrials);
		}
		trialsByRoundAndTask.set(round, trialsByTask);
		samplingByRoundAndTask.set(round, new Map(report.sampling.tasks.map((sampling) => [sampling.taskId, sampling])));
	}
	return Object.freeze({
		schemaVersion: DEEP_SWE_REPORT_SCHEMA_VERSION,
		benchmark: "deep-swe",
		campaignKind: "development-rounds",
		rounds: ordered.map((current, index) => {
			const previous = ordered[index - 1];
			return {
				round: current.round,
				harnessRevision: current.harnessRevision,
				...(current.concurrency !== undefined ? { concurrency: current.concurrency } : {}),
				...(current.model !== undefined ? { model: current.model } : {}),
				...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
				...(current.datasetRevision !== undefined ? { datasetRevision: current.datasetRevision } : {}),
				...(current.pierRevision !== undefined ? { pierRevision: current.pierRevision } : {}),
				...(current.maxOutputTokens !== undefined ? { maxOutputTokens: current.maxOutputTokens } : {}),
				...(current.maxTurns !== undefined ? { maxTurns: current.maxTurns } : {}),
				...(current.runBudgetEnabled !== undefined ? { runBudgetEnabled: current.runBudgetEnabled } : {}),
				...(current.allowAllCommands !== undefined ? { allowAllCommands: current.allowAllCommands } : {}),
				...(current.experiment !== undefined ? { experiment: current.experiment } : {}),
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
			rounds: ordered.flatMap(({ round }) => {
				const sampling = samplingByRoundAndTask.get(round)?.get(taskId);
				if (!sampling) return [];
				const trials = trialsByRoundAndTask.get(round)?.get(taskId) ?? [];
				return [
					{
						round,
						sampling,
						trials: trials.map((trial) => ({
							attemptIndex: trial.attemptIndex,
							attemptId: trial.attemptId,
							attemptIdentitySource: trial.attemptIdentitySource,
							trialName: trial.trialName,
							status: trial.status,
							...(trial.reward !== undefined ? { reward: trial.reward } : {}),
							...(trial.partial !== undefined ? { partial: trial.partial } : {}),
							...(trial.costUsd !== undefined ? { costUsd: trial.costUsd } : {}),
							...(trial.turnCount !== undefined ? { turnCount: trial.turnCount } : {}),
						})),
					},
				];
			}),
		})),
		comparisons: compareDeepSweExperimentRounds(ordered.map(experimentRoundInput)),
	});
}
