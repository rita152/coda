import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createInterruptedToolRecoveryCatalog } from "../src/tools/recovery-catalog.ts";
import type { WebPinnedFetch } from "../src/tools/web/runtime.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Interrupted Tool recovery catalog", () => {
	it("exposes only replaySafety safe built-in Tools", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "coda-recovery-catalog-"));
		temporaryDirectories.push(workspacePath);
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
			String(input).includes("api.tavily.com")
				? Response.json({
						results: [{ title: "Recovered search", url: "https://example.test/search", content: "Found." }],
					})
				: new Response("Recovered fetch", { headers: { "Content-Type": "text/plain" } }),
		);
		const pinnedFetch = vi.fn<WebPinnedFetch>(async (url, init) => fetch(url, init));
		const tools = await createInterruptedToolRecoveryCatalog({
			workspacePath,
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					throw new Error("recovery catalog must not spawn processes during construction");
				},
			},
			homeDirectory: workspacePath,
			fetch,
			pinnedFetch,
			resolveHostname: async () => ["93.184.216.34"],
			settings: {
				load: async () => ({ web: { search: { providers: ["tavily"] } } }),
				save: async () => undefined,
			},
			clock: { now: () => 1_000 },
			environment: { TAVILY_API_KEY: "recovery-test" },
		});
		expect(tools.map(({ name }) => name)).toEqual([
			"read",
			"read_tool_output",
			"web_search",
			"fetch",
			"grep",
			"find",
			"ls",
		]);
		expect(tools.every((tool) => tool.replaySafety === "safe")).toBe(true);
		const executionContext: ToolExecutionContext = {
			signal: new AbortController().signal,
			runId: "run:recovery" as ToolExecutionContext["runId"],
			turnId: "turn:recovery" as ToolExecutionContext["turnId"],
			invocationId: "invocation:recovery" as ToolExecutionContext["invocationId"],
			resultMessageId: "message:recovery" as ToolExecutionContext["resultMessageId"],
			providerToolCallId: "provider:recovery",
		};
		const search = tools.find(({ name }) => name === "web_search");
		const fetchTool = tools.find(({ name }) => name === "fetch");
		if (!search || !fetchTool) throw new Error("recovery Web Tools are missing");
		await expect(search.execute({ query: "recovery search" }, executionContext)).resolves.toMatchObject({
			observation: { status: "ok" },
		});
		await expect(
			fetchTool.execute({ url: "https://example.test/recovery" }, executionContext),
		).resolves.toMatchObject({
			observation: { status: "ok" },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(pinnedFetch).toHaveBeenCalledTimes(2);
	});

	it("applies the active Run sandbox authority when re-executing an interrupted Web Tool", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "coda-recovery-web-sandbox-"));
		temporaryDirectories.push(workspacePath);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const pinnedFetch = vi.fn<WebPinnedFetch>(async (url, init) => fetch(url, init));
		const tools = await createInterruptedToolRecoveryCatalog({
			workspacePath,
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					throw new Error("recovery Web Tool must not spawn a process");
				},
			},
			homeDirectory: workspacePath,
			fetch,
			pinnedFetch,
			resolveHostname: async () => ["93.184.216.34"],
			settings: { load: async () => ({}), save: async () => undefined },
			clock: { now: () => 1_000 },
			environment: {},
			sandboxMode: () => "read-only",
		});
		const fetchTool = tools.find(({ name }) => name === "fetch");
		if (!fetchTool) throw new Error("recovery fetch Tool is missing");
		const executionContext: ToolExecutionContext = {
			signal: new AbortController().signal,
			runId: "run:recovery-sandbox" as ToolExecutionContext["runId"],
			turnId: "turn:recovery-sandbox" as ToolExecutionContext["turnId"],
			invocationId: "invocation:recovery-sandbox" as ToolExecutionContext["invocationId"],
			resultMessageId: "message:recovery-sandbox" as ToolExecutionContext["resultMessageId"],
			providerToolCallId: "provider:recovery-sandbox",
		};

		const result = await fetchTool.execute({ url: "https://example.test/recovery" }, executionContext);

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("not in sandbox.allowedDomains");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("fails interrupted Web re-execution closed without a pinned transport", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "coda-recovery-web-unpinned-"));
		temporaryDirectories.push(workspacePath);
		const fetch = vi.fn<typeof globalThis.fetch>();
		const tools = await createInterruptedToolRecoveryCatalog({
			workspacePath,
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					throw new Error("recovery Web Tool must not spawn a process");
				},
			},
			homeDirectory: workspacePath,
			fetch,
			resolveHostname: async () => ["93.184.216.34"],
			settings: { load: async () => ({}), save: async () => undefined },
			clock: { now: () => 1_000 },
			environment: {},
		});
		const fetchTool = tools.find(({ name }) => name === "fetch");
		if (!fetchTool) throw new Error("recovery fetch Tool is missing");
		const executionContext: ToolExecutionContext = {
			signal: new AbortController().signal,
			runId: "run:recovery-unpinned" as ToolExecutionContext["runId"],
			turnId: "turn:recovery-unpinned" as ToolExecutionContext["turnId"],
			invocationId: "invocation:recovery-unpinned" as ToolExecutionContext["invocationId"],
			resultMessageId: "message:recovery-unpinned" as ToolExecutionContext["resultMessageId"],
			providerToolCallId: "provider:recovery-unpinned",
		};

		const result = await fetchTool.execute({ url: "https://example.test/recovery" }, executionContext);

		expect(result.observation).toMatchObject({ status: "error", facts: { code: "fetch_failed" } });
		expect(result.content).toContain("Web access is unavailable in this host");
		expect(fetch).not.toHaveBeenCalled();
	});
});
