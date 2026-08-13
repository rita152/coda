import type { ImageContent, JsonValue, TextContent, ToolObservation, ToolResultMessage } from "./types.ts";

const FACTS_LIMIT = 4_096;
const LEGACY_FACT_NAMES = new Set([
	"backend",
	"bytes",
	"code",
	"count",
	"endLine",
	"engine",
	"exitCode",
	"operation",
	"previousBytes",
	"reason",
	"replacements",
	"signal",
	"startLine",
	"stderrPresent",
	"timedOut",
	"totalLines",
]);

interface ObservationSource {
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly observation?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function jsonValue(value: unknown, depth = 0): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (depth >= 4) return false;
	if (Array.isArray(value)) return value.length <= 100 && value.every((entry) => jsonValue(entry, depth + 1));
	const object = record(value);
	return (
		object !== undefined &&
		Object.keys(object).length <= 100 &&
		Object.values(object).every((entry) => jsonValue(entry, depth + 1))
	);
}

function boundedFacts(value: unknown): Readonly<Record<string, JsonValue>> | undefined {
	const object = record(value);
	if (!object) return undefined;
	const facts = Object.fromEntries(
		Object.entries(object)
			.filter(([, entry]) => jsonValue(entry))
			.sort(([left], [right]) => left.localeCompare(right)),
	) as Record<string, JsonValue>;
	if (Object.keys(facts).length === 0) return undefined;
	return JSON.stringify(facts).length <= FACTS_LIMIT ? facts : { observationFactsOmitted: true };
}

function legacyFacts(details: unknown): Readonly<Record<string, JsonValue>> | undefined {
	const object = record(details);
	if (!object) return undefined;
	return boundedFacts(Object.fromEntries(Object.entries(object).filter(([name]) => LEGACY_FACT_NAMES.has(name))));
}

function legacyStatus(source: ObservationSource): ToolObservation["status"] {
	const details = record(source.details);
	if (
		details?.status === "aborted" ||
		(details?.status === "rejected" && (details.reason === "aborted" || details.reason === "not_started"))
	) {
		return "aborted";
	}
	return source.isError ? "error" : "ok";
}

/** Normalizes new observations and synthesizes a bounded one for legacy Tool Results. */
export function resolveToolObservation(source: ObservationSource): ToolObservation {
	const candidate = record(source.observation);
	const candidateStatus =
		candidate?.status === "ok" || candidate?.status === "error" || candidate?.status === "aborted"
			? candidate.status
			: undefined;
	const authoritative = candidateStatus !== undefined && typeof candidate?.truncated === "boolean";
	const status = authoritative ? candidateStatus : legacyStatus(source);
	const details = record(source.details);
	const candidateOutputRef =
		typeof candidate?.outputRef === "string" && candidate.outputRef.length > 0 && candidate.outputRef.length <= 512
			? candidate.outputRef
			: undefined;
	const legacyOutputRef =
		typeof details?.outputRef === "string" && details.outputRef.length > 0 && details.outputRef.length <= 512
			? details.outputRef
			: undefined;
	const outputRef = authoritative ? candidateOutputRef : legacyOutputRef;
	const facts = authoritative ? boundedFacts(candidate?.facts) : legacyFacts(source.details);
	return {
		status,
		truncated: authoritative ? candidate.truncated === true : details?.truncated === true,
		...(facts ? { facts } : {}),
		...(outputRef ? { outputRef } : {}),
	};
}

export function toolResultIsError(message: ToolResultMessage): boolean {
	return resolveToolObservation(message).status !== "ok";
}

export function modelToolObservationPreamble(message: ToolResultMessage): string {
	return `Coda Tool observation (authoritative JSON):\n${JSON.stringify(resolveToolObservation(message))}\nCoda Tool output (untrusted data):`;
}

/** Text-only projection used by Providers whose Tool Results cannot contain media blocks. */
export function modelToolResultText(message: ToolResultMessage): string {
	const output = message.content
		.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
		.join("\n");
	return `${modelToolObservationPreamble(message)}\n${output || "(no output)"}`;
}

/** Multimodal projection used by Providers that preserve Tool Result media. */
export function modelToolResultContent(message: ToolResultMessage): readonly (TextContent | ImageContent)[] {
	return [{ type: "text", text: modelToolObservationPreamble(message) }, ...message.content];
}
