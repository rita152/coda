import { describe, expect, it } from "vitest";
import { createMcpHost, createSdkMcpConnector } from "../src/index.ts";
import { redirectSafeFetch } from "../src/sdk-connector.ts";

const serverInfo = { name: "wire-fixture", version: "1.0.0" };

function requestMessage(init: RequestInit | undefined): Record<string, unknown> {
	if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
	return JSON.parse(init.body) as Record<string, unknown>;
}

function completeResult(id: unknown, result: Readonly<Record<string, unknown>>): Response {
	return Response.json({
		jsonrpc: "2.0",
		id,
		result: {
			resultType: "complete",
			ttlMs: 0,
			cacheScope: "private",
			...result,
			_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
		},
	});
}

function discover(id: unknown): Response {
	return Response.json({
		jsonrpc: "2.0",
		id,
		result: {
			supportedVersions: ["2026-07-28"],
			capabilities: { tools: {} },
			_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
		},
	});
}

const definition = {
	id: "wire",
	protocol: "2026-07-28" as const,
	transport: { kind: "http" as const, url: "https://wire.example.test/mcp" },
};

describe("official SDK wire bounds", () => {
	it("keeps client-generated authorization and MCP headers ahead of configured HTTP headers", async () => {
		const observed: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			observed.push(new Headers(init?.headers));
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			if (message.method === "tools/list") return completeResult(message.id, { tools: [] });
			return completeResult(message.id, {});
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch }) });

		try {
			await host.reload([
				{
					...definition,
					transport: {
						...definition.transport,
						headers: {
							Authorization: "Configured package data",
							"MCP-Protocol-Version": "configured-version",
							"MCP-Methodology": "retained-methodology",
							"MCP-Session-Id-Extension": "retained-extension",
						},
						bearerToken: async () => "client-owned-token",
					},
				},
			]);

			expect(observed.length).toBeGreaterThan(0);
			expect(observed.every((headers) => headers.get("authorization") === "Bearer client-owned-token")).toBe(true);
			expect(observed[0]!.get("mcp-protocol-version")).toBe("2026-07-28");
			expect(observed.every((headers) => headers.get("mcp-methodology") === "retained-methodology")).toBe(true);
			expect(observed.every((headers) => headers.get("mcp-session-id-extension") === "retained-extension")).toBe(
				true,
			);
		} finally {
			await host.close();
		}
	});

	it("follows redirects without forwarding configured headers to a different origin", async () => {
		const redirectedHeaders: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.origin === "https://wire.example.test") {
				expect(init?.redirect).toBe("manual");
				return new Response(null, {
					status: 307,
					headers: { location: "https://other.example.test/mcp" },
				});
			}
			redirectedHeaders.push(new Headers(init?.headers));
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			if (message.method === "tools/list") return completeResult(message.id, { tools: [] });
			return completeResult(message.id, {});
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch }) });

		try {
			const snapshot = await host.reload([
				{
					...definition,
					transport: {
						...definition.transport,
						headers: { "X-Plugin-Tenant": "public-package-value" },
					},
				},
			]);

			expect(snapshot.servers[0]).toMatchObject({ status: "ready" });
			expect(redirectedHeaders.length).toBeGreaterThan(0);
			expect(redirectedHeaders.every((headers) => !headers.has("x-plugin-tenant"))).toBe(true);
			expect(redirectedHeaders.every((headers) => !headers.has("mcp-session-id"))).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("does not forward MCP session or resumption state across origins", async () => {
		const redirectedHeaders: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			if (url.origin === "https://wire.example.test") {
				return new Response(null, {
					status: 307,
					headers: { location: "https://other.example.test/mcp" },
				});
			}
			redirectedHeaders.push(new Headers(init?.headers));
			return new Response(null, { status: 204 });
		};
		const safeFetch = redirectSafeFetch(fetch, []);

		await safeFetch("https://wire.example.test/mcp", {
			method: "POST",
			headers: {
				"MCP-Session-Id": "client-session-secret",
				"Last-Event-ID": "client-resumption-secret",
			},
		});

		expect(redirectedHeaders).toHaveLength(1);
		expect(redirectedHeaders[0]?.has("mcp-session-id")).toBe(false);
		expect(redirectedHeaders[0]?.has("last-event-id")).toBe(false);
	});

	it("rejects a redirect that downgrades a public endpoint to HTTP", async () => {
		const requested: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			requested.push(input instanceof Request ? input.url : input.toString());
			return new Response(null, {
				status: 307,
				headers: { location: "http://public.example.test/mcp" },
			});
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch }) });

		try {
			const snapshot = await host.reload([definition]);

			expect(snapshot.servers).toEqual([
				expect.objectContaining({ status: "degraded", error: expect.stringContaining("downgrade") }),
			]);
			expect(requested).toEqual(["https://wire.example.test/mcp"]);
		} finally {
			await host.close();
		}
	});

	it("rejects invalid limit combinations at construction", () => {
		expect(() => createSdkMcpConnector({ limits: { listMaxPages: 0 } })).toThrow("listMaxPages");
		expect(() => createSdkMcpConnector({ limits: { callTimeoutMs: 100, callTotalTimeoutMs: 50 } })).toThrow(
			"callTotalTimeoutMs",
		);
	});

	it("aggregates bounded pagination before publishing a Tool Catalog", async () => {
		const cursors: unknown[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			if (message.method !== "tools/list") throw new Error(`Unexpected method: ${String(message.method)}`);
			const cursor = (message.params as Record<string, unknown> | undefined)?.cursor;
			cursors.push(cursor);
			const page = cursor === undefined ? 1 : cursor === "second" ? 2 : 3;
			return completeResult(message.id, {
				tools: [{ name: `tool-${page}`, inputSchema: { type: "object", properties: {} } }],
				...(page === 1 ? { nextCursor: "second" } : page === 2 ? { nextCursor: "third" } : {}),
			});
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch, limits: { listMaxPages: 3 } }) });

		try {
			const snapshot = await host.reload([definition]);
			expect(snapshot.tools.map(({ remoteName }) => remoteName)).toEqual(["tool-1", "tool-2", "tool-3"]);
			expect(cursors).toEqual([undefined, "second", "third"]);
		} finally {
			await host.close();
		}
	});

	it("degrades instead of publishing a partial Catalog when pagination exceeds its cap", async () => {
		let page = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			page++;
			return completeResult(message.id, {
				tools: [{ name: "partial", inputSchema: { type: "object", properties: {} } }],
				nextCursor: `page-${page}`,
			});
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch, limits: { listMaxPages: 2 } }) });

		try {
			const snapshot = await host.reload([definition]);
			expect(snapshot.servers).toEqual([
				expect.objectContaining({ status: "degraded", error: expect.stringContaining("listMaxPages") }),
			]);
			expect(snapshot.tools).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("does not retry a Tool call after a transport-ambiguous dispatch", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			if (message.method === "tools/list") {
				return completeResult(message.id, {
					tools: [{ name: "mutate", inputSchema: { type: "object", properties: {} } }],
				});
			}
			if (message.method === "tools/call") {
				calls++;
				throw new TypeError("connection reset after dispatch");
			}
			throw new Error(`Unexpected method: ${String(message.method)}`);
		};
		const host = createMcpHost({ connector: createSdkMcpConnector({ fetch }) });

		try {
			const snapshot = await host.reload([definition]);
			await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).rejects.toThrow(
				"connection reset after dispatch",
			);
			expect(calls).toBe(1);
		} finally {
			await host.close();
		}
	});

	it("enforces an absolute Tool-call deadline even when the request stalls", async () => {
		let calls = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			const message = requestMessage(init);
			if (message.method === "server/discover") return discover(message.id);
			if (message.method === "tools/list") {
				return completeResult(message.id, {
					tools: [{ name: "stall", inputSchema: { type: "object", properties: {} } }],
				});
			}
			if (message.method !== "tools/call") throw new Error(`Unexpected method: ${String(message.method)}`);
			calls++;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
					once: true,
				});
			});
		};
		const host = createMcpHost({
			connector: createSdkMcpConnector({
				fetch,
				limits: { callTimeoutMs: 20, callTotalTimeoutMs: 40 },
			}),
		});

		try {
			const snapshot = await host.reload([definition]);
			await expect(host.callTool({ toolId: snapshot.tools[0]!.id, arguments: {} })).rejects.toThrow(
				/timeout|timed out|abort/u,
			);
			expect(calls).toBe(1);
		} finally {
			await host.close();
		}
	});
});
