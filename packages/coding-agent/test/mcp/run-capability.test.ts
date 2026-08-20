import type { ToolExecutionContext } from "@coda/agent";
import type { Model } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import type { CodingMcpToolLease } from "../../src/mcp/registry.ts";
import { createMcpCapabilitySource } from "../../src/mcp/run-capability.ts";

const model = Object.freeze({
	id: "model",
	name: "Model",
	api: "test",
	provider: "provider",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_000,
}) as Model;

function lease(
	toolIds: readonly string[],
	dispose = vi.fn(async () => undefined),
	options: {
		readonly agentPluginServerIds?: readonly string[];
		readonly description?: (id: string) => string;
		readonly meta?: (id: string) => Readonly<Record<string, unknown>> | undefined;
		readonly semanticName?: (serverId: string) => string;
	} = {},
): CodingMcpToolLease {
	const serverIds = [...new Set(toolIds.map((id) => id.split(":")[1]!))];
	return {
		revision: 7,
		servers: serverIds.map((id) => ({
			id,
			semanticName: options.semanticName?.(id) ?? id,
			status: "ready" as const,
			toolCount: toolIds.filter((toolId) => toolId.split(":")[1] === id).length,
		})),
		tools: toolIds.map((id) => {
			const serverId = id.split(":")[1]!;
			const remoteName = id.split(":").at(-1)!;
			return {
				id,
				serverId,
				serverSemanticName: options.semanticName?.(serverId) ?? serverId,
				remoteName,
				name: `mcp__${serverId}__${remoteName}`,
				description: options.description?.(id) ?? remoteName,
				inputSchema: { type: "object", properties: {} },
				...(options.meta?.(id) ? { meta: options.meta(id) } : {}),
			};
		}),
		callTool: async () => ({ isError: false, content: [] }),
		dispose,
		agentPluginServerIds: Object.freeze([...(options.agentPluginServerIds ?? [])]),
	};
}

const acquireContext = (toolIds: readonly string[]) => ({
	model,
	signal: new AbortController().signal,
	selection: { toolIds },
});

describe("MCP Run capability selection", () => {
	it("isolates adjacent selection revisions while directly exposing the ready catalog", async () => {
		const source = createMcpCapabilitySource({
			acquire: () => lease(["mcp:docs:tool-b", "mcp:docs:tool-a"]),
		});

		const [first, second] = await Promise.all([
			source.acquire(acquireContext(["mcp:docs:tool-a"])),
			source.acquire(acquireContext(["mcp:docs:tool-b"])),
		]);

		expect(first.tools.map(({ tool }) => tool.name)).toEqual(["mcp__docs__tool-a", "mcp__docs__tool-b"]);
		expect(second.tools.map(({ tool }) => tool.name)).toEqual(["mcp__docs__tool-a", "mcp__docs__tool-b"]);
		expect(first.revision).toContain("mcp:docs:tool-a");
		expect(second.revision).toContain("mcp:docs:tool-b");
		expect(first.revision).not.toBe(second.revision);
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("unions an explicit child Tool selection with its inherited parent selection", () => {
		const source = createMcpCapabilitySource({ acquire: () => lease([]) });

		expect(
			source.mergeSelection?.(
				{ toolIds: ["mcp:docs:parent", "mcp:docs:shared"] },
				{ toolIds: ["mcp:docs:child", "mcp:docs:shared"] },
			),
		).toEqual({
			toolIds: ["mcp:docs:child", "mcp:docs:parent", "mcp:docs:shared"],
		});
	});

	it("fails closed and disposes the catalog lease when a selected Tool disappeared before acquisition", async () => {
		const dispose = vi.fn(async () => undefined);
		const source = createMcpCapabilitySource({ acquire: () => lease(["mcp:docs:tool-b"], dispose) });

		await expect(source.acquire(acquireContext(["mcp:docs:tool-a"]))).rejects.toThrow(
			"Selected MCP Tool is no longer available: mcp:docs:tool-a",
		);
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("directly exposes and calls an Agent Plugin MCP Tool without an explicit selection", async () => {
		const source = createMcpCapabilitySource({
			acquire: () =>
				lease(["mcp:opaque-server:inspect"], undefined, {
					agentPluginServerIds: ["opaque-server"],
					semanticName: () => "portable-tools:Docs",
				}),
		});

		const acquired = await source.acquire(acquireContext([]));
		expect(acquired.tools.map(({ tool }) => tool.name)).toEqual(["mcp__opaque-server__inspect"]);
		expect(acquired.tools[0]!.tool.description).toBe("Agent Plugin MCP Server portable-tools:Docs — inspect");
		await expect(
			acquired.tools[0]!.tool.execute({}, {
				signal: new AbortController().signal,
				runId: "run:test",
				turnId: "turn:test",
				invocationId: "invocation:test",
				resultMessageId: "message:test",
				providerToolCallId: "provider:test",
			} as ToolExecutionContext),
		).resolves.toMatchObject({
			observation: { status: "ok" },
			details: {
				serverId: "opaque-server",
				serverSemanticName: "portable-tools:Docs",
			},
		});
		await acquired.dispose();
	});

	it("diagnoses and hides over-budget Agent Plugin Tools even when explicitly selected", async () => {
		const pluginIds = Array.from({ length: 10 }, (_, index) => `mcp:opaque-server:tool-${index}`);
		const ordinaryId = "mcp:native-server:oversized-native";
		const diagnostics: Array<{ readonly code: string; readonly toolId: string }> = [];
		const source = createMcpCapabilitySource({
			acquire: () =>
				lease([...pluginIds, ordinaryId], undefined, {
					agentPluginServerIds: ["opaque-server"],
					semanticName: (serverId) => (serverId === "opaque-server" ? "portable-tools:Docs" : serverId),
					description: (id) => "x".repeat(id === ordinaryId ? 20_000 : id.endsWith("tool-9") ? 8_000 : 7_000),
				}),
			diagnostic: (diagnostic) => {
				diagnostics.push(diagnostic);
			},
		});

		const acquired = await source.acquire(acquireContext([pluginIds[9]!]));
		const visibleNames = acquired.tools.map(({ tool }) => tool.name);
		expect(visibleNames).toContain("mcp__native-server__oversized-native");
		expect(visibleNames).not.toContain("mcp__opaque-server__tool-9");
		expect(visibleNames.filter((name) => name.startsWith("mcp__opaque-server__"))).toHaveLength(8);
		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp.agent-plugin-total-budget-exceeded",
				serverSemanticName: "portable-tools:Docs",
				toolId: pluginIds[8],
			}),
			expect.objectContaining({
				code: "mcp.agent-plugin-tool-budget-exceeded",
				serverSemanticName: "portable-tools:Docs",
				toolId: pluginIds[9],
			}),
		]);
		await acquired.dispose();
	});

	it("omits MCP Tools whose ui visibility metadata does not include model", async () => {
		const source = createMcpCapabilitySource({
			acquire: () =>
				lease(["mcp:docs:model", "mcp:docs:app"], undefined, {
					meta: (id) => ({ ui: { visibility: [id.endsWith(":model") ? "model" : "app"] } }),
				}),
		});

		const acquired = await source.acquire(acquireContext([]));
		expect(acquired.tools.map(({ tool }) => tool.name)).toEqual(["mcp__docs__model"]);
		await acquired.dispose();
	});
});
