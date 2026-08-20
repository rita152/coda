import type { SkillId } from "@coda/skills";
import { describe, expect, it, vi } from "vitest";
import {
	createSkillMcpDependencyCoordinator,
	type SkillMcpDependencyDecisionRequest,
} from "../../src/skills/mcp-dependency-coordinator.ts";
import type { ResolvedCodingSkill } from "../../src/skills/types.ts";

function selectedSkill(name: string, dependencies: ResolvedCodingSkill["dependencies"]): ResolvedCodingSkill {
	return {
		candidate: {
			id: `skill:${name.padEnd(32, "0").slice(0, 32)}` as SkillId,
			metadata: { name, description: `${name} workflow` },
		},
		origin: { scope: "user", root: "/home/test/.agents/skills", priority: 2 },
		precedence: 2,
		winner: true,
		collisionCount: 1,
		sourceLabel: "~/.agents/skills",
		qualifiedName: name,
		implicitInvocation: true,
		dependencies,
	} as ResolvedCodingSkill;
}

describe("Skill MCP dependency coordinator", () => {
	it("prompts once per canonical dependency in a Session and installs an accepted plan", async () => {
		const decide = vi.fn(async (_request: SkillMcpDependencyDecisionRequest) => "install" as const);
		const install = vi.fn(async () => undefined);
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [],
			decide,
			install,
		});
		const skills = [
			selectedSkill("review", {
				tools: [
					{
						type: "mcp",
						value: "docs",
						transport: "streamable_http",
						url: "https://docs.example.test/mcp",
					},
				],
			}),
		];

		const first = await coordinator.prepare({
			selectedSkills: skills,
			signal: new AbortController().signal,
		});
		const second = await coordinator.prepare({
			selectedSkills: skills,
			signal: new AbortController().signal,
		});

		expect(first.outcome).toBe("installed");
		expect(second.outcome).toBe("already-prompted");
		expect(decide).toHaveBeenCalledOnce();
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Install MCP servers?",
				message:
					"The following MCP servers are required by the selected skills but are not installed yet: docs [https://docs.example.test/mcp; requested by Skill review]. Install them now?",
				choices: [
					{
						id: "install",
						label: "Install",
						description: "Install and enable the missing MCP servers in your global config.",
					},
					{
						id: "continue",
						label: "Continue anyway",
						description: "Skip installation for now and do not show again for these MCP servers in this session.",
					},
				],
			}),
		);
		expect(install).toHaveBeenCalledWith(
			expect.objectContaining({
				missing: [expect.objectContaining({ canonicalKey: "mcp__streamable_http__https://docs.example.test/mcp" })],
			}),
		);
	});

	it("shows canonical command and Agent Plugin provenance in consent", async () => {
		const decide = vi.fn(async () => "continue" as const);
		const pluginRoot = "/plugins/review-tools";
		const pluginSkill = {
			...selectedSkill("release", {
				tools: [{ type: "mcp", value: "local", transport: "stdio", command: "./bin/server" }],
			}),
			origin: {
				scope: "workspace" as const,
				root: pluginRoot,
				priority: 1,
				kind: "plugin" as const,
				pluginName: "review-tools",
				pluginRoot,
			},
			sourceLabel: "review-tools@workspace-local",
			qualifiedName: "review-tools:release",
		};
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [],
			decide,
			install: vi.fn(async () => undefined),
		});

		await coordinator.prepare({ selectedSkills: [pluginSkill], signal: new AbortController().signal });

		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					'The following MCP servers are required by the selected skills but are not installed yet: local [/plugins/review-tools/bin/server; requested by Plugin "review-tools" (review-tools@workspace-local), Skill review-tools:release]. Install them now?',
			}),
		);
	});

	it("never prompts or installs an escaping Plugin Skill command", async () => {
		const decide = vi.fn(async () => "install" as const);
		const install = vi.fn(async () => undefined);
		const diagnostic = vi.fn(async () => undefined);
		const pluginRoot = "/plugins/review-tools";
		const pluginSkill = {
			...selectedSkill("release", {
				tools: [{ type: "mcp", value: "escaped", transport: "stdio", command: "../outside" }],
			}),
			origin: {
				scope: "workspace" as const,
				root: pluginRoot,
				priority: 1,
				kind: "plugin" as const,
				pluginName: "review-tools",
				pluginRoot,
			},
			qualifiedName: "review-tools:release",
		};
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [],
			decide,
			install,
			reportDiagnostic: diagnostic,
		});

		await expect(
			coordinator.prepare({ selectedSkills: [pluginSkill], signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "not-needed" });
		expect(decide).not.toHaveBeenCalled();
		expect(install).not.toHaveBeenCalled();
		expect(diagnostic).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-invalid", dependency: "escaped" }),
		);
	});

	it("continues without installation and suppresses the same prompt for the rest of the Session", async () => {
		const decide = vi.fn(async () => "continue" as const);
		const install = vi.fn(async () => undefined);
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [],
			decide,
			install,
		});
		const selectedSkills = [
			selectedSkill("shell-helper", {
				tools: [{ type: "mcp", value: "local", transport: "stdio", command: "local-mcp" }],
			}),
		];

		await expect(
			coordinator.prepare({ selectedSkills, signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "continued" });
		await expect(
			coordinator.prepare({ selectedSkills, signal: new AbortController().signal }),
		).resolves.toMatchObject({ outcome: "already-prompted" });
		expect(decide).toHaveBeenCalledOnce();
		expect(install).not.toHaveBeenCalled();
	});

	it("does not prompt for configured canonical equivalents and reports invalid declarations", async () => {
		const decide = vi.fn(async () => "install" as const);
		const diagnostics = vi.fn(async () => undefined);
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [
				{ id: "existing", transport: { kind: "http", url: "https://docs.example.test/mcp" } },
			],
			decide,
			install: vi.fn(async () => undefined),
			reportDiagnostic: diagnostics,
		});
		const selectedSkills = [
			selectedSkill("mixed", {
				tools: [
					{ type: "mcp", value: "docs", url: "https://docs.example.test/mcp" },
					{ type: "mcp", value: "broken" },
				],
			}),
		];

		const result = await coordinator.prepare({
			selectedSkills,
			signal: new AbortController().signal,
		});

		expect(result.outcome).toBe("not-needed");
		expect(decide).not.toHaveBeenCalled();
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "skill-mcp-dependency-invalid", dependency: "broken" }),
		);
	});

	it("fails before prompting when preparation is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const decide = vi.fn(async () => "install" as const);
		const coordinator = createSkillMcpDependencyCoordinator({
			configuredServers: () => [],
			decide,
			install: vi.fn(async () => undefined),
		});

		await expect(
			coordinator.prepare({
				selectedSkills: [
					selectedSkill("review", {
						tools: [{ type: "mcp", value: "docs", url: "https://docs.example.test/mcp" }],
					}),
				],
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(decide).not.toHaveBeenCalled();
	});
});
