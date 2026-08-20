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
		serverSemanticName: "docs",
		remoteName: "search",
		name: "mcp__docs__search",
		description: "Search docs",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		id: "mcp:docs:lookup",
		serverId: "docs",
		serverSemanticName: "docs",
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
			servers: [
				{
					id: "docs",
					semanticName: "docs",
					status: "ready",
					protocolEra: "modern",
					protocolVersion: "2026-07-28",
					toolCount: 2,
				},
			],
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

	it("uses a Plugin Server semantic name in Composer while retaining its internal command identity", () => {
		const internalId = `p_${"a".repeat(62)}`;
		const pluginTools = Object.freeze([
			{
				id: `mcp:${internalId}:search`,
				serverId: internalId,
				serverSemanticName: "portable-tools:Docs",
				remoteName: "search",
				name: `mcp__${internalId}__search`,
				description: "Search docs",
				inputSchema: { type: "object" as const, properties: {} },
			},
		]);

		const entries = mcpExtensionEntries({
			revision: 2,
			servers: [
				{
					id: internalId,
					semanticName: "portable-tools:Docs",
					status: "ready",
					toolCount: 1,
				},
			],
			tools: pluginTools,
			diagnostics: [],
		});

		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: `scope:server:${encodeURIComponent(internalId)}`,
					name: "portable-tools:Docs",
					title: "portable-tools:Docs MCP Server",
					description:
						"Reference every Tool from MCP Server portable-tools:Docs and require it to remain available for this Run",
				}),
			]),
		);
		expect(mcpServerIdFromCommandId(`mcp:scope:server:${encodeURIComponent(internalId)}`)).toBe(internalId);
		expect(
			mcpToolsForCommandId(`mcp:scope:server:${encodeURIComponent(internalId)}`, pluginTools).map(({ id }) => id),
		).toEqual([`mcp:${internalId}:search`]);
	});
});
