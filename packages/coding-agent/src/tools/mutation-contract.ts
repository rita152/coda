import type { JsonValue } from "@coda/ai";
import { parsePatch } from "./patch/parser.ts";

export const MUTATION_TOOL_NAMES = Object.freeze(["patch", "edit", "write"] as const);
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

const MAX_PERMISSION_PREVIEW_CHARACTERS = 4_096;

export function isMutationToolName(value: string): value is MutationToolName {
	return (MUTATION_TOOL_NAMES as readonly string[]).includes(value);
}

/** The only model-argument projection used by Permission review and mutation presentation. */
export function mutationRequestMetadata(
	toolName: string,
	arguments_: Readonly<Record<string, unknown>>,
): MutationRequestMetadata | undefined {
	if (!isMutationToolName(toolName)) return undefined;
	if (toolName === "patch") {
		const source = arguments_.patch;
		if (typeof source !== "string") throw new Error("patch must be a string");
		const parsed = parsePatch(source);
		const requestedPaths = Object.freeze(parsed.files.map(({ path }) => path));
		const count = requestedPaths.length;
		return Object.freeze({
			toolName,
			requestedPaths,
			preview: boundedPreview(`Patch ${count} file${count === 1 ? "" : "s"}:\n${parsed.source}`),
			presentVerb: "Patching",
			pastVerb: "Patched",
			subject: `${count} file${count === 1 ? "" : "s"}`,
		});
	}
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

/** Validates generic mutation facts without consulting the originating Tool name or arguments. */
export function mutationFactsFromObservation(
	facts: Readonly<Record<string, JsonValue>> | undefined,
): MutationFacts | undefined {
	const candidate = facts?.mutation;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	const record = candidate as Record<string, JsonValue>;
	if (record.schemaVersion !== 1 || (record.atomicity !== "single-file" && record.atomicity !== "per-file")) {
		return undefined;
	}
	if (
		!stringArray(record.attemptedPaths) ||
		!stringArray(record.committedPaths) ||
		!Array.isArray(record.committedDelta)
	) {
		return undefined;
	}
	if (
		new Set(record.attemptedPaths).size !== record.attemptedPaths.length ||
		new Set(record.committedPaths).size !== record.committedPaths.length
	) {
		return undefined;
	}
	const attempted = new Set(record.attemptedPaths);
	const deltas: MutationDelta[] = [];
	for (const value of record.committedDelta) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const delta = value as Record<string, JsonValue>;
		if (
			typeof delta.path !== "string" ||
			(delta.operation !== "add" && delta.operation !== "update" && delta.operation !== "delete") ||
			!nullableDigest(delta.beforeSha256) ||
			!nullableDigest(delta.afterSha256) ||
			!nonNegativeInteger(delta.previousBytes) ||
			!nonNegativeInteger(delta.bytes) ||
			!attempted.has(delta.path) ||
			!validDeltaDigests(delta.operation, delta.beforeSha256, delta.afterSha256)
		) {
			return undefined;
		}
		deltas.push({
			path: delta.path,
			operation: delta.operation,
			beforeSha256: delta.beforeSha256,
			afterSha256: delta.afterSha256,
			previousBytes: delta.previousBytes,
			bytes: delta.bytes,
		});
	}
	if (JSON.stringify(record.committedPaths) !== JSON.stringify(deltas.map(({ path }) => path))) return undefined;
	return mutationFacts({
		atomicity: record.atomicity,
		attemptedPaths: record.attemptedPaths,
		committedDelta: deltas,
	});
}

function validDeltaDigests(operation: MutationOperation, before: string | null, after: string | null): boolean {
	if (operation === "add") return before === null && after !== null;
	if (operation === "delete") return before !== null && after === null;
	return after !== null;
}

function boundedPreview(value: string): string {
	const characters = Array.from(value);
	if (characters.length <= MAX_PERMISSION_PREVIEW_CHARACTERS) return value;
	return `${characters.slice(0, MAX_PERMISSION_PREVIEW_CHARACTERS - 1).join("")}…`;
}

function stringArray(value: JsonValue | undefined): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nullableDigest(value: JsonValue | undefined): value is string | null {
	return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function nonNegativeInteger(value: JsonValue | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
