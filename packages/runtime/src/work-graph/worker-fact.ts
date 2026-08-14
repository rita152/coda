import type {
	ActiveRun,
	RunBudget,
	RunBudgetExhaustion,
	RunFailure,
	RunLimits,
	RunOutcome,
	RunSource,
	ToolExecutionOutcome,
	ToolExecutionSettlement,
} from "@coda/agent";

const MAXIMUM_ID_LENGTH = 256;
export const MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH = 128;

interface FactBase {
	readonly runId: string;
	readonly timestamp: number;
}

export type WorkerFact =
	| (FactBase & {
			readonly type: "run_started";
			readonly source: RunSource;
			readonly queueItemId?: string;
			readonly budget?: RunBudget;
	  })
	| (FactBase & {
			readonly type: "attempt_started";
			readonly turnId: string;
			readonly attemptId: string;
			readonly messageId: string;
			readonly attempt: number;
	  })
	| (FactBase & {
			readonly type: "attempt_settled";
			readonly turnId: string;
			readonly attemptId: string;
			readonly messageId: string;
			readonly attempt: number;
			readonly outcome: "success" | "error" | "aborted";
			readonly discarded: boolean;
			readonly totalTokens: number;
	  })
	| (FactBase & {
			readonly type: "tool_started";
			readonly turnId: string;
			readonly invocationId: string;
			readonly toolName: string;
			readonly replaySafety: "never" | "safe";
	  })
	| (FactBase & {
			readonly type: "tool_settled";
			readonly turnId: string;
			readonly invocationId: string;
			readonly settlement: ToolExecutionSettlement;
			readonly outcome: ToolExecutionOutcome;
	  })
	| (FactBase & {
			readonly type: "turn_settled";
			readonly turnId: string;
			readonly outcome: RunOutcome;
	  })
	| (FactBase & {
			readonly type: "budget_exhausted";
			readonly exhaustion: RunBudgetExhaustion;
	  })
	| (FactBase & {
			readonly type: "run_settled";
			readonly outcome: RunOutcome;
			readonly failureKind?: RunFailure["kind"];
	  });

export interface OpenAttemptEffect {
	readonly runId: string;
	readonly turnId: string;
	readonly attemptId: string;
	readonly messageId: string;
	readonly attempt: number;
}

export interface OpenToolEffect {
	readonly runId: string;
	readonly turnId: string;
	readonly invocationId: string;
}

export interface WorkerFactProjection {
	readonly activeRun?: ActiveRun;
	readonly modelAttempts: number;
	readonly toolInvocations: number;
	readonly totalTokens: number;
	readonly exhaustion?: RunBudgetExhaustion;
	readonly openAttempts: readonly OpenAttemptEffect[];
	readonly openTools: readonly OpenToolEffect[];
}

export const INITIAL_WORKER_FACT_PROJECTION: WorkerFactProjection = Object.freeze({
	modelAttempts: 0,
	toolInvocations: 0,
	totalTokens: 0,
	openAttempts: Object.freeze([]),
	openTools: Object.freeze([]),
});

const FACT_KEYS = {
	run_started: ["type", "runId", "source", "queueItemId", "budget", "timestamp"],
	attempt_started: ["type", "runId", "turnId", "attemptId", "messageId", "attempt", "timestamp"],
	attempt_settled: [
		"type",
		"runId",
		"turnId",
		"attemptId",
		"messageId",
		"attempt",
		"outcome",
		"discarded",
		"totalTokens",
		"timestamp",
	],
	tool_started: ["type", "runId", "turnId", "invocationId", "toolName", "replaySafety", "timestamp"],
	tool_settled: ["type", "runId", "turnId", "invocationId", "settlement", "outcome", "timestamp"],
	turn_settled: ["type", "runId", "turnId", "outcome", "timestamp"],
	budget_exhausted: ["type", "runId", "exhaustion", "timestamp"],
	run_settled: ["type", "runId", "outcome", "failureKind", "timestamp"],
} as const satisfies Record<WorkerFact["type"], readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(type: string, diagnostic: string): never {
	throw new Error(`Invalid Worker Fact ${type}: ${diagnostic}`);
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	type: string,
	optional: readonly string[] = [],
): void {
	const admitted = new Set(allowed);
	const omitted = new Set(optional);
	for (const key of Object.keys(value)) {
		if (!admitted.has(key)) invalid(type, `unexpected field ${key}`);
	}
	for (const key of allowed) {
		if (omitted.has(key)) continue;
		if (!(key in value)) invalid(type, `missing field ${key}`);
	}
}

const RUN_LIMIT_KEYS = [
	"maxTurns",
	"maxModelAttempts",
	"maxToolInvocations",
	"maxElapsedMs",
	"maxTotalTokens",
	"maxTotalCostUsd",
	"maxConsecutiveEquivalentToolBatches",
] as const satisfies readonly (keyof RunLimits)[];

function assertRunBudget(value: unknown, type: string): asserts value is RunBudget {
	if (!isRecord(value)) invalid(type, "budget must be an object");
	assertExactKeys(value, ["limits"], type);
	if (!isRecord(value.limits)) invalid(type, "budget.limits must be an object");
	assertExactKeys(value.limits, RUN_LIMIT_KEYS, type, RUN_LIMIT_KEYS);
	for (const key of RUN_LIMIT_KEYS) {
		const limit = value.limits[key];
		if (limit === undefined) continue;
		if (key === "maxTotalCostUsd") {
			if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
				invalid(type, `budget.limits.${key} must be a positive finite number`);
			}
			continue;
		}
		if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
			invalid(type, `budget.limits.${key} must be a positive safe integer`);
		}
	}
}

function assertId(value: unknown, field: string, type: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_ID_LENGTH) {
		invalid(type, `${field} must be a non-empty string of at most ${MAXIMUM_ID_LENGTH} characters`);
	}
}

function assertTimestamp(value: unknown, type: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		invalid(type, "timestamp must be a non-negative safe integer");
}

function assertCounter(value: unknown, field: string, type: string, minimum = 0): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		invalid(type, `${field} must be a safe integer greater than or equal to ${minimum}`);
	}
}

function assertOneOf<T extends string>(
	value: unknown,
	field: string,
	type: string,
	values: readonly T[],
): asserts value is T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		invalid(type, `${field} has an unsupported value`);
	}
}

function assertExhaustion(value: unknown, type: string): asserts value is RunBudgetExhaustion {
	if (!isRecord(value)) invalid(type, "exhaustion must be an object");
	assertExactKeys(value, ["limit", "maximum", "observed"], type);
	assertOneOf(value.limit, "exhaustion.limit", type, [
		"turns",
		"model_attempts",
		"tool_invocations",
		"elapsed_ms",
		"total_tokens",
		"total_cost_usd",
		"consecutive_equivalent_tool_batches",
	]);
	if (typeof value.maximum !== "number" || !Number.isFinite(value.maximum) || value.maximum < 0) {
		invalid(type, "exhaustion.maximum must be a non-negative finite number");
	}
	if (typeof value.observed !== "number" || !Number.isFinite(value.observed) || value.observed < 0) {
		invalid(type, "exhaustion.observed must be a non-negative finite number");
	}
}

/** Rejects hidden payloads as well as malformed bounded fields. */
export function assertWorkerFact(value: unknown): asserts value is WorkerFact {
	if (!isRecord(value) || typeof value.type !== "string" || !(value.type in FACT_KEYS)) {
		invalid("unknown", "unsupported fact type");
	}
	const type = value.type as WorkerFact["type"];
	assertExactKeys(
		value,
		FACT_KEYS[type],
		type,
		type === "run_started" ? ["queueItemId", "budget"] : type === "run_settled" ? ["failureKind"] : [],
	);
	assertId(value.runId, "runId", type);
	assertTimestamp(value.timestamp, type);
	switch (type) {
		case "run_started":
			assertOneOf(value.source, "source", type, ["prompt", "follow_up"]);
			if (value.queueItemId !== undefined) assertId(value.queueItemId, "queueItemId", type);
			if (value.budget !== undefined) assertRunBudget(value.budget, type);
			return;
		case "attempt_started":
			assertId(value.turnId, "turnId", type);
			assertId(value.attemptId, "attemptId", type);
			assertId(value.messageId, "messageId", type);
			assertCounter(value.attempt, "attempt", type, 1);
			return;
		case "attempt_settled":
			assertId(value.turnId, "turnId", type);
			assertId(value.attemptId, "attemptId", type);
			assertId(value.messageId, "messageId", type);
			assertCounter(value.attempt, "attempt", type, 1);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			if (typeof value.discarded !== "boolean") invalid(type, "discarded must be boolean");
			assertCounter(value.totalTokens, "totalTokens", type);
			return;
		case "tool_started":
			assertId(value.turnId, "turnId", type);
			assertId(value.invocationId, "invocationId", type);
			if (
				typeof value.toolName !== "string" ||
				value.toolName.length === 0 ||
				value.toolName.length > MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH
			) {
				invalid(type, `toolName must be 1-${MAXIMUM_WORKER_FACT_TOOL_NAME_LENGTH} characters`);
			}
			assertOneOf(value.replaySafety, "replaySafety", type, ["never", "safe"]);
			return;
		case "tool_settled":
			assertId(value.turnId, "turnId", type);
			assertId(value.invocationId, "invocationId", type);
			assertOneOf(value.settlement, "settlement", type, ["returned", "threw", "aborted"]);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			return;
		case "turn_settled":
			assertId(value.turnId, "turnId", type);
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			return;
		case "budget_exhausted":
			assertExhaustion(value.exhaustion, type);
			return;
		case "run_settled":
			assertOneOf(value.outcome, "outcome", type, ["success", "error", "aborted"]);
			if (value.failureKind !== undefined) {
				assertOneOf(value.failureKind, "failureKind", type, ["model", "tool", "runtime", "listener", "budget"]);
			}
			return;
	}
	const exhaustive: never = type;
	return exhaustive;
}

function nextCounter(current: number, increment: number, field: string, type: WorkerFact["type"]): number {
	const next = current + increment;
	if (!Number.isSafeInteger(next)) invalid(type, `${field} overflow`);
	return next;
}

function activeRun(projection: WorkerFactProjection, fact: WorkerFact): void {
	if (String(projection.activeRun?.id ?? "") !== fact.runId) {
		invalid(fact.type, `active Run is ${String(projection.activeRun?.id ?? "absent")}, not ${fact.runId}`);
	}
}

function freezeProjection(value: WorkerFactProjection): WorkerFactProjection {
	return Object.freeze({
		...value,
		...(value.activeRun
			? {
					activeRun: Object.freeze({
						...value.activeRun,
						...(value.activeRun.budget
							? { budget: Object.freeze({ limits: Object.freeze({ ...value.activeRun.budget.limits }) }) }
							: {}),
						...(value.activeRun.budgetExhaustion
							? { budgetExhaustion: Object.freeze({ ...value.activeRun.budgetExhaustion }) }
							: {}),
					}),
				}
			: {}),
		openAttempts: Object.freeze(value.openAttempts.map((entry) => Object.freeze({ ...entry }))),
		openTools: Object.freeze(value.openTools.map((entry) => Object.freeze({ ...entry }))),
		...(value.exhaustion ? { exhaustion: Object.freeze({ ...value.exhaustion }) } : {}),
	});
}

/** The only live and recovery accounting reducer for Worker Facts. */
export function reduceWorkerFact(projection: WorkerFactProjection, fact: WorkerFact): WorkerFactProjection {
	assertWorkerFact(fact);
	switch (fact.type) {
		case "run_started":
			if (projection.activeRun !== undefined) {
				invalid(fact.type, `Run ${String(projection.activeRun.id)} has not settled`);
			}
			if (projection.openAttempts.length > 0 || projection.openTools.length > 0) {
				invalid(fact.type, "a new Run cannot begin with open effects");
			}
			return freezeProjection({
				...projection,
				activeRun: {
					id: fact.runId as ActiveRun["id"],
					source: fact.source,
					...(fact.queueItemId ? { queueItemId: fact.queueItemId as ActiveRun["queueItemId"] } : {}),
					...(fact.budget ? { budget: fact.budget } : {}),
				},
				exhaustion: undefined,
			});
		case "attempt_started":
			activeRun(projection, fact);
			if (projection.openAttempts.some(({ attemptId }) => attemptId === fact.attemptId)) {
				invalid(fact.type, `duplicate Attempt ${fact.attemptId}`);
			}
			return freezeProjection({
				...projection,
				modelAttempts: nextCounter(projection.modelAttempts, 1, "modelAttempts", fact.type),
				openAttempts: [
					...projection.openAttempts,
					{
						runId: fact.runId,
						turnId: fact.turnId,
						attemptId: fact.attemptId,
						messageId: fact.messageId,
						attempt: fact.attempt,
					},
				],
			});
		case "attempt_settled": {
			activeRun(projection, fact);
			const open = projection.openAttempts.find(({ attemptId }) => attemptId === fact.attemptId);
			if (!open) invalid(fact.type, `Attempt ${fact.attemptId} is not open`);
			if (
				open.runId !== fact.runId ||
				open.turnId !== fact.turnId ||
				open.messageId !== fact.messageId ||
				open.attempt !== fact.attempt
			) {
				invalid(fact.type, `Attempt ${fact.attemptId} identity mismatch`);
			}
			return freezeProjection({
				...projection,
				totalTokens: nextCounter(projection.totalTokens, fact.totalTokens, "totalTokens", fact.type),
				openAttempts: projection.openAttempts.filter(({ attemptId }) => attemptId !== fact.attemptId),
			});
		}
		case "tool_started":
			activeRun(projection, fact);
			if (projection.openTools.some(({ invocationId }) => invocationId === fact.invocationId)) {
				invalid(fact.type, `duplicate Tool Invocation ${fact.invocationId}`);
			}
			return freezeProjection({
				...projection,
				toolInvocations: nextCounter(projection.toolInvocations, 1, "toolInvocations", fact.type),
				openTools: [
					...projection.openTools,
					{ runId: fact.runId, turnId: fact.turnId, invocationId: fact.invocationId },
				],
			});
		case "tool_settled": {
			activeRun(projection, fact);
			const open = projection.openTools.find(({ invocationId }) => invocationId === fact.invocationId);
			if (!open) invalid(fact.type, `Tool Invocation ${fact.invocationId} is not open`);
			if (open.runId !== fact.runId || open.turnId !== fact.turnId) {
				invalid(fact.type, `Tool Invocation ${fact.invocationId} identity mismatch`);
			}
			return freezeProjection({
				...projection,
				openTools: projection.openTools.filter(({ invocationId }) => invocationId !== fact.invocationId),
			});
		}
		case "turn_settled":
			activeRun(projection, fact);
			return projection;
		case "budget_exhausted":
			activeRun(projection, fact);
			return freezeProjection({
				...projection,
				exhaustion: fact.exhaustion,
				activeRun: { ...projection.activeRun!, budgetExhaustion: fact.exhaustion },
			});
		case "run_settled":
			activeRun(projection, fact);
			return freezeProjection({ ...projection, activeRun: undefined });
	}
}

export function workerFactHasOpenEffects(projection: WorkerFactProjection): boolean {
	return projection.openAttempts.length > 0 || projection.openTools.length > 0;
}
