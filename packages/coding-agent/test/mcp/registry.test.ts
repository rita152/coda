import { createMcpHost, type McpConnector, type McpServerDefinition } from "@coda/mcp";
import { describe, expect, it } from "vitest";
import { CodingMcpRegistry } from "../../src/mcp/registry.ts";

const definition = (id: string): McpServerDefinition => ({
	id,
	protocol: "auto",
	transport: { kind: "http", url: `https://${id}.example.test/mcp` },
});

describe("CodingMcpRegistry provenance", () => {
	it("freezes exact Agent Plugin Server provenance for each hot-reloaded Tool lease", async () => {
		const connector: McpConnector = {
			connect: async (server) => ({
				info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
				listTools: async () => [
					{
						name: "inspect",
						description: `Inspect through ${server.id}`,
						inputSchema: { type: "object", properties: {} },
					},
				],
				callTool: async () => ({ isError: false, content: [] }),
				close: async () => undefined,
			}),
		};
		const registry = new CodingMcpRegistry({ host: createMcpHost({ connector }) });
		const firstDefinition = definition("opaque-server");
		const secondDefinition = definition("plugin_looking_but_native");

		try {
			await registry.reload([firstDefinition], { agentPluginServerIds: [firstDefinition.id] });
			const first = registry.acquireTools();
			expect(first.agentPluginServerIds).toEqual(["opaque-server"]);

			await registry.reload([secondDefinition], { agentPluginServerIds: [] });
			const second = registry.acquireTools();
			expect(second.agentPluginServerIds).toEqual([]);
			expect(first.agentPluginServerIds).toEqual(["opaque-server"]);
			expect(first.revision).not.toBe(second.revision);

			await Promise.all([first.dispose(), second.dispose()]);
		} finally {
			await registry.close();
		}
	});
});
