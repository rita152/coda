import {
	acceptedContent,
	type CallToolResult,
	createMcpHandler,
	type InputRequiredResult,
	inputRequired,
	McpServer,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createMcpHost, createSdkMcpConnector, type McpHost } from "../src/index.ts";

describe("official SDK Streamable HTTP adapter", () => {
	let host: McpHost | undefined;
	let closeHandler: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await host?.close();
		await closeHandler?.();
	});

	it("negotiates MCP 2026-07-28 and calls a discovered Tool", async () => {
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "calculator", version: "1.0.0" });
			server.registerTool(
				"add",
				{
					description: "Add two numbers",
					inputSchema: z.object({ left: z.number(), right: z.number() }),
					outputSchema: z.object({ sum: z.number() }),
				},
				async ({ left, right }) => ({
					content: [
						{
							type: "text",
							text: `${left} + ${right} = ${left + right}`,
							annotations: { audience: ["assistant" as const], priority: 0.7 },
							_meta: { source: "calculator" },
						},
					],
					structuredContent: { sum: left + right },
				}),
			);
			return server;
		});
		closeHandler = () => handler.close();
		const connector = createSdkMcpConnector({
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		});
		host = createMcpHost({ connector });

		const snapshot = await host.reload([
			{
				id: "calculator",
				protocol: "auto",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);

		expect(snapshot.servers).toEqual([
			expect.objectContaining({
				id: "calculator",
				status: "ready",
				protocolEra: "modern",
				protocolVersion: "2026-07-28",
				toolCount: 1,
			}),
		]);
		expect(snapshot.tools[0]).toEqual(
			expect.objectContaining({
				remoteName: "add",
				name: "mcp__calculator__add",
			}),
		);

		await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: { left: 7, right: 5 } })).resolves.toEqual(
			{
				isError: false,
				content: [
					{
						type: "text",
						text: "7 + 5 = 12",
						annotations: { audience: ["assistant"], priority: 0.7 },
						meta: { source: "calculator" },
					},
				],
				structuredContent: { sum: 12 },
				meta: {
					"io.modelcontextprotocol/serverInfo": { name: "calculator", version: "1.0.0" },
				},
			},
		);
	});

	it("supplies an externally resolved static bearer token without storing it in protocol state", async () => {
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "protected", version: "1.0.0" });
			server.registerTool("ping", { inputSchema: z.object({}) }, async () => ({
				content: [{ type: "text", text: "pong" }],
			}));
			return server;
		});
		closeHandler = () => handler.close();
		const authorization: Array<string | null> = [];
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => {
					const request = new Request(url, init);
					authorization.push(request.headers.get("authorization"));
					return handler.fetch(request);
				},
			}),
		});

		const snapshot = await host.reload([
			{
				id: "protected",
				protocol: "2026-07-28",
				transport: {
					kind: "http",
					url: "http://test.local/mcp",
					bearerToken: async () => "resolved-at-request-time",
				},
			},
		]);
		await host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} });

		expect(authorization.length).toBeGreaterThan(0);
		expect(authorization.every((value) => value === "Bearer resolved-at-request-time")).toBe(true);
	});

	it.each(["2025-11-25", "2025-06-18"])(
		"negotiates and calls a Tool through the legacy %s compatibility path",
		async (version) => {
			const handler = createMcpHandler(() => {
				const server = new McpServer(
					{ name: `legacy-${version}`, version: "1.0.0" },
					{ supportedProtocolVersions: [version] },
				);
				server.registerTool("ping", { inputSchema: z.object({}) }, async () => ({
					content: [{ type: "text", text: "pong" }],
				}));
				return server;
			});
			closeHandler = () => handler.close();
			host = createMcpHost({
				connector: createSdkMcpConnector({
					fetch: (url, init) => handler.fetch(new Request(url, init)),
				}),
			});

			const snapshot = await host.reload([
				{
					id: "legacy",
					protocol: "legacy",
					transport: { kind: "http", url: "http://test.local/mcp" },
				},
			]);

			expect(snapshot.servers).toEqual([
				expect.objectContaining({
					status: "ready",
					protocolEra: "legacy",
					protocolVersion: version,
				}),
			]);
			await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).resolves.toMatchObject({
				content: [{ type: "text", text: "pong" }],
			});
		},
	);

	it("fulfills a form Elicitation through the 2026 multi-round-trip flow", async () => {
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "deployments", version: "1.0.0" });
			const confirmation = z.object({ confirm: z.boolean() });
			server.registerTool(
				"deploy",
				{ description: "Deploy after confirmation", inputSchema: z.object({ environment: z.string() }) },
				async ({ environment }, context): Promise<CallToolResult | InputRequiredResult> => {
					const answer = acceptedContent(context.mcpReq.inputResponses, "confirm", confirmation);
					if (answer?.confirm !== true) {
						return inputRequired({
							inputRequests: {
								confirm: inputRequired.elicit({
									message: `Deploy to ${environment}?`,
									requestedSchema: confirmation,
								}),
							},
						});
					}
					return { content: [{ type: "text", text: `Deployed to ${environment}` }] };
				},
			);
			return server;
		});
		closeHandler = () => handler.close();
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		});
		const snapshot = await host.reload([
			{
				id: "deployments",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);
		const requests: unknown[] = [];

		const result = await host.callTool({
			toolId: snapshot.tools[0]!.id,
			arguments: { environment: "production" },
			elicit: async (request) => {
				requests.push(request);
				return { action: "accept", content: { confirm: true } };
			},
		});

		expect(requests).toEqual([
			{
				mode: "form",
				message: "Deploy to production?",
				requestedSchema: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					type: "object",
					properties: { confirm: { type: "boolean" } },
					required: ["confirm"],
				},
			},
		]);
		expect(result).toEqual(
			expect.objectContaining({
				isError: false,
				content: [{ type: "text", text: "Deployed to production" }],
			}),
		);
	});

	it("fulfills a URL Elicitation through the 2026 multi-round-trip flow", async () => {
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "accounts", version: "1.0.0" });
			server.registerTool(
				"protected",
				{ inputSchema: z.object({}) },
				async (_arguments, context): Promise<CallToolResult | InputRequiredResult> => {
					if (context.mcpReq.inputResponses?.auth !== undefined) {
						return { content: [{ type: "text", text: "authorized" }] };
					}
					return inputRequired({
						inputRequests: {
							auth: inputRequired.elicitUrl({
								message: "Sign in to continue",
								url: "https://accounts.example.test/authorize",
							}),
						},
					});
				},
			);
			return server;
		});
		closeHandler = () => handler.close();
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		});
		const snapshot = await host.reload([
			{
				id: "accounts",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);
		const requests: unknown[] = [];

		const result = await host.callTool({
			toolId: snapshot.tools[0]!.id,
			arguments: {},
			elicit: async (request) => {
				requests.push(request);
				return { action: "accept" };
			},
		});

		expect(requests).toEqual([
			{
				mode: "url",
				message: "Sign in to continue",
				url: "https://accounts.example.test/authorize",
			},
		]);
		expect(result.content).toEqual([{ type: "text", text: "authorized" }]);
	});

	it("rejects an over-limit Elicitation before presenting it to the Host", async () => {
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "unbounded", version: "1.0.0" });
			server.registerTool(
				"request-input",
				{ inputSchema: z.object({}) },
				async (_arguments, _context): Promise<CallToolResult | InputRequiredResult> =>
					inputRequired({
						inputRequests: {
							confirm: inputRequired.elicit({
								message: "x".repeat(33),
								requestedSchema: z.object({ confirm: z.boolean() }),
							}),
						},
					}),
			);
			return server;
		});
		closeHandler = () => handler.close();
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => handler.fetch(new Request(url, init)),
				limits: { maxElicitationMessageCharacters: 32 },
			}),
		});
		const snapshot = await host.reload([
			{
				id: "unbounded",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);
		let presented = false;

		await expect(
			host.callTool({
				toolId: snapshot.tools[0]!.id,
				arguments: {},
				elicit: async () => {
					presented = true;
					return { action: "decline" };
				},
			}),
		).rejects.toThrow("Elicitation message exceeds");
		expect(presented).toBe(false);
	});

	it("forwards progress and propagates cancellation to an in-flight modern call", async () => {
		let stalledStarted = false;
		let handlerAborted = false;
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "operations", version: "1.0.0" });
			server.registerTool(
				"operate",
				{ inputSchema: z.object({ stall: z.boolean() }) },
				async ({ stall }, context) => {
					const token = context.mcpReq._meta?.progressToken;
					if (token !== undefined) {
						await context.mcpReq.notify({
							method: "notifications/progress",
							params: { progressToken: token, progress: 1, total: 2, message: "started" },
						});
					}
					if (!stall) return { content: [{ type: "text", text: "done" }] };
					stalledStarted = true;
					return new Promise((_resolve, reject) => {
						context.mcpReq.signal.addEventListener(
							"abort",
							() => {
								handlerAborted = true;
								reject(new Error("server observed cancellation"));
							},
							{ once: true },
						);
					});
				},
			);
			return server;
		});
		closeHandler = () => handler.close();
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		});
		const snapshot = await host.reload([
			{
				id: "operations",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);
		const progress: unknown[] = [];
		await host.callTool({
			toolId: snapshot.tools[0]!.id,
			arguments: { stall: false },
			onProgress: (event) => progress.push(event),
		});
		expect(progress).toEqual([{ progress: 1, total: 2, message: "started" }]);

		const controller = new AbortController();
		const pending = host.callTool({
			toolId: snapshot.tools[0]!.id,
			arguments: { stall: true },
			signal: controller.signal,
		});
		pending.catch(() => undefined);
		await vi.waitFor(() => expect(stalledStarted).toBe(true));
		controller.abort(new Error("user cancelled"));
		await expect(pending).rejects.toThrow(/user cancelled|abort|cancel/u);
		await vi.waitFor(() => expect(handlerAborted).toBe(true));
	});

	it("marks the Catalog dirty from a modern toolsChanged subscription", async () => {
		let toolName = "first";
		const handler = createMcpHandler(() => {
			const server = new McpServer({ name: "dynamic", version: "1.0.0" });
			server.registerTool(toolName, { description: toolName, inputSchema: z.object({}) }, async () => ({
				content: [{ type: "text", text: toolName }],
			}));
			return server;
		});
		closeHandler = () => handler.close();
		host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch: (url, init) => handler.fetch(new Request(url, init)),
			}),
		});
		const initial = await host.reload([
			{
				id: "dynamic",
				protocol: "2026-07-28",
				transport: { kind: "http", url: "http://test.local/mcp" },
			},
		]);
		expect(initial.tools.map(({ remoteName }) => remoteName)).toEqual(["first"]);

		toolName = "second";
		await handler.notify.toolsChanged();
		let refreshed = initial;
		for (let attempt = 0; attempt < 50 && refreshed.revision === initial.revision; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			refreshed = await host.refresh();
		}

		expect(refreshed.revision).toBeGreaterThan(initial.revision);
		expect(refreshed.tools.map(({ remoteName }) => remoteName)).toEqual(["second"]);
	});
});
