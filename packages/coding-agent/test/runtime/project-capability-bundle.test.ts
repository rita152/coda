import type { AgentTool } from "@coda/agent";
import type { McpToolLease } from "@coda/mcp";
import { createRunCapabilityHost, type RunToolContribution } from "@coda/runtime";
import { describe, expect, it } from "vitest";
import { createMcpCapabilitySource } from "../../src/mcp/run-capability.ts";
import { createPluginsCapabilitySource } from "../../src/plugins/run-capability.ts";
import type { CodingPluginsSnapshot } from "../../src/plugins/types.ts";
import type { ProjectRunCapabilityBundle } from "../../src/runtime/project-capability-bundle.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { createSkillsCapabilitySource } from "../../src/skills/run-capability.ts";

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

const emptyPlugins: CodingPluginsSnapshot = Object.freeze({
	installations: Object.freeze([]),
	plugins: Object.freeze([]),
	snapshots: Object.freeze([]),
	skills: Object.freeze([]),
	mcpSources: Object.freeze([]),
	diagnostics: Object.freeze([]),
});

describe("Project Run capability bundle", () => {
	it("binds Plugin prompt, combined Skills, and Plugin MCP to one scoped bundle", async () => {
		const skillsManager = new CodingSkillsManager({
			fileSystem: {
				readFile: async () => new Uint8Array(),
				readDirectory: async () => [],
				realpath: async (path: string) => path,
				stat: async () => ({ kind: "directory" as const, size: 0 }),
				lstat: async () => ({ kind: "directory" as const, size: 0 }),
			},
			roots: [],
		});
		const skills = await skillsManager.refresh();
		let bundleAcquisitions = 0;
		let bundleDisposals = 0;
		const mcp: McpToolLease & { readonly agentPluginServerIds: readonly string[] } = Object.freeze({
			revision: 11,
			servers: Object.freeze([]),
			tools: Object.freeze([]),
			agentPluginServerIds: Object.freeze([]),
			callTool: async () => {
				throw new Error("not used");
			},
			dispose: async () => undefined,
		});
		const acquireProjectBundle = async (): Promise<ProjectRunCapabilityBundle> => {
			bundleAcquisitions++;
			return Object.freeze({
				revision: "project:atomic-7",
				plugins: emptyPlugins,
				skills,
				mcp,
				dispose: () => {
					bundleDisposals++;
				},
			});
		};
		const host = createRunCapabilityHost({
			model: {
				acquire: () => ({
					model,
					revision: "model:1",
					stream: () => {
						throw new Error("not used");
					},
					complete: async () => {
						throw new Error("not used");
					},
					dispose: () => undefined,
				}),
			},
			contributors: [
				createSkillsCapabilitySource({ acquireProjectBundle }),
				createPluginsCapabilitySource({ acquireProjectBundle }),
				createMcpCapabilitySource({ acquireProjectBundle }),
			],
			now: () => 0,
			platform: "linux",
			interactionMode: "evaluation",
		});

		const lease = await host.acquire({
			selection: { model, reasoning: "off", authSnapshot: { auth: {} } },
			placement: { placementId: "main", root: "/workspace", baseIdentity: "base", kind: "memory" },
			mode: "write",
			baseTools: Object.freeze([]),
			bindTools: (tools: readonly RunToolContribution[]): readonly AgentTool[] => tools.map(({ tool }) => tool),
			signal: new AbortController().signal,
		});

		expect(bundleAcquisitions).toBe(1);
		expect(lease.revisions.filter(({ source }) => source !== "model")).toEqual([
			expect.objectContaining({ source: "mcp", revision: expect.stringContaining("project:atomic-7;") }),
			expect.objectContaining({ source: "plugins", revision: expect.stringContaining("project:atomic-7;") }),
			expect.objectContaining({ source: "skills", revision: expect.stringContaining("project:atomic-7;") }),
		]);
		await Promise.all([lease.dispose(), lease.dispose()]);
		expect(bundleDisposals).toBe(1);
	});
});
