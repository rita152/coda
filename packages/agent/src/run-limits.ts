import { cloneFrozen } from "./immutable.ts";
import type { Immutable, RunLimits } from "./types.ts";

export const RUN_LIMIT_KEYS = Object.freeze([
	"maxTurns",
	"maxModelAttempts",
	"maxToolInvocations",
	"maxElapsedMs",
	"maxTotalTokens",
	"maxTotalCostUsd",
	"maxConsecutiveEquivalentToolBatches",
] as const satisfies readonly (keyof RunLimits)[]);

const INTEGER_RUN_LIMIT_KEYS = RUN_LIMIT_KEYS.filter(
	(key): key is Exclude<(typeof RUN_LIMIT_KEYS)[number], "maxTotalCostUsd"> => key !== "maxTotalCostUsd",
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the complete Run-limit shape, including unknown keys. */
export function assertRunLimits(value: unknown, path = "runLimits"): asserts value is RunLimits {
	if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
	const admitted = new Set<string>(RUN_LIMIT_KEYS);
	for (const key of Object.keys(value)) {
		if (!admitted.has(key)) throw new TypeError(`${path} has unexpected field ${key}`);
	}
	for (const key of INTEGER_RUN_LIMIT_KEYS) {
		const limit = value[key];
		if (limit === undefined) continue;
		if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
			throw new TypeError(`${path}.${key} must be a positive safe integer`);
		}
	}
	const cost = value.maxTotalCostUsd;
	if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0)) {
		throw new TypeError(`${path}.maxTotalCostUsd must be a positive finite number`);
	}
}

export function snapshotRunLimits(value: unknown, path = "runLimits"): Immutable<RunLimits> {
	assertRunLimits(value, path);
	return cloneFrozen(value) as Immutable<RunLimits>;
}
