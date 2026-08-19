import { lookup } from "node:dns/promises";
import type { ToolExecutionContext } from "@coda/agent";
import { describe, expect, test } from "vitest";
import { createNodePinnedFetch } from "../../src/node-application.ts";
import { createFetchTool } from "../../src/tools/fetch.ts";
import { createWebRuntime } from "../../src/tools/web/runtime.ts";
import { createWebSearchTool } from "../../src/tools/web-search.ts";

const providers = [...(process.env.TAVILY_API_KEY ? (["tavily"] as const) : []), "duckduckgo" as const];

const web = createWebRuntime({
	fetch: globalThis.fetch.bind(globalThis),
	pinnedFetch: createNodePinnedFetch(globalThis.fetch.bind(globalThis)),
	resolveHostname: async (hostname) =>
		(await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address),
	settings: {
		load: async () => ({
			web: {
				search: { providers, timeoutMs: 20_000, maxResults: 5, maxCharacters: 8_000 },
				fetch: { timeoutMs: 30_000, maxBytes: 10 * 1024 * 1024, maxCharacters: 20_000 },
				cache: { ttlMs: 1, maxEntries: 8, maxBytes: 8 * 1024 * 1024 },
			},
		}),
		save: async () => undefined,
	},
	environment: process.env,
});

function context(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:web-live" as ToolExecutionContext["runId"],
		turnId: "turn:web-live" as ToolExecutionContext["turnId"],
		invocationId: "invocation:web-live" as ToolExecutionContext["invocationId"],
		resultMessageId: "message:web-live" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider:web-live",
	};
}

describe.sequential("Live Web Tools", () => {
	test("searches the public Web through DuckDuckGo", async () => {
		const result = await createWebSearchTool(web).execute(
			{ query: "OpenAI API official documentation", provider: "duckduckgo" },
			context(),
		);

		expect(result.observation).toMatchObject({
			status: "ok",
			facts: { provider: "duckduckgo", resultCount: expect.any(Number) },
		});
		expect(result.content).toContain("http");
	});

	test.runIf(Boolean(process.env.TAVILY_API_KEY))("returns a synthesized answer from Tavily", async () => {
		const result = await createWebSearchTool(web).execute(
			{ query: "OpenAI API official documentation", provider: "tavily" },
			context(),
		);

		expect(result.observation).toMatchObject({ status: "ok", facts: { provider: "tavily" } });
		expect(result.details).toMatchObject({ answerPresent: true });
		expect(result.content).toContain("## Answer");
	});

	test("fetches and converts real HTML, JSON, Feed, image, PDF, and raw responses", async () => {
		const html = await createFetchTool(web).execute({ url: "https://example.com/" }, context());
		const json = await createFetchTool(web).execute(
			{ url: "https://api.github.com/repos/openai/openai-node" },
			context(),
		);
		const feed = await createFetchTool(web).execute({ url: "https://hnrss.org/frontpage" }, context());
		const image = await createFetchTool(web).execute({ url: "https://www.w3.org/Icons/w3c_home.png" }, context());
		const pdf = await createFetchTool(web).execute(
			{ url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" },
			context(),
		);
		const raw = await createFetchTool(web).execute({ url: "https://example.com/", raw: true }, context());

		expect(html.observation).toMatchObject({ status: "ok", facts: { method: "html" } });
		expect(html.content).toContain("# Example Domain");
		expect(json.observation).toMatchObject({ status: "ok", facts: { method: "json" } });
		expect(json.content).toContain('"full_name": "openai/openai-node"');
		expect(feed.observation).toMatchObject({ status: "ok", facts: { method: "feed" } });
		expect(feed.content).toContain("# Hacker News: Front Page");
		expect(image.observation).toMatchObject({ status: "ok", facts: { method: "image" } });
		expect(image.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]));
		expect(pdf.observation).toMatchObject({ status: "ok", facts: { method: "document", bytes: expect.any(Number) } });
		expect(pdf.details).toMatchObject({ bytes: expect.any(Number) });
		expect(pdf.content).toContain("Dummy PDF file");
		expect(raw.observation).toMatchObject({ status: "ok", facts: { method: "raw" } });
		expect(raw.content).toContain("<!doctype html>");
	}, 60_000);
});
