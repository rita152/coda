import type { JsonValue } from "@coda/ai";

export type ToolObservationCompleteness = "complete" | "windowed" | "recoverable-overflow" | "lossy-overflow";
export type ToolObservationLimitationReason = "pagination" | "user-preview" | "output-overflow";

export interface ToolObservationFactsInput {
	readonly completeness: ToolObservationCompleteness;
	readonly limitationReason?: ToolObservationLimitationReason;
	readonly paths?: readonly { readonly path: string; readonly effect: "inspected" | "changed" }[];
	readonly omittedPaths?: { readonly inspected: number; readonly changed: number };
	readonly resolutionTarget?: { readonly kind: "path" | "opaque"; readonly value: string };
}

/** Emits the versioned, provider-neutral Tool fact consumed by Run Evidence. */
export function createRunEvidenceToolFacts(input: ToolObservationFactsInput): JsonValue {
	return {
		schemaVersion: 1,
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

function nonNegativeInteger(value: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
