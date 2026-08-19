import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import { toolFailure } from "./failure.ts";
import { createRunEvidenceToolFacts } from "./run-evidence-facts.ts";
import type { WebRuntime } from "./web/runtime.ts";

const FetchParameters = Type.Object(
	{
		url: Type.String({ minLength: 1, maxLength: 8_192 }),
		raw: Type.Optional(Type.Boolean()),
		maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
	},
	{ additionalProperties: false },
);

export function createFetchTool(web: WebRuntime): AgentTool<typeof FetchParameters> {
	return {
		name: "fetch",
		description:
			"Read a known HTTP or HTTPS URL and return clean Markdown or the appropriate JSON, text, Feed, image, or document representation. Set raw=true to bypass shaping for textual responses; binary images and documents still use bounded safe representations. For current or unknown information without a URL, use web_search instead.",
		parameters: FetchParameters,
		replaySafety: "safe",
		parallelSafe: false,
		execute: async (arguments_, context) => {
			try {
				const response = await web.fetch(arguments_, context.signal);
				const limitationReason =
					response.limitationReason ?? (response.truncated ? ("output-overflow" as const) : undefined);
				const evidenceCompleteness =
					limitationReason === "pagination" ? "windowed" : limitationReason ? "lossy-overflow" : "complete";
				return {
					content: response.image
						? [
								{ type: "text" as const, text: response.content },
								{ type: "image" as const, data: response.image.data, mimeType: response.image.mimeType },
							]
						: response.content,
					observation: {
						status: "ok",
						truncated: response.truncated,
						facts: {
							method: response.method,
							contentType: response.contentType,
							bytes: response.bytes,
							cache: response.cache,
							runEvidence: createRunEvidenceToolFacts({
								completeness: evidenceCompleteness,
								...(limitationReason ? { limitationReason } : {}),
								resolutionTarget: { kind: "opaque", value: arguments_.url },
							}),
						},
					},
					details: {
						url: response.url,
						finalUrl: response.finalUrl,
						contentType: response.contentType,
						method: response.method,
						bytes: response.bytes,
						truncated: response.truncated,
						cache: response.cache,
						...(limitationReason ? { limitationReason } : {}),
						...(response.transformed ? { transformed: true } : {}),
						...(response.image ? { image: { mimeType: response.image.mimeType } } : {}),
					},
				};
			} catch (error) {
				context.signal.throwIfAborted();
				return toolFailure(error instanceof Error ? error.message : String(error), { code: "fetch_failed" });
			}
		},
	};
}
