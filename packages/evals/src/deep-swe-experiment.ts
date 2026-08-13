export const DEEP_SWE_ATTEMPT_IDENTITY_SCHEME = "task-attempt-agent-v1" as const;
export const DEEP_SWE_SAMPLING_SCHEMA_VERSION = 1 as const;
export const DEEP_SWE_SUCCESS_DEFINITION =
	"success means a settled Pier trial with verifier reward 1 and no infrastructure exception";
export const DEEP_SWE_INTERVAL_DEFINITION =
	"two-sided 95% Wilson score interval for the Bernoulli probability of single-trial success";
export const DEEP_SWE_PASS_AT_K_DEFINITION =
	"empirical probability that at least one of k trials succeeds when k trials are drawn without replacement from the n observed trials: 1 - C(n - successes, k) / C(n, k)";

const WILSON_95_Z = 1.959_963_984_540_054;

export type DeepSweTrialStatus = "passed" | "failed" | "error";

export interface DeepSweBinaryTrial {
	readonly taskId: string;
	readonly trialName: string;
	readonly status: DeepSweTrialStatus;
	readonly attemptIndex: number;
	readonly attemptId: string;
}

export interface DeepSwePlannedTrial {
	readonly id: string;
	readonly taskId: string;
	readonly attemptIndex: number;
	readonly agentIndex: number;
}

export type DeepSweSeedAvailability =
	| {
			readonly availability: "available";
			readonly scheme: string;
	  }
	| {
			readonly availability: "unavailable";
			readonly reason: string;
	  }
	| {
			readonly availability: "unknown";
			readonly reason: string;
	  };

export interface DeepSweExperimentPlan {
	readonly timeBlock: string;
	readonly attempts: number;
	readonly agentCount: number;
	readonly totalPlannedPaidTrials: number;
	readonly attemptIdentityScheme: typeof DEEP_SWE_ATTEMPT_IDENTITY_SCHEME;
	readonly plannedTrials: readonly DeepSwePlannedTrial[];
	readonly seed: DeepSweSeedAvailability;
}

export interface DeepSweWilsonInterval {
	readonly confidenceLevel: 0.95;
	readonly method: "wilson-score";
	readonly lower: number;
	readonly upper: number;
}

export interface DeepSwePassAtK {
	readonly k: number;
	readonly value: number;
}

export interface DeepSweTaskSamplingSummary {
	readonly taskId: string;
	readonly expectedN: number;
	readonly n: number;
	readonly missing: number;
	readonly unplanned: number;
	readonly successes: number;
	readonly failed: number;
	readonly errors: number;
	readonly meanSuccess: number | null;
	readonly sampleVariance: number | null;
	readonly interval: DeepSweWilsonInterval | null;
	readonly passAtK: readonly DeepSwePassAtK[];
}

export interface DeepSweRepeatedSamplingSummary {
	readonly schemaVersion: typeof DEEP_SWE_SAMPLING_SCHEMA_VERSION;
	readonly definitions: {
		readonly success: typeof DEEP_SWE_SUCCESS_DEFINITION;
		readonly interval: typeof DEEP_SWE_INTERVAL_DEFINITION;
		readonly passAtK: typeof DEEP_SWE_PASS_AT_K_DEFINITION;
	};
	readonly expectedTrials: number;
	readonly observedTrials: number;
	readonly missingTrials: number;
	readonly unplannedTrials: number;
	readonly successes: number;
	readonly microMeanSuccess: number | null;
	readonly macroMeanSuccess: number | null;
	readonly interval: DeepSweWilsonInterval | null;
	readonly tasks: readonly DeepSweTaskSamplingSummary[];
}

export type DeepSweComparisonControlValue = string | number | boolean;

export interface DeepSweExperimentRoundInput {
	readonly round: number;
	readonly harnessRevision: string;
	readonly controls: Readonly<Record<string, DeepSweComparisonControlValue | undefined>>;
	readonly plannedTrials: readonly DeepSwePlannedTrial[];
	readonly trials: readonly DeepSweBinaryTrial[];
}

export interface DeepSweComparisonMismatch {
	readonly field: string;
	readonly baseline: DeepSweComparisonControlValue | null;
	readonly candidate: DeepSweComparisonControlValue | null;
}

export interface DeepSweMatchedPair {
	readonly attemptId: string;
	readonly taskId: string;
	readonly baseline: {
		readonly trialName: string;
		readonly status: DeepSweTrialStatus;
	};
	readonly candidate: {
		readonly trialName: string;
		readonly status: DeepSweTrialStatus;
	};
}

export interface DeepSweUnmatchedTrial {
	readonly attemptId: string;
	readonly taskId: string;
	readonly trialName: string;
	readonly status: DeepSweTrialStatus;
}

export interface DeepSweComparisonMatching {
	readonly matched: readonly DeepSweMatchedPair[];
	readonly unmatched: {
		readonly baseline: readonly DeepSweUnmatchedTrial[];
		readonly candidate: readonly DeepSweUnmatchedTrial[];
	};
	readonly missing: {
		readonly baseline: readonly DeepSwePlannedTrial[];
		readonly candidate: readonly DeepSwePlannedTrial[];
	};
}

export interface DeepSwePairedAggregate {
	readonly status: "available" | "incompatible" | "no-matched-trials";
	readonly eligiblePairs: number;
	readonly baselineMeanSuccess?: number;
	readonly candidateMeanSuccess?: number;
	readonly meanDifference?: number;
	readonly transitions?: {
		readonly bothPassed: number;
		readonly bothNotPassed: number;
		readonly baselineOnlyPassed: number;
		readonly candidateOnlyPassed: number;
	};
}

export interface DeepSweStratifiedTaskAggregate {
	readonly taskId: string;
	readonly baselineN: number;
	readonly candidateN: number;
	readonly baselineMeanSuccess: number;
	readonly candidateMeanSuccess: number;
	readonly meanDifference: number;
}

export interface DeepSweStratifiedAggregate {
	readonly status: "available" | "incompatible" | "no-common-task-strata";
	readonly taskStrata: number;
	readonly baselineMacroMeanSuccess?: number;
	readonly candidateMacroMeanSuccess?: number;
	readonly macroMeanDifference?: number;
	readonly tasks: readonly DeepSweStratifiedTaskAggregate[];
}

export interface DeepSweInstabilityEstimate {
	readonly kind:
		| "same-revision-variability-estimate"
		| "observed-cross-revision-instability"
		| "observed-incompatible-same-revision-instability";
	readonly definition: string;
	readonly matchedTrials: number;
	readonly statusFlips: number;
	readonly observedFlipRate: number | null;
	readonly interval: DeepSweWilsonInterval | null;
	readonly estimatesPureSamplingVariability: boolean;
}

export interface DeepSweExperimentComparison {
	readonly baselineRound: number;
	readonly candidateRound: number;
	readonly baselineHarnessRevision: string;
	readonly candidateHarnessRevision: string;
	readonly compatibility: {
		readonly compatible: boolean;
		readonly mismatches: readonly DeepSweComparisonMismatch[];
	};
	readonly matching: DeepSweComparisonMatching;
	readonly paired: DeepSwePairedAggregate;
	readonly stratified: DeepSweStratifiedAggregate;
	readonly instability: DeepSweInstabilityEstimate;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}

function safeProduct(values: readonly number[], name: string): number {
	const result = values.reduce((product, value) => product * value, 1);
	if (!Number.isSafeInteger(result)) throw new Error(`${name} exceeds the safe integer range`);
	return result;
}

export function createDeepSweAttemptId(taskId: string, attemptIndex: number, agentIndex: number): string {
	if (!taskId || taskId.includes("::")) throw new Error("taskId must be a non-empty unambiguous identity");
	positiveInteger(attemptIndex, "attemptIndex");
	positiveInteger(agentIndex, "agentIndex");
	return `${taskId}::attempt-${String(attemptIndex).padStart(3, "0")}::agent-${String(agentIndex).padStart(3, "0")}`;
}

export function createDeepSwePlannedTrials(
	taskIds: readonly string[],
	attempts: number,
	agentCount: number,
): readonly DeepSwePlannedTrial[] {
	positiveInteger(attempts, "attempts");
	positiveInteger(agentCount, "agentCount");
	if (taskIds.length === 0) throw new Error("taskIds must contain at least one task id");
	if (new Set(taskIds).size !== taskIds.length) throw new Error("taskIds must be unique");
	const planned: DeepSwePlannedTrial[] = [];
	for (let attemptIndex = 1; attemptIndex <= attempts; attemptIndex++) {
		for (const taskId of taskIds) {
			for (let agentIndex = 1; agentIndex <= agentCount; agentIndex++) {
				planned.push({
					id: createDeepSweAttemptId(taskId, attemptIndex, agentIndex),
					taskId,
					attemptIndex,
					agentIndex,
				});
			}
		}
	}
	return Object.freeze(planned);
}

export function createDeepSweExperimentPlan(options: {
	readonly taskIds: readonly string[];
	readonly attempts: number;
	readonly agentCount: number;
	readonly timeBlock: string;
	readonly seed: DeepSweSeedAvailability;
}): DeepSweExperimentPlan {
	const attempts = positiveInteger(options.attempts, "attempts");
	const agentCount = positiveInteger(options.agentCount, "agentCount");
	if (!options.timeBlock.trim()) throw new Error("timeBlock must not be empty");
	return Object.freeze({
		timeBlock: options.timeBlock,
		attempts,
		agentCount,
		totalPlannedPaidTrials: safeProduct([options.taskIds.length, attempts, agentCount], "total planned paid trials"),
		attemptIdentityScheme: DEEP_SWE_ATTEMPT_IDENTITY_SCHEME,
		plannedTrials: createDeepSwePlannedTrials(options.taskIds, attempts, agentCount),
		seed: options.seed,
	});
}

export function wilsonInterval(successes: number, n: number): DeepSweWilsonInterval | null {
	if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0 || successes > n) {
		throw new Error("Wilson interval requires integer successes with 0 <= successes <= n");
	}
	if (n === 0) return null;
	const proportion = successes / n;
	const zSquared = WILSON_95_Z * WILSON_95_Z;
	const denominator = 1 + zSquared / n;
	const center = (proportion + zSquared / (2 * n)) / denominator;
	const margin = (WILSON_95_Z / denominator) * Math.sqrt((proportion * (1 - proportion)) / n + zSquared / (4 * n * n));
	return {
		confidenceLevel: 0.95,
		method: "wilson-score",
		lower: Math.max(0, center - margin),
		upper: Math.min(1, center + margin),
	};
}

function passAtK(successes: number, n: number): readonly DeepSwePassAtK[] {
	const failed = n - successes;
	return Object.freeze(
		Array.from({ length: n }, (_, index) => {
			const k = index + 1;
			if (k === 1) return { k, value: successes / n };
			if (failed < k) return { k, value: 1 };
			let allFailedProbability = 1;
			for (let draw = 0; draw < k; draw++) {
				allFailedProbability *= (failed - draw) / (n - draw);
			}
			return { k, value: 1 - allFailedProbability };
		}),
	);
}

function uniqueMap<T>(values: readonly T[], key: (value: T) => string, name: string): ReadonlyMap<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const identity = key(value);
		if (result.has(identity)) throw new Error(`${name} contains duplicate identity ${identity}`);
		result.set(identity, value);
	}
	return result;
}

function taskSamplingSummary(
	taskId: string,
	trials: readonly DeepSweBinaryTrial[],
	planned: readonly DeepSwePlannedTrial[],
	hasPlan: boolean,
): DeepSweTaskSamplingSummary {
	const plannedIds = new Set(planned.map(({ id }) => id));
	const observedIds = new Set(trials.map(({ attemptId: id }) => id));
	const successes = trials.filter(({ status }) => status === "passed").length;
	const errors = trials.filter(({ status }) => status === "error").length;
	const n = trials.length;
	const meanSuccess = n === 0 ? null : successes / n;
	return {
		taskId,
		expectedN: hasPlan ? planned.length : n,
		n,
		missing: hasPlan ? planned.filter(({ id }) => !observedIds.has(id)).length : 0,
		unplanned: hasPlan ? trials.filter(({ attemptId: id }) => !plannedIds.has(id)).length : 0,
		successes,
		failed: n - successes - errors,
		errors,
		meanSuccess,
		sampleVariance: n < 2 ? null : (successes * (n - successes)) / (n * (n - 1)),
		interval: wilsonInterval(successes, n),
		passAtK: passAtK(successes, n),
	};
}

export function summarizeDeepSweRepeatedTrials(
	trials: readonly DeepSweBinaryTrial[],
	plannedTrials: readonly DeepSwePlannedTrial[] = [],
): DeepSweRepeatedSamplingSummary {
	uniqueMap(trials, ({ attemptId: id }) => id, "DeepSWE trials");
	uniqueMap(plannedTrials, ({ id }) => id, "DeepSWE planned trials");
	const hasPlan = plannedTrials.length > 0;
	const trialsByTask = new Map<string, DeepSweBinaryTrial[]>();
	const plannedByTask = new Map<string, DeepSwePlannedTrial[]>();
	for (const trial of trials) {
		const taskTrials = trialsByTask.get(trial.taskId) ?? [];
		taskTrials.push(trial);
		trialsByTask.set(trial.taskId, taskTrials);
	}
	for (const planned of plannedTrials) {
		const taskTrials = plannedByTask.get(planned.taskId) ?? [];
		taskTrials.push(planned);
		plannedByTask.set(planned.taskId, taskTrials);
	}
	const taskIds = [...new Set([...trialsByTask.keys(), ...plannedByTask.keys()])].sort();
	const tasks = taskIds.map((taskId) =>
		taskSamplingSummary(taskId, trialsByTask.get(taskId) ?? [], plannedByTask.get(taskId) ?? [], hasPlan),
	);
	const successes = trials.filter(({ status }) => status === "passed").length;
	const observedMeans = tasks.flatMap(({ meanSuccess }) => (meanSuccess === null ? [] : [meanSuccess]));
	return Object.freeze({
		schemaVersion: DEEP_SWE_SAMPLING_SCHEMA_VERSION,
		definitions: {
			success: DEEP_SWE_SUCCESS_DEFINITION,
			interval: DEEP_SWE_INTERVAL_DEFINITION,
			passAtK: DEEP_SWE_PASS_AT_K_DEFINITION,
		} as const,
		expectedTrials: hasPlan ? plannedTrials.length : trials.length,
		observedTrials: trials.length,
		missingTrials: tasks.reduce((sum, task) => sum + task.missing, 0),
		unplannedTrials: tasks.reduce((sum, task) => sum + task.unplanned, 0),
		successes,
		microMeanSuccess: trials.length === 0 ? null : successes / trials.length,
		macroMeanSuccess:
			observedMeans.length === 0
				? null
				: observedMeans.reduce((sum, value) => sum + value, 0) / observedMeans.length,
		interval: wilsonInterval(successes, trials.length),
		tasks,
	});
}

function comparisonCompatibility(
	baseline: DeepSweExperimentRoundInput,
	candidate: DeepSweExperimentRoundInput,
): DeepSweExperimentComparison["compatibility"] {
	const fields = [...new Set([...Object.keys(baseline.controls), ...Object.keys(candidate.controls)])].sort();
	const mismatches: DeepSweComparisonMismatch[] = [];
	for (const field of fields) {
		const baselineValue = baseline.controls[field];
		const candidateValue = candidate.controls[field];
		if (baselineValue === undefined || candidateValue === undefined || baselineValue !== candidateValue) {
			mismatches.push({
				field,
				baseline: baselineValue ?? null,
				candidate: candidateValue ?? null,
			});
		}
	}
	return { compatible: mismatches.length === 0, mismatches };
}

function trialSuccess(status: DeepSweTrialStatus): number {
	return status === "passed" ? 1 : 0;
}

function matchedPairs(
	baselineTrials: ReadonlyMap<string, DeepSweBinaryTrial>,
	candidateTrials: ReadonlyMap<string, DeepSweBinaryTrial>,
): readonly DeepSweMatchedPair[] {
	const pairs: DeepSweMatchedPair[] = [];
	for (const attemptIdentity of [...baselineTrials.keys()].sort()) {
		const baseline = baselineTrials.get(attemptIdentity);
		const candidate = candidateTrials.get(attemptIdentity);
		if (!baseline || !candidate) continue;
		if (baseline.taskId !== candidate.taskId) {
			throw new Error(`DeepSWE attempt identity ${attemptIdentity} refers to different tasks`);
		}
		pairs.push({
			attemptId: attemptIdentity,
			taskId: baseline.taskId,
			baseline: { trialName: baseline.trialName, status: baseline.status },
			candidate: { trialName: candidate.trialName, status: candidate.status },
		});
	}
	return Object.freeze(pairs);
}

function unmatchedTrials(
	own: ReadonlyMap<string, DeepSweBinaryTrial>,
	other: ReadonlyMap<string, DeepSweBinaryTrial>,
): readonly DeepSweUnmatchedTrial[] {
	return Object.freeze(
		[...own.values()]
			.filter(({ attemptId: id }) => !other.has(id))
			.sort((left, right) => left.attemptId.localeCompare(right.attemptId))
			.map(({ attemptId: id, taskId, trialName, status }) => ({ attemptId: id, taskId, trialName, status })),
	);
}

function missingTrials(
	planned: ReadonlyMap<string, DeepSwePlannedTrial>,
	observed: ReadonlyMap<string, DeepSweBinaryTrial>,
): readonly DeepSwePlannedTrial[] {
	return Object.freeze(
		[...planned.values()]
			.filter(({ id }) => !observed.has(id))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

function pairedAggregate(compatible: boolean, pairs: readonly DeepSweMatchedPair[]): DeepSwePairedAggregate {
	if (!compatible) return { status: "incompatible", eligiblePairs: 0 };
	if (pairs.length === 0) return { status: "no-matched-trials", eligiblePairs: 0 };
	let baselineSuccesses = 0;
	let candidateSuccesses = 0;
	let bothPassed = 0;
	let bothNotPassed = 0;
	let baselineOnlyPassed = 0;
	let candidateOnlyPassed = 0;
	for (const pair of pairs) {
		const baseline = trialSuccess(pair.baseline.status);
		const candidate = trialSuccess(pair.candidate.status);
		baselineSuccesses += baseline;
		candidateSuccesses += candidate;
		if (baseline === 1 && candidate === 1) bothPassed++;
		else if (baseline === 0 && candidate === 0) bothNotPassed++;
		else if (baseline === 1) baselineOnlyPassed++;
		else candidateOnlyPassed++;
	}
	return {
		status: "available",
		eligiblePairs: pairs.length,
		baselineMeanSuccess: baselineSuccesses / pairs.length,
		candidateMeanSuccess: candidateSuccesses / pairs.length,
		meanDifference: (candidateSuccesses - baselineSuccesses) / pairs.length,
		transitions: { bothPassed, bothNotPassed, baselineOnlyPassed, candidateOnlyPassed },
	};
}

function groupTrialsByTask(trials: readonly DeepSweBinaryTrial[]): ReadonlyMap<string, readonly DeepSweBinaryTrial[]> {
	const grouped = new Map<string, DeepSweBinaryTrial[]>();
	for (const trial of trials) {
		const taskTrials = grouped.get(trial.taskId) ?? [];
		taskTrials.push(trial);
		grouped.set(trial.taskId, taskTrials);
	}
	return grouped;
}

function stratifiedAggregate(
	compatible: boolean,
	baselineTrials: readonly DeepSweBinaryTrial[],
	candidateTrials: readonly DeepSweBinaryTrial[],
): DeepSweStratifiedAggregate {
	if (!compatible) return { status: "incompatible", taskStrata: 0, tasks: [] };
	const baselineByTask = groupTrialsByTask(baselineTrials);
	const candidateByTask = groupTrialsByTask(candidateTrials);
	const commonTaskIds = [...baselineByTask.keys()]
		.filter((taskId) => (candidateByTask.get(taskId)?.length ?? 0) > 0)
		.sort();
	const tasks = commonTaskIds.map<DeepSweStratifiedTaskAggregate>((taskId) => {
		const baseline = baselineByTask.get(taskId) ?? [];
		const candidate = candidateByTask.get(taskId) ?? [];
		const baselineMeanSuccess = baseline.filter(({ status }) => status === "passed").length / baseline.length;
		const candidateMeanSuccess = candidate.filter(({ status }) => status === "passed").length / candidate.length;
		return {
			taskId,
			baselineN: baseline.length,
			candidateN: candidate.length,
			baselineMeanSuccess,
			candidateMeanSuccess,
			meanDifference: candidateMeanSuccess - baselineMeanSuccess,
		};
	});
	if (tasks.length === 0) return { status: "no-common-task-strata", taskStrata: 0, tasks };
	const baselineMacroMeanSuccess = tasks.reduce((sum, task) => sum + task.baselineMeanSuccess, 0) / tasks.length;
	const candidateMacroMeanSuccess = tasks.reduce((sum, task) => sum + task.candidateMeanSuccess, 0) / tasks.length;
	return {
		status: "available",
		taskStrata: tasks.length,
		baselineMacroMeanSuccess,
		candidateMacroMeanSuccess,
		macroMeanDifference: candidateMacroMeanSuccess - baselineMacroMeanSuccess,
		tasks,
	};
}

function instabilityEstimate(
	baseline: DeepSweExperimentRoundInput,
	candidate: DeepSweExperimentRoundInput,
	compatible: boolean,
	pairs: readonly DeepSweMatchedPair[],
): DeepSweInstabilityEstimate {
	const statusFlips = pairs.filter(
		(pair) => trialSuccess(pair.baseline.status) !== trialSuccess(pair.candidate.status),
	).length;
	const sameRevision = baseline.harnessRevision === candidate.harnessRevision;
	const estimatesPureSamplingVariability = sameRevision && compatible;
	const kind: DeepSweInstabilityEstimate["kind"] = !sameRevision
		? "observed-cross-revision-instability"
		: compatible
			? "same-revision-variability-estimate"
			: "observed-incompatible-same-revision-instability";
	const definition = estimatesPureSamplingVariability
		? "status flips among identity-matched trials under the same harness revision and compatible experiment controls"
		: !sameRevision
			? "status flips among identity-matched trials across different harness revisions; this is observed cross-revision instability, not a pure sampling flip rate"
			: "status flips under the same harness revision but incompatible experiment controls; this does not isolate pure sampling variability";
	return {
		kind,
		definition,
		matchedTrials: pairs.length,
		statusFlips,
		observedFlipRate: pairs.length === 0 ? null : statusFlips / pairs.length,
		interval: wilsonInterval(statusFlips, pairs.length),
		estimatesPureSamplingVariability,
	};
}

export function compareDeepSweExperimentPair(
	baseline: DeepSweExperimentRoundInput,
	candidate: DeepSweExperimentRoundInput,
): DeepSweExperimentComparison {
	const baselineTrials = uniqueMap(baseline.trials, ({ attemptId: id }) => id, "baseline DeepSWE trials");
	const candidateTrials = uniqueMap(candidate.trials, ({ attemptId: id }) => id, "candidate DeepSWE trials");
	const baselinePlan = uniqueMap(baseline.plannedTrials, ({ id }) => id, "baseline DeepSWE plan");
	const candidatePlan = uniqueMap(candidate.plannedTrials, ({ id }) => id, "candidate DeepSWE plan");
	const compatibility = comparisonCompatibility(baseline, candidate);
	const matched = matchedPairs(baselineTrials, candidateTrials);
	return Object.freeze({
		baselineRound: baseline.round,
		candidateRound: candidate.round,
		baselineHarnessRevision: baseline.harnessRevision,
		candidateHarnessRevision: candidate.harnessRevision,
		compatibility,
		matching: {
			matched,
			unmatched: {
				baseline: unmatchedTrials(baselineTrials, candidateTrials),
				candidate: unmatchedTrials(candidateTrials, baselineTrials),
			},
			missing: {
				baseline: missingTrials(baselinePlan, baselineTrials),
				candidate: missingTrials(candidatePlan, candidateTrials),
			},
		},
		paired: pairedAggregate(compatibility.compatible, matched),
		stratified: stratifiedAggregate(compatibility.compatible, baseline.trials, candidate.trials),
		instability: instabilityEstimate(baseline, candidate, compatibility.compatible, matched),
	});
}

export function compareDeepSweExperimentRounds(
	rounds: readonly DeepSweExperimentRoundInput[],
): readonly DeepSweExperimentComparison[] {
	const comparisons: DeepSweExperimentComparison[] = [];
	for (let index = 1; index < rounds.length; index++) {
		const baseline = rounds[index - 1];
		const candidate = rounds[index];
		if (baseline && candidate) comparisons.push(compareDeepSweExperimentPair(baseline, candidate));
	}
	return Object.freeze(comparisons);
}
