import { describe, expect, it } from "vitest";
import { createMcpHost, type McpConnection, type McpConnector, type McpServerDefinition } from "../src/index.ts";

describe("MCP Host", () => {
	it("rejects unsafe Host limit overrides at construction", () => {
		expect(() =>
			createMcpHost({
				connector: { connect: async () => Promise.reject(new Error("unused")) },
				limits: { maxResultBytes: -1 },
			}),
		).toThrow("maxResultBytes");
		expect(() =>
			createMcpHost({
				connector: { connect: async () => Promise.reject(new Error("unused")) },
				limits: { maxSchemaNodes: Number.POSITIVE_INFINITY },
			}),
		).toThrow("maxSchemaNodes");
		expect(() =>
			createMcpHost({
				connector: { connect: async () => Promise.reject(new Error("unused")) },
				limits: { maxModelToolNameCharacters: 20 },
			}),
		).toThrow("maxModelToolNameCharacters");
	});

	it("rejects an empty semantic Server identity before connection", async () => {
		let connections = 0;
		const host = createMcpHost({
			connector: {
				connect: async () => {
					connections++;
					throw new Error("must not connect");
				},
			},
		});

		await expect(
			host.reload([
				{
					id: "docs",
					semanticName: "",
					protocol: "auto",
					transport: { kind: "http", url: "https://docs.example.test/mcp" },
				},
			]),
		).rejects.toThrow('Invalid MCP Server semantic name ""');
		expect(connections).toBe(0);
		await host.close();
	});

	it("freezes a stable namespaced Tool Catalog and routes calls by canonical identity", async () => {
		const calls: Array<{ readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }> = [];
		const connection: McpConnection = {
			info: {
				protocolEra: "modern",
				protocolVersion: "2026-07-28",
				server: { name: "reference-docs", version: "1.0.0" },
			},
			listTools: async () => [
				{
					name: "search",
					description: "Search the reference documentation",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
					meta: { ui: { visibility: ["model"] } },
				},
			],
			callTool: async (request) => {
				calls.push({ name: request.name, arguments: request.arguments });
				return {
					isError: false,
					content: [{ type: "text", text: `Found ${String(request.arguments.query)}` }],
				};
			},
			close: async () => undefined,
		};
		const connector: McpConnector = {
			connect: async () => connection,
		};
		const definition: McpServerDefinition = {
			id: "docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://mcp.example.test" },
		};
		const host = createMcpHost({ connector });

		const snapshot = await host.reload([definition]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({
				id: "docs",
				semanticName: "docs",
				status: "ready",
				protocolEra: "modern",
				protocolVersion: "2026-07-28",
				toolCount: 1,
			}),
		]);
		expect(snapshot.tools).toEqual([
			expect.objectContaining({
				id: "mcp:docs:search",
				serverId: "docs",
				serverSemanticName: "docs",
				remoteName: "search",
				name: "mcp__docs__search",
				description: "Search the reference documentation",
				meta: { ui: { visibility: ["model"] } },
			}),
		]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.tools)).toBe(true);

		const result = await host.callTool({
			toolId: snapshot.tools[0]!.id,
			arguments: { query: "MCP" },
		});

		expect(result).toEqual({ isError: false, content: [{ type: "text", text: "Found MCP" }] });
		expect(calls).toEqual([{ name: "search", arguments: { query: "MCP" } }]);
		await host.close();
	});

	it("projects one semantic Server name while routing Tools through the internal Server id", async () => {
		const connectedIds: string[] = [];
		const calledTools: string[] = [];
		const host = createMcpHost({
			connector: {
				connect: async (definition) => {
					connectedIds.push(definition.id);
					return {
						info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
						listTools: async () => [{ name: "Search", inputSchema: { type: "object", properties: {} } }],
						callTool: async ({ name }) => {
							calledTools.push(name);
							return { isError: false, content: [] };
						},
						close: async () => undefined,
					};
				},
			},
		});
		const internalId = `p_${"a".repeat(62)}`;

		const snapshot = await host.reload([
			{
				id: internalId,
				semanticName: "portable-tools:Docs",
				protocol: "auto",
				transport: { kind: "http", url: "https://docs.example.test/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({ id: internalId, semanticName: "portable-tools:Docs" }),
		]);
		expect(snapshot.tools).toEqual([
			expect.objectContaining({
				id: `mcp:${internalId}:Search`,
				serverId: internalId,
				serverSemanticName: "portable-tools:Docs",
			}),
		]);
		await host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} });
		expect(connectedIds).toEqual([internalId]);
		expect(calledTools).toEqual(["Search"]);
		await host.close();
	});

	it("retains the semantic Server name in degraded state and diagnostics", async () => {
		const internalId = `p_${"b".repeat(62)}`;
		const host = createMcpHost({
			connector: {
				connect: async () => {
					throw new Error("upstream unavailable");
				},
			},
		});

		const snapshot = await host.reload([
			{
				id: internalId,
				semanticName: "portable-tools:Docs",
				protocol: "auto",
				transport: { kind: "http", url: "https://docs.example.test/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({
				id: internalId,
				semanticName: "portable-tools:Docs",
				status: "degraded",
			}),
		]);
		expect(snapshot.diagnostics).toEqual([
			expect.objectContaining({
				serverId: internalId,
				serverSemanticName: "portable-tools:Docs",
				message: "upstream unavailable",
			}),
		]);
		await host.close();
	});

	it("retains a leased connection generation across reload until exactly-once disposal", async () => {
		const closes = [0, 0];
		const calls: string[] = [];
		let connectionGeneration = 0;
		const connector: McpConnector = {
			connect: async () => {
				const generation = connectionGeneration++;
				const remoteName = generation === 0 ? "old" : "new";
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [{ name: remoteName, inputSchema: { type: "object", properties: {} } }],
					callTool: async ({ name }) => {
						calls.push(`${generation}:${name}`);
						return { isError: false, content: [{ type: "text", text: remoteName }] };
					},
					close: async () => {
						closes[generation] = (closes[generation] ?? 0) + 1;
					},
				};
			},
		};
		const definition: McpServerDefinition = {
			id: "generation",
			protocol: "2026-07-28",
			transport: { kind: "http", url: "https://generation.example.test/mcp" },
		};
		const host = createMcpHost({ connector });
		await host.reload([definition]);
		const activeRun = host.acquireTools();

		await host.reload([definition]);
		const nextRun = host.acquireTools();

		expect(closes).toEqual([0, 0]);
		expect(activeRun.revision).toBe(1);
		expect(activeRun.tools.map(({ remoteName }) => remoteName)).toEqual(["old"]);
		expect(nextRun.revision).toBe(2);
		expect(nextRun.tools.map(({ remoteName }) => remoteName)).toEqual(["new"]);
		await activeRun.callTool({ toolId: activeRun.tools[0]!.id, arguments: {} });
		await nextRun.callTool({ toolId: nextRun.tools[0]!.id, arguments: {} });
		expect(calls).toEqual(["0:old", "1:new"]);

		await Promise.all([activeRun.dispose(), activeRun.dispose(), activeRun.dispose()]);
		expect(closes).toEqual([1, 0]);
		await nextRun.dispose();
		expect(closes).toEqual([1, 0]);
		await host.close();
		expect(closes).toEqual([1, 1]);
	});

	it("isolates a failed Server while keeping healthy Tools available", async () => {
		const healthy: McpConnection = {
			info: { protocolEra: "legacy", protocolVersion: "2025-11-25" },
			listTools: async () => [
				{
					name: "lookup",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async () => ({ isError: false, content: [{ type: "text", text: "healthy" }] }),
			close: async () => undefined,
		};
		const connector: McpConnector = {
			connect: async (definition) => {
				if (definition.id === "broken") throw new Error("process exited before discovery");
				return healthy;
			},
		};
		const host = createMcpHost({ connector });

		const snapshot = await host.reload([
			{
				id: "broken",
				protocol: "2026-07-28",
				transport: { kind: "stdio", command: "/missing/server" },
			},
			{
				id: "healthy",
				protocol: "legacy",
				transport: { kind: "http", url: "https://healthy.example.test/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({
				id: "broken",
				status: "degraded",
				toolCount: 0,
				error: "process exited before discovery",
			}),
			expect.objectContaining({ id: "healthy", status: "ready", toolCount: 1 }),
		]);
		expect(snapshot.diagnostics).toEqual([
			{
				serverId: "broken",
				serverSemanticName: "broken",
				code: "mcp.server-unavailable",
				message: "process exited before discovery",
			},
		]);
		expect(snapshot.tools.map(({ name }) => name)).toEqual(["mcp__healthy__lookup"]);
		await host.close();
	});

	it("isolates a Server with an ambiguous Tool catalog", async () => {
		const connector: McpConnector = {
			connect: async (definition) => ({
				info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
				listTools: async () =>
					definition.id === "ambiguous"
						? [
								{ name: "same", inputSchema: { type: "object", properties: {} } },
								{ name: "same", inputSchema: { type: "object", properties: {} } },
							]
						: [{ name: "healthy", inputSchema: { type: "object", properties: {} } }],
				callTool: async () => ({ isError: false, content: [] }),
				close: async () => undefined,
			}),
		};
		const host = createMcpHost({ connector });

		const snapshot = await host.reload([
			{
				id: "ambiguous",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://ambiguous.example.test/mcp" },
			},
			{
				id: "healthy",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://healthy.example.test/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({ id: "ambiguous", status: "degraded", toolCount: 0 }),
			expect.objectContaining({ id: "healthy", status: "ready", toolCount: 1 }),
		]);
		expect(snapshot.tools.map(({ remoteName }) => remoteName)).toEqual(["healthy"]);
		expect(snapshot.diagnostics[0]).toEqual(
			expect.objectContaining({ serverId: "ambiguous", code: "mcp.server-invalid-catalog" }),
		);
		await host.close();
	});

	it("quarantines every model-name collision without a discovery-order winner", async () => {
		const names = new Map<string, string>();
		const changed = new Map<string, () => void>();
		const connector: McpConnector = {
			connect: async (server, context) => {
				if (context?.onToolsChanged) changed.set(server.id, context.onToolsChanged);
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{ name: names.get(server.id) ?? "lookup", inputSchema: { type: "object", properties: {} } },
					],
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		// These ids share the same first eight SHA-256 hex characters, which
		// deliberately collides their truncated Server segments at this limit.
		const first = "s89095longlong";
		const second = "s113802longlong";
		const definition = (id: string): McpServerDefinition => ({
			id,
			protocol: "2026-07-28",
			transport: { kind: "http", url: `https://${id}.example.test/mcp` },
		});
		const host = createMcpHost({ connector, limits: { maxModelToolNameCharacters: 29 } });

		for (const definitions of [
			[definition(first), definition(second)],
			[definition(second), definition(first)],
		]) {
			const snapshot = await host.reload(definitions);
			expect(snapshot.tools).toEqual([]);
			expect(snapshot.servers).toEqual([
				expect.objectContaining({ id: definitions[0]!.id, status: "ready", toolCount: 0 }),
				expect.objectContaining({ id: definitions[1]!.id, status: "ready", toolCount: 0 }),
			]);
			expect(
				snapshot.diagnostics
					.filter(({ code }) => code === "mcp.tool-name-collision")
					.map(({ serverId, toolName }) => `${serverId}/${toolName}`)
					.sort(),
			).toEqual([`${first}/lookup`, `${second}/lookup`].sort());
		}

		names.set(second, "other");
		changed.get(second)?.();
		const recovered = await host.refresh();
		expect(recovered.tools.map(({ remoteName }) => remoteName).sort()).toEqual(["lookup", "other"]);
		expect(recovered.servers).toEqual([
			expect.objectContaining({ id: second, status: "ready", toolCount: 1 }),
			expect.objectContaining({ id: first, status: "ready", toolCount: 1 }),
		]);
		expect(recovered.diagnostics.filter(({ code }) => code === "mcp.tool-name-collision")).toEqual([]);
		await host.close();
	});

	it("admits only filtered safe Schemas and quarantines an invalid Tool", async () => {
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "public.search",
					description: "Search public data",
					inputSchema: {
						type: "object",
						properties: { query: { $ref: "#/$defs/query" } },
						$defs: { query: { type: "string" } },
					},
				},
				{
					name: "public.remote-schema",
					inputSchema: { type: "object", $ref: "https://schemas.example.test/tool.json" },
				},
				{
					name: "secret.erase",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const host = createMcpHost({ connector: { connect: async () => connection } });

		const snapshot = await host.reload([
			{
				id: "catalog",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://catalog.example.test/mcp" },
				tools: { include: ["public.*"], exclude: ["*.remote-schema"] },
			},
		]);

		expect(snapshot.tools).toHaveLength(1);
		expect(snapshot.tools[0]).toEqual(
			expect.objectContaining({
				remoteName: "public.search",
				name: expect.stringMatching(/^mcp__catalog__public_search__[a-f0-9]{8}$/u),
			}),
		);
		expect(snapshot.tools[0]!.name.length).toBeLessThanOrEqual(64);
		expect(snapshot.servers[0]).toEqual(expect.objectContaining({ status: "ready", toolCount: 1 }));
		expect(snapshot.diagnostics).toEqual([]);
		await host.close();
	});

	it("reports a remote Schema reference without dropping sibling Tools", async () => {
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{ name: "safe", inputSchema: { type: "object", properties: {} } },
				{
					name: "unsafe",
					inputSchema: { type: "object", properties: { value: { $ref: "https://example.test/value" } } },
				},
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const host = createMcpHost({ connector: { connect: async () => connection } });

		const snapshot = await host.reload([
			{
				id: "schemas",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://schemas.example.test/mcp" },
			},
		]);

		expect(snapshot.tools.map(({ remoteName }) => remoteName)).toEqual(["safe"]);
		expect(snapshot.servers[0]).toEqual(expect.objectContaining({ status: "ready", toolCount: 1 }));
		expect(snapshot.diagnostics).toEqual([
			{
				serverId: "schemas",
				serverSemanticName: "schemas",
				toolName: "unsafe",
				code: "mcp.tool-invalid-schema",
				message: "inputSchema contains a non-local $ref",
			},
		]);
		await host.close();
	});

	it("validates Tool input before crossing the connection seam", async () => {
		let calls = 0;
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "search",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
						additionalProperties: false,
					},
				},
			],
			callTool: async () => {
				calls++;
				return { isError: false, content: [] };
			},
			close: async () => undefined,
		};
		const host = createMcpHost({ connector: { connect: async () => connection } });
		const snapshot = await host.reload([
			{
				id: "validation",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://validation.example.test/mcp" },
			},
		]);

		await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).rejects.toThrow(
			/Invalid arguments for MCP Tool "validation\/search".*query/u,
		);
		expect(calls).toBe(0);
		await host.callTool({ toolId: snapshot.tools[0]!.id, arguments: { query: "valid" } });
		expect(calls).toBe(1);
		await host.close();
	});

	it("does not require structured output for an MCP Tool error result", async () => {
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "fallible",
					inputSchema: { type: "object", properties: {} },
					outputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
					},
				},
			],
			callTool: async () => ({
				isError: true,
				content: [{ type: "text", text: "remote operation failed" }],
			}),
			close: async () => undefined,
		};
		const host = createMcpHost({ connector: { connect: async () => connection } });
		const snapshot = await host.reload([
			{
				id: "errors",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://errors.example.test/mcp" },
			},
		]);

		await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).resolves.toEqual({
			isError: true,
			content: [{ type: "text", text: "remote operation failed" }],
		});
		await host.close();
	});

	it("rejects an oversized Tool result before it enters Agent state", async () => {
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [{ name: "large", inputSchema: { type: "object", properties: {} } }],
			callTool: async () => ({
				isError: false,
				content: [{ type: "text", text: "sensitive".repeat(100) }],
			}),
			close: async () => undefined,
		};
		const host = createMcpHost({
			connector: { connect: async () => connection },
			limits: { maxResultBytes: 64 },
		});
		const snapshot = await host.reload([
			{
				id: "bounds",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://bounds.example.test/mcp" },
			},
		]);

		await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).rejects.toThrow(
			'MCP Tool "bounds/large" exceeded the result byte limit',
		);
		await host.close();
	});

	it("applies a Tool change notification only when the next snapshot refreshes", async () => {
		let changed: (() => void) | undefined;
		let generation = 1;
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: generation === 1 ? "first" : "second",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const host = createMcpHost({
			connector: {
				connect: async (_definition, context) => {
					changed = context?.onToolsChanged;
					return connection;
				},
			},
		});
		await host.reload([
			{
				id: "dynamic",
				semanticName: "portable-tools:Docs",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://dynamic.example.test/mcp" },
			},
		]);
		const observed: number[] = [];
		const unsubscribe = host.onDidChange((snapshot) => observed.push(snapshot.revision));

		generation = 2;
		changed?.();
		expect(host.snapshot().tools.map(({ remoteName }) => remoteName)).toEqual(["first"]);
		const refreshed = await host.refresh();

		expect(refreshed.revision).toBe(2);
		expect(refreshed.tools.map(({ remoteName }) => remoteName)).toEqual(["second"]);
		expect(refreshed.servers).toEqual([
			expect.objectContaining({ id: "dynamic", semanticName: "portable-tools:Docs", status: "ready" }),
		]);
		expect(refreshed.tools).toEqual([
			expect.objectContaining({ serverId: "dynamic", serverSemanticName: "portable-tools:Docs" }),
		]);
		expect(observed).toEqual([2]);
		expect((await host.refresh()).revision).toBe(2);
		unsubscribe();
		await host.close();
	});

	it("retains semantic identity when a notified Tool refresh degrades the Server", async () => {
		let changed: (() => void) | undefined;
		let failRefresh = false;
		const host = createMcpHost({
			connector: {
				connect: async (_definition, context) => {
					changed = context?.onToolsChanged;
					return {
						info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
						listTools: async () => {
							if (failRefresh) throw new Error("catalog unavailable");
							return [{ name: "search", inputSchema: { type: "object", properties: {} } }];
						},
						callTool: async () => ({ isError: false, content: [] }),
						close: async () => undefined,
					};
				},
			},
		});
		await host.reload([
			{
				id: "dynamic-failure",
				semanticName: "portable-tools:Docs",
				protocol: "auto",
				transport: { kind: "http", url: "https://docs.example.test/mcp" },
			},
		]);

		failRefresh = true;
		changed?.();
		const refreshed = await host.refresh();

		expect(refreshed.servers).toEqual([
			expect.objectContaining({
				id: "dynamic-failure",
				semanticName: "portable-tools:Docs",
				status: "degraded",
			}),
		]);
		expect(refreshed.diagnostics).toEqual([
			expect.objectContaining({
				serverId: "dynamic-failure",
				serverSemanticName: "portable-tools:Docs",
				message: "catalog unavailable",
			}),
		]);
		await host.close();
	});

	it("keeps a Run Tool Snapshot bound to the discovery revision that created it", async () => {
		let changed: (() => void) | undefined;
		let generation = 1;
		const calls: string[] = [];
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: generation === 1 ? "first" : "second",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async ({ name }) => {
				calls.push(name);
				return { isError: false, content: [{ type: "text", text: name }] };
			},
			close: async () => undefined,
		};
		const host = createMcpHost({
			connector: {
				connect: async (_definition, context) => {
					changed = context?.onToolsChanged;
					return connection;
				},
			},
		});
		await host.reload([
			{
				id: "snapshot",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://snapshot.example.test/mcp" },
			},
		]);
		const runTools = host.acquireTools();

		generation = 2;
		changed?.();
		await host.refresh();

		expect(runTools.revision).toBe(1);
		expect(runTools.servers).toEqual([expect.objectContaining({ id: "snapshot", status: "ready" })]);
		expect(runTools.tools.map(({ remoteName }) => remoteName)).toEqual(["first"]);
		expect(host.snapshot().tools.map(({ remoteName }) => remoteName)).toEqual(["second"]);
		await expect(runTools.callTool({ toolId: runTools.tools[0]!.id, arguments: {} })).resolves.toEqual({
			isError: false,
			content: [{ type: "text", text: "first" }],
		});
		expect(calls).toEqual(["first"]);
		await runTools.dispose();
		await host.close();
	});

	it("degrades on disconnect and restores the Catalog after an explicit reconnect", async () => {
		let disconnected: ((error?: Error) => void) | undefined;
		let connectCount = 0;
		const connector: McpConnector = {
			connect: async (_definition, context) => {
				connectCount++;
				disconnected = context?.onClose;
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{
							name: "status",
							inputSchema: { type: "object", properties: {} },
						},
					],
					callTool: async () => ({ isError: false, content: [{ type: "text", text: "ready" }] }),
					close: async () => undefined,
				};
			},
		};
		const host = createMcpHost({ connector });
		const initial = await host.reload([
			{
				id: "recoverable",
				semanticName: "portable-tools:Docs",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://recoverable.example.test/mcp" },
			},
		]);
		const toolId = initial.tools[0]!.id;

		disconnected?.(new Error("connection lost"));

		expect(host.snapshot().servers).toEqual([
			expect.objectContaining({
				id: "recoverable",
				semanticName: "portable-tools:Docs",
				status: "degraded",
				error: "connection lost",
			}),
		]);
		expect(host.snapshot().tools).toEqual([]);
		await expect(host.callTool({ toolId, arguments: {} })).rejects.toThrow(
			'MCP Server "recoverable" is unavailable: connection lost',
		);

		const restored = await host.reconnect("recoverable");
		expect(connectCount).toBe(2);
		expect(restored.servers).toEqual([
			expect.objectContaining({ id: "recoverable", semanticName: "portable-tools:Docs", status: "ready" }),
		]);
		expect(restored.tools).toEqual([
			expect.objectContaining({ serverId: "recoverable", serverSemanticName: "portable-tools:Docs" }),
		]);
		expect(restored.tools.map(({ id }) => id)).toEqual([toolId]);
		await host.close();
	});

	it("serializes Catalog transitions and ignores failures while closing superseded connections", async () => {
		let releaseFirstList: (() => void) | undefined;
		const transitionOrder: string[] = [];
		let connectCount = 0;
		const connector: McpConnector = {
			connect: async () => {
				connectCount++;
				const currentConnect = connectCount;
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => {
						transitionOrder.push(`list:${currentConnect}:start`);
						if (currentConnect === 1) {
							await new Promise<void>((resolve) => {
								releaseFirstList = resolve;
							});
						}
						transitionOrder.push(`list:${currentConnect}:end`);
						return [
							{
								name: `tool-${currentConnect}`,
								inputSchema: { type: "object", properties: {} },
							},
						];
					},
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => {
						if (currentConnect === 1) throw new Error("superseded close failed");
					},
				};
			},
		};
		const definition: McpServerDefinition = {
			id: "serialized",
			protocol: "2026-07-28",
			transport: { kind: "http", url: "https://serialized.example.test/mcp" },
		};
		const host = createMcpHost({ connector });

		const first = host.reload([definition]);
		const second = host.reload([definition]);
		await expect.poll(() => transitionOrder).toEqual(["list:1:start"]);
		releaseFirstList?.();

		await expect(first).resolves.toEqual(expect.objectContaining({ revision: 1 }));
		await expect(second).resolves.toEqual(expect.objectContaining({ revision: 2 }));
		expect(transitionOrder).toEqual(["list:1:start", "list:1:end", "list:2:start", "list:2:end"]);
		expect(host.snapshot().tools.map(({ remoteName }) => remoteName)).toEqual(["tool-2"]);
		await host.close();
	});

	it("does not publish a connection that closes during discovery", async () => {
		const connector: McpConnector = {
			connect: async (_definition, context) => ({
				info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
				listTools: async () => {
					context?.onClose?.(new Error("closed during discovery"));
					return [{ name: "stale", inputSchema: { type: "object", properties: {} } }];
				},
				callTool: async () => ({ isError: false, content: [] }),
				close: async () => undefined,
			}),
		};
		const host = createMcpHost({ connector });

		const snapshot = await host.reload([
			{
				id: "early-close",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://early-close.example.test/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({ status: "degraded", error: "closed during discovery" }),
		]);
		expect(snapshot.tools).toEqual([]);
		await host.close();
	});

	it("keeps long Server identities within the model Tool-name limit", async () => {
		const connection: McpConnection = {
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{ name: "a-remote-tool-with-a-readable-name", inputSchema: { type: "object", properties: {} } },
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		};
		const host = createMcpHost({ connector: { connect: async () => connection } });

		const snapshot = await host.reload([
			{
				id: "a-very-long-server-identity-that-needs-bounding-for-model-tools",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "https://long.example.test/mcp" },
			},
		]);

		expect(snapshot.tools[0]!.name).toMatch(/^mcp__a-very-long-server-identity.*__[a-f0-9]{8}__/u);
		expect(snapshot.tools[0]!.name.length).toBeLessThanOrEqual(64);
		await host.close();
	});
});
