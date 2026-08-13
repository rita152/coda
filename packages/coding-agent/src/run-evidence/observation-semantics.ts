import type { JsonValue } from "@coda/ai";
import {
	RUN_EVIDENCE_TOOL_FACTS_VERSION,
	type RunEvidenceObservationCompleteness,
	type RunEvidenceObservationLimitationReason,
	type RunEvidencePathOmissions,
	type RunEvidenceResolutionTarget,
	type RunEvidenceToolFactPath,
	type RunEvidenceToolFactsV1,
} from "./contracts.ts";

const COMPLETENESS = new Set<RunEvidenceObservationCompleteness>([
	"complete",
	"windowed",
	"recoverable-overflow",
	"lossy-overflow",
]);
const LIMITATION_REASONS = new Set<RunEvidenceObservationLimitationReason>([
	"pagination",
	"user-preview",
	"output-overflow",
]);

export interface RunEvidenceToolFactsInput {
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly limitationReason?: RunEvidenceObservationLimitationReason;
	readonly paths?: readonly RunEvidenceToolFactPath[];
	readonly omittedPaths?: RunEvidencePathOmissions;
	readonly resolutionTarget?: RunEvidenceResolutionTarget;
}

export interface ResolvedObservationSemantics {
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly limitationReason?: RunEvidenceObservationLimitationReason;
	readonly paths: readonly RunEvidenceToolFactPath[];
	readonly omittedPaths: RunEvidencePathOmissions;
	readonly resolutionTarget?: RunEvidenceResolutionTarget;
}

/** Builds the versioned JSON fact consumed by Run Evidence. */
export function createRunEvidenceToolFacts(input: RunEvidenceToolFactsInput): JsonValue {
	return {
		schemaVersion: RUN_EVIDENCE_TOOL_FACTS_VERSION,
		completeness: input.completeness,
		...(input.limitationReason ? { limitationReason: input.limitationReason } : {}),
		...(input.paths ? { paths: input.paths.map(({ path, effect }) => ({ path, effect })) } : {}),
		...(input.omittedPaths
			? {
					omittedPaths: {
						inspected: nonNegativeInteger(input.omittedPaths.inspected),
						changed: nonNegativeInteger(input.omittedPaths.changed),
					},
				}
			: {}),
		...(input.resolutionTarget
			? {
					resolutionTarget: {
						kind: input.resolutionTarget.kind,
						value: input.resolutionTarget.value,
					},
				}
			: {}),
	};
}

/** Resolves v1 facts and conservatively classifies legacy truncation. */
export function resolveObservationSemantics(source: {
	readonly truncated: boolean;
	readonly outputRecoverable: boolean;
	readonly facts?: unknown;
}): ResolvedObservationSemantics {
	const declared = readRunEvidenceToolFacts(source.facts);
	const facts = record(source.facts);
	let completeness = declared?.completeness;
	if (completeness === "complete" && source.truncated) completeness = undefined;
	if (completeness === "recoverable-overflow" && (!source.outputRecoverable || facts?.outputRefComplete === false)) {
		completeness = "lossy-overflow";
	}
	if (!completeness) {
		completeness = !source.truncated
			? "complete"
			: isUserPreview(facts)
				? facts?.previewComplete === true
					? "windowed"
					: "lossy-overflow"
				: source.outputRecoverable && facts?.outputRefComplete !== false
					? "recoverable-overflow"
					: "lossy-overflow";
	}
	const limitationReason =
		completeness === "complete"
			? undefined
			: (declared?.limitationReason ??
				(completeness === "windowed" && isUserPreview(facts) ? "user-preview" : undefined) ??
				(completeness === "windowed" ? "pagination" : "output-overflow"));
	return Object.freeze({
		completeness,
		...(limitationReason ? { limitationReason } : {}),
		paths: declared?.paths ?? Object.freeze([]),
		omittedPaths: declared?.omittedPaths ?? Object.freeze({ inspected: 0, changed: 0 }),
		...(declared?.resolutionTarget ? { resolutionTarget: declared.resolutionTarget } : {}),
	});
}

export function readRunEvidenceToolFacts(facts: unknown): RunEvidenceToolFactsV1 | undefined {
	const candidate = record(record(facts)?.runEvidence);
	if (candidate?.schemaVersion !== RUN_EVIDENCE_TOOL_FACTS_VERSION) return undefined;
	if (!isCompleteness(candidate.completeness)) return undefined;
	const limitationReason = isLimitationReason(candidate.limitationReason) ? candidate.limitationReason : undefined;
	const paths = Array.isArray(candidate.paths)
		? candidate.paths.flatMap((value) => {
				const path = record(value);
				return typeof path?.path === "string" &&
					path.path.length > 0 &&
					(path.effect === "inspected" || path.effect === "changed")
					? [{ path: path.path, effect: path.effect } as const]
					: [];
			})
		: undefined;
	const target = record(candidate.resolutionTarget);
	const omitted = record(candidate.omittedPaths);
	const omittedPaths = Object.freeze({
		inspected: nonNegativeInteger(omitted?.inspected),
		changed: nonNegativeInteger(omitted?.changed),
	});
	const resolutionTarget =
		typeof target?.value === "string" &&
		target.value.length > 0 &&
		(target.kind === "path" || target.kind === "opaque")
			? Object.freeze({ kind: target.kind, value: target.value })
			: undefined;
	return Object.freeze({
		schemaVersion: RUN_EVIDENCE_TOOL_FACTS_VERSION,
		completeness: candidate.completeness,
		...(limitationReason ? { limitationReason } : {}),
		...(paths ? { paths: Object.freeze(paths) } : {}),
		omittedPaths,
		...(resolutionTarget ? { resolutionTarget } : {}),
	});
}

function isUserPreview(value: Record<string, unknown> | undefined): boolean {
	return value?.previewMode === "head" || value?.previewMode === "tail";
}

function isCompleteness(value: unknown): value is RunEvidenceObservationCompleteness {
	return typeof value === "string" && COMPLETENESS.has(value as RunEvidenceObservationCompleteness);
}

function isLimitationReason(value: unknown): value is RunEvidenceObservationLimitationReason {
	return typeof value === "string" && LIMITATION_REASONS.has(value as RunEvidenceObservationLimitationReason);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegativeInteger(value: unknown): number {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
