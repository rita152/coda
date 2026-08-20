import { access, lstat, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpHost, createSdkMcpConnector } from "../src/index.ts";
import { materializeStdioEnvironment } from "../src/sdk-connector.ts";

function wireFetch(): typeof globalThis.fetch {
	return async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
		const message = JSON.parse(init.body) as Record<string, unknown>;
		if (message.method === "server/discover") {
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					supportedVersions: ["2026-07-28"],
					capabilities: { tools: {} },
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "http-sibling", version: "1.0.0" } },
				},
			});
		}
		return Response.json({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				resultType: "complete",
				ttlMs: 0,
				cacheScope: "private",
				...(message.method === "tools/list" ? { tools: [] } : {}),
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "http-sibling", version: "1.0.0" } },
			},
		});
	};
}

describe("official SDK stdio adapter", () => {
	it("keeps one admitted Path spelling under Windows environment semantics", () => {
		const environment = materializeStdioEnvironment({ Path: "C:\\tools" }, "win32");

		expect(environment.Path).toBe("C:\\tools");
		expect(Object.keys(environment).filter((name) => name.toLowerCase() === "path")).toEqual(["Path"]);
	});

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

	it("runs a runtime-only launch guard before stdio spawn and keeps an HTTP sibling ready", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "coda-mcp-launch-guard-")));
		const outside = await realpath(await mkdtemp(join(tmpdir(), "coda-mcp-launch-outside-")));
		const command = join(root, "server");
		const displaced = join(root, "server-displaced");
		const outsideCommand = join(outside, "server");
		const marker = join(outside, "spawned");
		await writeFile(command, "original\n");
		await writeFile(outsideCommand, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		const identity = await lstat(command);
		await rename(command, displaced);
		await symlink(outsideCommand, command);
		let guardCalls = 0;
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch: wireFetch() }) });
		try {
			const snapshot = await host.reload([
				{
					id: "guarded",
					protocol: "auto",
					transport: {
						kind: "stdio",
						command,
						beforeLaunch: async (signal) => {
							guardCalls++;
							signal?.throwIfAborted();
							const current = await lstat(command);
							if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
								throw new Error("stdio launch lease changed");
							}
						},
					},
				},
				{
					id: "remote",
					protocol: "2026-07-28",
					transport: { kind: "http", url: "https://example.test/mcp" },
				},
			]);

			expect(guardCalls).toBe(1);
			expect(snapshot.servers).toEqual([
				expect.objectContaining({ id: "guarded", status: "degraded", error: "stdio launch lease changed" }),
				expect.objectContaining({ id: "remote", status: "ready" }),
			]);
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await host.close();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("passes connector cancellation to the stdio launch guard and never starts the child", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel guarded launch");
		let observedSignal: AbortSignal | undefined;
		const connector = createSdkMcpConnector();

		await expect(
			connector.connect(
				{
					id: "guarded",
					protocol: "auto",
					transport: {
						kind: "stdio",
						command: "/coda/must-not-spawn",
						beforeLaunch: async (signal) => {
							observedSignal = signal;
							controller.abort(reason);
							signal?.throwIfAborted();
						},
					},
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		expect(observedSignal).toBe(controller.signal);
	});
});
