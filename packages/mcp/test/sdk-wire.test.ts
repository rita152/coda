import { describe, expect, it } from "vitest";
import { createMcpHost, createSdkMcpConnector } from "../src/index.ts";

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
