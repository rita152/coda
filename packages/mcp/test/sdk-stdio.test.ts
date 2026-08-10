import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpHost, createSdkMcpConnector } from "../src/index.ts";

describe("official SDK stdio adapter", () => {
	it("pins MCP 2026-07-28, calls a Tool, and closes the child", async () => {
		const previousAmbient = process.env.CODA_MCP_AMBIENT_SECRET;
		process.env.CODA_MCP_AMBIENT_SECRET = "must-not-leak";
		const stderr: string[] = [];
		const connector = createSdkMcpConnector({
			onStderr: (serverId, chunk) => stderr.push(`${serverId}:${chunk}`),
		});
		const host = createMcpHost({ connector });
		try {
			const snapshot = await host.reload([
				{
					id: "fixture",
					protocol: "2026-07-28",
					transport: {
						kind: "stdio",
						command: process.execPath,
						args: [fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url))],
						cwd: process.cwd(),
						environment: { CODA_MCP_FIXTURE: "allowed" },
					},
				},
			]);

			expect(snapshot.servers[0]).toEqual(
				expect.objectContaining({
					status: "ready",
					protocolEra: "modern",
					protocolVersion: "2026-07-28",
				}),
			);
			await expect(
				host.callTool({ toolId: snapshot.tools[0]!.id, arguments: { text: "stdio works" } }),
			).resolves.toEqual(
				expect.objectContaining({
					isError: false,
					content: [{ type: "text", text: "stdio works" }],
				}),
			);
			const environmentTool = snapshot.tools.find(({ remoteName }) => remoteName === "environment");
			await expect(host.callTool({ toolId: environmentTool!.id, arguments: {} })).resolves.toEqual(
				expect.objectContaining({
					content: [{ type: "text", text: '{"allowed":"allowed"}' }],
				}),
			);
			expect(stderr).toEqual([]);
		} finally {
			await host.close();
			if (previousAmbient === undefined) delete process.env.CODA_MCP_AMBIENT_SECRET;
			else process.env.CODA_MCP_AMBIENT_SECRET = previousAmbient;
		}
	});

	it("isolates a stdio process that cannot be started", async () => {
		const host = createMcpHost({ connector: createSdkMcpConnector({ limits: { connectTimeoutMs: 500 } }) });
		try {
			const snapshot = await host.reload([
				{
					id: "missing",
					protocol: "2026-07-28",
					transport: {
						kind: "stdio",
						command: "/coda/definitely/missing-mcp-server",
						cwd: process.cwd(),
						environment: {},
					},
				},
			]);
			expect(snapshot.servers).toEqual([expect.objectContaining({ status: "degraded", toolCount: 0 })]);
			expect(snapshot.tools).toEqual([]);
		} finally {
			await host.close();
		}
	});
});
