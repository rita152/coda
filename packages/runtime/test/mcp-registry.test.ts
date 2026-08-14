import type { McpHost, McpHostSnapshot } from "@coda/mcp";
import { describe, expect, it, vi } from "vitest";
import { CodingMcpRegistry } from "../src/mcp/registry.ts";

function snapshot(status: "ready" | "degraded", revision: number): McpHostSnapshot {
	return {
		revision,
		servers: [
			{
				id: "unstable",
				status,
				toolCount: status === "ready" ? 1 : 0,
				...(status === "degraded" ? { error: "offline" } : {}),
			},
		],
		tools: [],
		diagnostics: [],
	};
}

describe("CodingMcpRegistry", () => {
	it("uses bounded reconnect backoff and stops once the Server recovers", async () => {
		let current = snapshot("ready", 1);
		let listener: ((value: McpHostSnapshot) => void) | undefined;
		let reconnects = 0;
		const host = {
			reload: async () => current,
			refresh: async () => current,
			reconnect: async () => {
				reconnects++;
				current = reconnects === 1 ? snapshot("degraded", 3) : snapshot("ready", 4);
				listener?.(current);
				return current;
			},
			snapshot: () => current,
			freezeTools: () => ({
				revision: current.revision,
				servers: current.servers,
				tools: [],
				callTool: async () => ({ isError: false, content: [] }),
			}),
			onDidChange: (next: (value: McpHostSnapshot) => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		} satisfies McpHost;
		const scheduled: Array<{ delay: number; run: () => void; cancelled: boolean }> = [];
		const registry = new CodingMcpRegistry({
			host,
			reconnectDelaysMs: [1_000, 2_000],
			scheduler: {
				schedule: (delay, run) => {
					const task = { delay, run, cancelled: false };
					scheduled.push(task);
					return {
						cancel: () => {
							task.cancelled = true;
						},
					};
				},
			},
		});

		current = snapshot("degraded", 2);
		listener?.(current);
		expect(scheduled.map(({ delay }) => delay)).toEqual([1_000]);

		scheduled[0]!.run();
		await vi.waitFor(() => {
			expect(reconnects).toBe(1);
			expect(scheduled.map(({ delay }) => delay)).toEqual([1_000, 2_000]);
		});

		scheduled[1]!.run();
		await vi.waitFor(() => {
			expect(reconnects).toBe(2);
			expect(registry.snapshot().servers[0]?.status).toBe("ready");
		});
		expect(scheduled).toHaveLength(2);
		await registry.close();
	});
});
