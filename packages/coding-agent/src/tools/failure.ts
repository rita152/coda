import type { ToolExecutionOutput } from "@coda/agent";
import type { JsonValue } from "@coda/ai";

const FACT_NAMES = new Set(["code", "engine", "exitCode", "limitBytes", "matches"]);

function failureFacts(details: Record<string, unknown>): Readonly<Record<string, JsonValue>> | undefined {
	const facts = Object.fromEntries(
		Object.entries(details).filter(
			([name, value]) =>
				FACT_NAMES.has(name) &&
				(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
		),
	) as Record<string, JsonValue>;
	return Object.keys(facts).length > 0 ? facts : undefined;
}

export function toolFailure<TDetails extends Record<string, unknown>>(
	content: string,
	details: TDetails,
	additionalFacts?: Readonly<Record<string, JsonValue>>,
): ToolExecutionOutput<TDetails & { readonly status: "failed" }> {
	const legacyFacts = failureFacts(details);
	const facts =
		legacyFacts || additionalFacts
			? Object.freeze({ ...(legacyFacts ?? {}), ...(additionalFacts ?? {}) })
			: undefined;
	return {
		content,
		observation: { status: "error", truncated: false, ...(facts ? { facts } : {}) },
		details: { ...details, status: "failed" },
		isError: true,
	};
}
