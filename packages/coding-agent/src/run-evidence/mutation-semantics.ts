import type { JsonValue } from "@coda/ai";

export interface MutationDelta {
	readonly path: string;
	readonly operation: "add" | "update" | "delete";
	readonly beforeSha256: string | null;
	readonly afterSha256: string | null;
	readonly previousBytes: number;
	readonly bytes: number;
}

export interface MutationFacts {
	readonly schemaVersion: 1;
	readonly atomicity: "single-file" | "per-file";
	readonly attemptedPaths: readonly string[];
	readonly committedPaths: readonly string[];
	readonly committedDelta: readonly MutationDelta[];
}

export function mutationRequestPaths(
	toolName: string,
	arguments_: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
	if (toolName === "write" || toolName === "edit") {
		return typeof arguments_.path === "string" && arguments_.path.length > 0 ? [arguments_.path] : undefined;
	}
	if (toolName !== "patch" || typeof arguments_.patch !== "string") return undefined;
	const paths = [...arguments_.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map((match) =>
		match[1]!.trim(),
	);
	return paths.length > 0 ? Object.freeze(paths) : undefined;
}

/** Reads the generic mutation wire fact without depending on Tool implementations. */
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
	return Object.freeze({
		schemaVersion: 1,
		atomicity: record.atomicity,
		attemptedPaths: Object.freeze([...record.attemptedPaths]),
		committedPaths: Object.freeze([...record.committedPaths]),
		committedDelta: Object.freeze(deltas.map((delta) => Object.freeze(delta))),
	});
}

function validDeltaDigests(
	operation: MutationDelta["operation"],
	before: string | null,
	after: string | null,
): boolean {
	if (operation === "add") return before === null && after !== null;
	if (operation === "delete") return before !== null && after === null;
	return after !== null;
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
