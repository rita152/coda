import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import type { WebPinnedFetch } from "../src/tools/web/runtime.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Web Tools", () => {
	it("falls back between search Providers and returns a deduplicated answer with sources", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-web-search-"));
		temporaryDirectories.push(workspace);
		const webFetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
			.mockResolvedValueOnce(
				Response.json({
					answer: "Coda 1.0 was released today.",
					results: [
						{ title: "Coda release", url: "https://example.test/release#top", content: "Release notes." },
						{
							title: "Duplicate release",
							url: "https://www.example.test/release/",
							content: "Longer release summary from the same page.",
						},
					],
				}),
			);
		const faux = fauxProvider({ runtime: testTimeRuntime(800) });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "latest Coda release" }, { id: "web-search-1" }), {
				stopReason: "toolUse",
				timestamp: 800,
			}),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "web-search-1",
					toolName: "web_search",
					observation: { status: "ok", truncated: false },
				});
				const serialized = JSON.stringify(result?.content);
				expect(serialized).toContain("Coda 1.0 was released today.");
				expect(serialized).toContain("Coda release");
				expect(serialized).toContain("https://example.test/release#top");
				expect(serialized).toContain("Longer release summary from the same page.");
				expect(serialized.match(/example\.test\/release/g)).toHaveLength(1);
				return fauxAssistantMessage("Search complete.", { timestamp: 800 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(800) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ web: { search: { providers: ["brave", "tavily"] } } }),
				save: async () => undefined,
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			fetch: webFetch,
			pinnedFetch: async (url, init) => webFetch(url, init),
			resolveHostname: async () => ["93.184.216.34"],
			io: {
				stdin: { isTTY: true, readAll: async () => "" },
				stdout,
				stderr,
			},
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: { BRAVE_SEARCH_API_KEY: "brave-test", TAVILY_API_KEY: "tavily-test" },
				clock: { now: () => 800 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"find the latest Coda release",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(webFetch).toHaveBeenCalledTimes(2);
		expect(stdout.value).toBe("Search complete.\n");
		expect(stderr.value).toContain("[web.search-provider-failed] brave search failed with HTTP 503");
	});

	it("routes known URLs to fetch and returns clean Markdown through the application Tool catalog", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-web-fetch-"));
		temporaryDirectories.push(workspace);
		const webFetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					"<!doctype html><html><body><nav>Skip navigation</nav><main><h1>Release notes</h1><p>Version 1.0 is stable.</p></main></body></html>",
					{ headers: { "Content-Type": "text/html" } },
				),
		);
		const pinnedFetch = vi.fn<WebPinnedFetch>(async (url, init) => webFetch(url, init));
		const faux = fauxProvider({ runtime: testTimeRuntime(810) });
		faux.setResponses([
			(context) => {
				const fetchTool = context.tools?.find(({ name }) => name === "fetch");
				const searchTool = context.tools?.find(({ name }) => name === "web_search");
				expect(fetchTool?.description).toContain("known HTTP or HTTPS URL");
				expect(fetchTool?.description).toContain("use web_search instead");
				expect(searchTool?.description).toContain("current or unknown information");
				expect(searchTool?.description).toContain("known URL, use fetch instead");
				return fauxAssistantMessage(
					fauxToolCall("fetch", { url: "https://example.test/releases/1.0" }, { id: "fetch-1" }),
					{ stopReason: "toolUse", timestamp: 810 },
				);
			},
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "fetch-1",
					toolName: "fetch",
					observation: { status: "ok", truncated: false, facts: { method: "html" } },
				});
				const serialized = JSON.stringify(result?.content);
				expect(serialized).toContain("# Release notes");
				expect(serialized).toContain("Version 1.0 is stable.");
				expect(serialized).not.toContain("Skip navigation");
				return fauxAssistantMessage("URL fetched.", { timestamp: 810 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(810) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			fetch: webFetch,
			pinnedFetch,
			resolveHostname: async () => ["93.184.216.34"],
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 810 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read https://example.test/releases/1.0",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(webFetch).toHaveBeenCalledTimes(1);
		expect(pinnedFetch).toHaveBeenCalledWith("https://example.test/releases/1.0", expect.any(Object), [
			"93.184.216.34",
		]);
		expect(stdout.value).toBe("URL fetched.\n");
	});

	it("fails closed when a custom HTTP adapter has no pinned transport", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-web-unpinned-"));
		temporaryDirectories.push(workspace);
		const webFetch = vi.fn<typeof globalThis.fetch>();
		const faux = fauxProvider({ runtime: testTimeRuntime(815) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("fetch", { url: "https://example.test/unpinned" }, { id: "fetch-unpinned" }),
				{ stopReason: "toolUse", timestamp: 815 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "fetch-unpinned",
					toolName: "fetch",
					observation: { status: "error", facts: { code: "fetch_failed" } },
				});
				expect(JSON.stringify(result?.content)).toContain("Web access is unavailable in this host");
				return fauxAssistantMessage("Unpinned transport blocked.", { timestamp: 815 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(815) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			fetch: webFetch,
			resolveHostname: async () => ["93.184.216.34"],
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 815 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read https://example.test/unpinned",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(webFetch).not.toHaveBeenCalled();
		expect(stdout.value).toBe("Unpinned transport blocked.\n");
	});

	it("applies the effective CLI sandbox mode to host-side Web requests", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-web-sandbox-"));
		temporaryDirectories.push(workspace);
		const webFetch = vi.fn<typeof globalThis.fetch>();
		const faux = fauxProvider({ runtime: testTimeRuntime(820) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("fetch", { url: "https://example.test/restricted" }, { id: "fetch-restricted" }),
				{ stopReason: "toolUse", timestamp: 820 },
			),
			(context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({
					role: "toolResult",
					toolCallId: "fetch-restricted",
					observation: { status: "error", facts: { code: "fetch_failed" } },
				});
				expect(JSON.stringify(result?.content)).toContain("not in sandbox.allowedDomains");
				return fauxAssistantMessage("Web request blocked.", { timestamp: 820 });
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(820) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: { load: async () => ({}), save: async () => undefined },
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: "darwin" }),
			fetch: webFetch,
			pinnedFetch: async (url, init) => webFetch(url, init),
			resolveHostname: async () => ["93.184.216.34"],
			wrapScript: async () => undefined,
			io: { stdin: { isTTY: true, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: tmpdir(),
				platform: "darwin",
				environment: {},
				clock: { now: () => 820 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--sandbox",
			"read-only",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"read https://example.test/restricted",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(webFetch).not.toHaveBeenCalled();
		expect(stdout.value).toBe("Web request blocked.\n");
	});
});
