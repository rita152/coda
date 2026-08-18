import { describe, expect, it } from "vitest";
import {
	mcpExtensionEntries,
	mcpServerIdFromCommandId,
	mcpToolIdFromCommandId,
	mcpToolsForCommandId,
} from "../../src/commands/mcp-extensions.ts";

const tools = Object.freeze([
	{
		id: "mcp:docs:search",
		serverId: "docs",
		remoteName: "search",
		name: "mcp__docs__search",
		description: "Search docs",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		id: "mcp:docs:lookup",
		serverId: "docs",
		remoteName: "lookup",
		name: "mcp__docs__lookup",
		description: "Look up a page",
		inputSchema: { type: "object" as const, properties: {} },
	},
]);

describe("MCP Composer extensions", () => {
	it("projects unique `$` names for Servers and Tools without colliding command ids", () => {
		const entries = mcpExtensionEntries({
			revision: 1,
			servers: [{ id: "docs", status: "ready", protocolEra: "modern", protocolVersion: "2026-07-28", toolCount: 2 }],
			tools,
			diagnostics: [],
		});
		expect(entries.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: "scope:server:docs", name: "docs" },
			{ id: "docs:lookup", name: "lookup" },
			{ id: "docs:search", name: "search" },
		]);
		expect(mcpServerIdFromCommandId("mcp:scope:server:docs")).toBe("docs");
		expect(mcpToolIdFromCommandId("mcp:docs:search")).toBe("mcp:docs:search");
		expect(mcpToolsForCommandId("mcp:scope:server:docs", tools).map(({ remoteName }) => remoteName)).toEqual([
			"search",
			"lookup",
		]);
		expect(mcpToolsForCommandId("mcp:docs:search", tools).map(({ id }) => id)).toEqual(["mcp:docs:search"]);
	});
});
