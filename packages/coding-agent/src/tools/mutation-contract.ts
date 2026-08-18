import type { JsonValue } from "@coda/ai";

export const MUTATION_TOOL_NAMES = Object.freeze(["edit", "write"] as const);
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];
export type MutationOperation = "add" | "update" | "delete";

export interface MutationDelta {
	readonly path: string;
	readonly operation: MutationOperation;
	/** Null when no pre-image exists or a compatible legacy Tool did not capture it. */
	readonly beforeSha256: string | null;
	/** Null only for deletion. */
	readonly afterSha256: string | null;
	readonly previousBytes: number;
	readonly bytes: number;
}

export interface MutationFacts {
	readonly schemaVersion: 1;
	/** Each target commits atomically; a multi-target invocation is not globally atomic. */
	readonly atomicity: "single-file" | "per-file";
	readonly attemptedPaths: readonly string[];
	readonly committedPaths: readonly string[];
	readonly committedDelta: readonly MutationDelta[];
}

export interface MutationRequestMetadata {
	readonly toolName: MutationToolName;
	readonly requestedPaths: readonly string[];
	readonly preview: string;
	readonly presentVerb: string;
	readonly pastVerb: string;
	readonly subject: string;
}

const MAX_MUTATION_PREVIEW_CHARACTERS = 4_096;

function isMutationToolName(value: string): value is MutationToolName {
	return (MUTATION_TOOL_NAMES as readonly string[]).includes(value);
}

/** Projects model arguments into bounded mutation presentation metadata. */
export function mutationRequestMetadata(
	toolName: string,
	arguments_: Readonly<Record<string, unknown>>,
): MutationRequestMetadata | undefined {
	if (!isMutationToolName(toolName)) return undefined;
	const path = arguments_.path;
	if (typeof path !== "string" || path.length === 0) throw new Error(`${toolName} path must be a non-empty string`);
	if (toolName === "edit") {
		const oldText = typeof arguments_.oldText === "string" ? arguments_.oldText : "";
		const newText = typeof arguments_.newText === "string" ? arguments_.newText : "";
		return Object.freeze({
			toolName,
			requestedPaths: Object.freeze([path]),
			preview: boundedPreview(`--- current\n+++ proposed\n-${oldText}\n+${newText}`),
			presentVerb: "Editing",
			pastVerb: "Edited",
			subject: path,
		});
	}
	const content = typeof arguments_.content === "string" ? arguments_.content : "";
	return Object.freeze({
		toolName,
		requestedPaths: Object.freeze([path]),
		preview: boundedPreview(`Write ${content.length} characters${content ? `:\n${content}` : ""}`),
		presentVerb: "Writing",
		pastVerb: "Wrote",
		subject: path,
	});
}

export function mutationFacts(value: {
	readonly atomicity: MutationFacts["atomicity"];
	readonly attemptedPaths: readonly string[];
	readonly committedDelta: readonly MutationDelta[];
}): MutationFacts {
	return Object.freeze({
		schemaVersion: 1 as const,
		atomicity: value.atomicity,
		attemptedPaths: Object.freeze([...value.attemptedPaths]),
		committedPaths: Object.freeze(value.committedDelta.map(({ path }) => path)),
		committedDelta: Object.freeze(value.committedDelta.map((delta) => Object.freeze({ ...delta }))),
	});
}

export function mutationObservationFacts(
	mutation: MutationFacts,
	additional: Readonly<Record<string, JsonValue>> = {},
): Readonly<Record<string, JsonValue>> {
	return Object.freeze({ ...additional, mutation: mutation as unknown as JsonValue });
}

function boundedPreview(value: string): string {
	const characters = Array.from(value);
	if (characters.length <= MAX_MUTATION_PREVIEW_CHARACTERS) return value;
	return `${characters.slice(0, MAX_MUTATION_PREVIEW_CHARACTERS - 1).join("")}…`;
}
