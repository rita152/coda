import type { McpHostSnapshot } from "@coda/mcp";
import { describe, expect, it } from "vitest";
import { openMcpCommand } from "../../src/commands/mcp-flow.ts";
import { CommandFlowHost } from "../../src/ui/command-flow-host.ts";

const host: McpHostSnapshot = {
	revision: 2,
	servers: [
		{
			id: "docs",
			semanticName: "docs",
			status: "ready",
			protocolEra: "modern",
			protocolVersion: "2026-07-28",
			toolCount: 1,
		},
	],
	tools: [
		{
			id: "mcp:docs:search",
			serverId: "docs",
			serverSemanticName: "docs",
			remoteName: "search",
			name: "mcp__docs__search",
			description: "Search docs",
			inputSchema: { type: "object", properties: {} },
		},
	],
	diagnostics: [],
};

describe("MCP command flow", () => {
	it("supports direct status and inspect subcommands without editing configuration", async () => {
		const flow = new CommandFlowHost();
		const options = {
			snapshot: async () => ({ host }),
			reload: async () => ({ host }),
			reconnect: async () => ({ host }),
		};

		await openMcpCommand(flow, "status", options);
		expect(flow.view).toMatchObject({
			breadcrumb: ["MCP / Status"],
			items: [expect.objectContaining({ id: "docs", status: "ready" })],
		});

		await openMcpCommand(flow, "inspect docs", options);
		expect(flow.view).toMatchObject({
			breadcrumb: ["MCP / Inspect / docs"],
			items: [expect.objectContaining({ id: "mcp:docs:search", label: "mcp__docs__search" })],
		});
	});

	it("routes reload and explicit reconnect to operational callbacks", async () => {
		const flow = new CommandFlowHost();
		const operations: string[] = [];
		const options = {
			snapshot: async () => ({ host }),
			reload: async () => {
				operations.push("reload");
				return { host };
			},
			reconnect: async (serverId: string) => {
				operations.push(`reconnect:${serverId}`);
				return { host };
			},
		};

		await openMcpCommand(flow, "reload", options);
		await openMcpCommand(flow, "reconnect docs", options);
		expect(operations).toEqual(["reload", "reconnect:docs"]);
		await expect(openMcpCommand(flow, "unknown", options)).rejects.toThrow("Unknown /mcp action");
	});

	it("displays and accepts a Plugin Server semantic name while reconnecting its internal id", async () => {
		const internalId = `p_${"a".repeat(62)}`;
		const pluginHost: McpHostSnapshot = {
			revision: 3,
			servers: [
				{
					id: internalId,
					semanticName: "portable-tools:Docs",
					status: "degraded",
					toolCount: 1,
					error: "HTTP 401",
				},
			],
			tools: [
				{
					id: `mcp:${internalId}:search`,
					serverId: internalId,
					serverSemanticName: "portable-tools:Docs",
					remoteName: "search",
					name: `mcp__${internalId}__search`,
					description: "Search docs",
					inputSchema: { type: "object", properties: {} },
				},
			],
			diagnostics: [
				{
					serverId: internalId,
					serverSemanticName: "portable-tools:Docs",
					code: "mcp.server-unavailable",
					message: "HTTP 401",
				},
			],
		};
		const flow = new CommandFlowHost();
		const reconnected: string[] = [];
		const options = {
			snapshot: async () => ({ host: pluginHost }),
			reload: async () => ({ host: pluginHost }),
			reconnect: async (serverId: string) => {
				reconnected.push(serverId);
				return { host: pluginHost };
			},
		};

		await openMcpCommand(flow, "status", options);
		expect(flow.view?.items).toEqual([expect.objectContaining({ id: internalId, label: "portable-tools:Docs" })]);
		await openMcpCommand(flow, "inspect portable-tools:Docs", options);
		expect(flow.view).toMatchObject({
			breadcrumb: ["MCP / Inspect / portable-tools:Docs"],
			items: [expect.objectContaining({ label: "portable-tools:Docs/search" })],
		});
		await openMcpCommand(flow, "doctor", options);
		expect(flow.view?.items).toEqual([expect.objectContaining({ description: "portable-tools:Docs: HTTP 401" })]);
		await openMcpCommand(flow, "reconnect portable-tools:Docs", options);
		expect(reconnected).toEqual([internalId]);
	});
});
