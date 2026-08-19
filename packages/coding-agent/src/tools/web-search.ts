import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { WebSearchProviderId } from "../settings/types.ts";
import { toolFailure } from "./failure.ts";
import { createRunEvidenceToolFacts } from "./run-evidence-facts.ts";
import type { WebRuntime, WebSearchResponse } from "./web/runtime.ts";

const WEB_SEARCH_PROVIDER_IDS = [
	"brave",
	"tavily",
	"searxng",
	"duckduckgo",
] as const satisfies readonly WebSearchProviderId[];

const WebSearchParameters = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 2_000 }),
		provider: Type.Optional(
			Type.Union(
				[
					Type.Literal(WEB_SEARCH_PROVIDER_IDS[0]),
					Type.Literal(WEB_SEARCH_PROVIDER_IDS[1]),
					Type.Literal(WEB_SEARCH_PROVIDER_IDS[2]),
					Type.Literal(WEB_SEARCH_PROVIDER_IDS[3]),
				],
				{ description: "Preferred Provider; failures still fall back through the configured Provider chain." },
			),
		),
		maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	},
	{ additionalProperties: false },
);

function markdownLabel(value: string): string {
	return value.replace(/\\/gu, "\\\\").replace(/([[\]])/gu, "\\$1");
}

function markdownDestination(value: string): string {
	return value.replace(/\\/gu, "\\\\").replace(/([()])/gu, "\\$1");
}

function formatSearchResponse(response: WebSearchResponse): { readonly content: string; readonly truncated: boolean } {
	const parts: string[] = [];
	if (response.answer) parts.push(`## Answer\n\n${response.answer}`);
	if (response.sources.length > 0) parts.push("## Results");
	for (const [index, source] of response.sources.entries()) {
		parts.push(
			`${index + 1}. [${markdownLabel(source.title)}](${markdownDestination(source.url)})${source.summary ? `\n   ${source.summary}` : ""}`,
		);
	}
	const content = parts.join("\n\n");
	const marker = "\n\n[Search output truncated]";
	if (content.length <= response.maxCharacters) return { content, truncated: false };
	const available = Math.max(0, response.maxCharacters - marker.length);
	let prefix = content.slice(0, available);
	if (prefix.length > 0 && /[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
	const boundedMarker = marker.slice(0, Math.max(0, response.maxCharacters - prefix.length));
	return { content: `${prefix}${boundedMarker}`, truncated: true };
}

export function createWebSearchTool(web: WebRuntime): AgentTool<typeof WebSearchParameters> {
	return {
		name: "web_search",
		description:
			"Search the web for current or unknown information using configured Providers with timeout and automatic fallback. For a known URL, use fetch instead. Returns an optional answer plus source titles, URLs, and summaries.",
		parameters: WebSearchParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			try {
				const response = await web.search(arguments_, context.signal);
				const formatted = formatSearchResponse(response);
				return {
					content: formatted.content,
					observation: {
						status: "ok",
						truncated: formatted.truncated,
						facts: {
							provider: response.provider,
							resultCount: response.sources.length,
							cache: response.cache,
							runEvidence: createRunEvidenceToolFacts({
								completeness: formatted.truncated ? "lossy-overflow" : "windowed",
								limitationReason: formatted.truncated ? "output-overflow" : "pagination",
								resolutionTarget: { kind: "opaque", value: arguments_.query },
							}),
						},
					},
					details: {
						provider: response.provider,
						attempts: response.attempts,
						resultCount: response.sources.length,
						answerPresent: response.answer !== undefined,
						cache: response.cache,
					},
				};
			} catch (error) {
				context.signal.throwIfAborted();
				return toolFailure(error instanceof Error ? error.message : String(error), { code: "web_search_failed" });
			}
		},
	};
}
