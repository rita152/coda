import type { McpHostSnapshot } from "@coda/mcp";
import { describe, expect, it } from "vitest";
import { openMcpCommand } from "../../src/commands/mcp-flow.ts";
import { CommandFlowHost } from "../../src/interactive/command-flow-host.ts";

const host: McpHostSnapshot = {
	revision: 2,
	servers: [
		{
			id: "docs",
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
});
