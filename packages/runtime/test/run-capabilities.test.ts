import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import { describe, expect, it } from "vitest";
import {
	createRunCapabilityHost,
	type ModelDriverSource,
	type RunCapabilitySource,
	type RunToolContribution,
} from "../src/index.ts";

const model = Object.freeze({
	id: "model",
	name: "Model",
	api: "test",
	provider: "provider",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text" as const],
	contextWindow: 128_000,
	maxTokens: 16_000,
});

function tool(name: string): AgentTool {
	return Object.freeze({
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		replaySafety: "safe",
		execute: async () => ({ content: name }),
	});
}

function modelSource(dispose: () => void = () => undefined): ModelDriverSource {
	return {
		acquire: () => ({
			model,
			revision: "provider:7",
			stream: () => {
				throw new Error("not used");
			},
			complete: async () => {
				throw new Error("not used");
			},
			dispose,
		}),
	};
}

function source(
	id: string,
	options: {
		readonly tool?: string;
		readonly fragment?: string;
		readonly dispose?: () => void;
	} = {},
): RunCapabilitySource {
	return Object.freeze({
		id,
		acquire: () =>
			Object.freeze({
				revision: `${id}:1`,
				tools: Object.freeze(
					options.tool ? [Object.freeze({ tool: tool(options.tool), effect: "read" as const })] : [],
				),
				promptFragments: Object.freeze(options.fragment ? [Object.freeze({ id, text: options.fragment })] : []),
				dispose: options.dispose ?? (() => undefined),
			}),
	});
}

function context(baseTools: readonly RunToolContribution[] = []) {
	return {
		selection: { model, reasoning: "off" as const, authSnapshot: { auth: {} } },
		placement: {
			placementId: "placement",
			root: "/workspace",
			baseIdentity: "base",
			kind: "memory" as const,
		},
		mode: "write" as const,
		baseTools,
		bindTools: (contributions: readonly RunToolContribution[]) => contributions.map(({ tool: entry }) => entry),
		signal: new AbortController().signal,
	};
}

describe("RunCapabilityHost Interface", () => {
	it("assembles trusted sources deterministically and disposes every resource exactly once", async () => {
		const disposals = { model: 0, alpha: 0, zeta: 0 };
		const host = createRunCapabilityHost({
			model: modelSource(() => disposals.model++),
			contributors: [
				source("zeta", { tool: "zeta", fragment: "ZETA", dispose: () => disposals.zeta++ }),
				source("alpha", { tool: "alpha", fragment: "ALPHA", dispose: () => disposals.alpha++ }),
			],
			now: () => 0,
			platform: "linux",
			interactionMode: "evaluation",
		});

		const lease = await host.acquire(context([{ tool: tool("base"), effect: "read" }]));
		expect(lease.tools.map(({ name }) => name)).toEqual(["base", "alpha", "zeta"]);
		expect(lease.prompt.text.indexOf("ALPHA")).toBeLessThan(lease.prompt.text.indexOf("ZETA"));
		expect(lease.revisions).toEqual([
			{ source: "model", revision: "provider:7" },
			{ source: "alpha", revision: "alpha:1" },
			{ source: "zeta", revision: "zeta:1" },
		]);

		await Promise.all([lease.dispose(), lease.dispose(), lease.dispose()]);
		expect(disposals).toEqual({ model: 1, alpha: 1, zeta: 1 });
	});

	it("rolls back already acquired resources when a later source fails", async () => {
		let modelDisposals = 0;
		let sourceDisposals = 0;
		const host = createRunCapabilityHost({
			model: modelSource(() => modelDisposals++),
			contributors: [
				source("alpha", { dispose: () => sourceDisposals++ }),
				{ id: "zeta", acquire: () => Promise.reject(new Error("source failed")) },
			],
			now: () => 0,
			platform: "linux",
			interactionMode: "evaluation",
		});

		await expect(host.acquire(context())).rejects.toThrow("source failed");
		expect({ modelDisposals, sourceDisposals }).toEqual({ modelDisposals: 1, sourceDisposals: 1 });
	});

	it("disposes a late resource after canceled acquisition without delaying cancellation", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markDisposed!: () => void;
		const disposed = new Promise<void>((resolve) => {
			markDisposed = resolve;
		});
		let modelDisposals = 0;
		let lateDisposals = 0;
		const controller = new AbortController();
		const host = createRunCapabilityHost({
			model: modelSource(() => modelDisposals++),
			contributors: [
				{
					id: "late",
					acquire: async () => {
						markStarted();
						await gate;
						return {
							revision: "late:1",
							tools: [],
							promptFragments: [],
							dispose: () => {
								lateDisposals++;
								markDisposed();
							},
						};
					},
				},
			],
			now: () => 0,
			platform: "linux",
			interactionMode: "evaluation",
		});
		const acquisition = host.acquire({ ...context(), signal: controller.signal });
		await started;
		controller.abort(new DOMException("canceled", "AbortError"));

		await expect(acquisition).rejects.toThrow("canceled");
		expect(modelDisposals).toBe(1);
		release();
		await disposed;
		expect(lateDisposals).toBe(1);
	});

	it("rolls back all executable resources when Prompt preparation fails", async () => {
		let modelDisposals = 0;
		let sourceDisposals = 0;
		const host = createRunCapabilityHost({
			model: modelSource(() => modelDisposals++),
			contributors: [source("source", { dispose: () => sourceDisposals++ })],
			now: () => 0,
			platform: "linux",
			interactionMode: "evaluation",
			projectInstructions: async () => {
				throw new Error("instructions failed");
			},
		});

		await expect(host.acquire(context())).rejects.toThrow("instructions failed");
		expect({ modelDisposals, sourceDisposals }).toEqual({ modelDisposals: 1, sourceDisposals: 1 });
	});
});
