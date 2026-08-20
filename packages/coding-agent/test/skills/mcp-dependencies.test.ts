import type { SkillId, SkillRevision } from "@coda/skills";
import { describe, expect, it } from "vitest";
import { planExplicitSkillMcpDependencies } from "../../src/skills/mcp-dependencies.ts";
import type { CodingSkillToolDependency, ResolvedCodingSkill } from "../../src/skills/types.ts";

function selectedSkill(name: string, dependencies: readonly CodingSkillToolDependency[]): ResolvedCodingSkill {
	const id = `skill:${name}` as SkillId;
	return {
		candidate: {
			id,
			revision: `revision:${name}` as SkillRevision,
			directory: `/skills/${name}`,
			skillFile: `/skills/${name}/SKILL.md`,
			metadata: { name, description: `${name} description`, metadata: {} },
			conformant: true,
			provenance: [],
			diagnostics: [],
		},
		origin: { scope: "user", root: "/skills", priority: 0 },
		precedence: 0,
		winner: true,
		collisionCount: 1,
		sourceLabel: "User Skill",
		qualifiedName: name,
		implicitInvocation: true,
		dependencies: { tools: dependencies },
	};
}

describe("explicit Skill MCP dependency planning", () => {
	it("plans case-insensitive MCP dependencies as Streamable HTTP by default", () => {
		const skill = selectedSkill("docs-search", [
			{
				type: "MCP",
				value: "openai-docs",
				url: "https://developers.openai.com/mcp",
			},
			{ type: "shell", value: "local-helper", command: "helper" },
		]);

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [skill], configuredServers: [] });

		expect(plan).toEqual({
			missing: [
				{
					canonicalKey: "mcp__streamable_http__https://developers.openai.com/mcp",
					configuration: {
						id: "openai-docs",
						transport: { kind: "http", url: "https://developers.openai.com/mcp" },
					},
					requestedBy: [{ skillId: skill.candidate.id, skillName: "docs-search", qualifiedName: "docs-search" }],
				},
			],
			canonicalKeys: ["mcp__streamable_http__https://developers.openai.com/mcp"],
			diagnostics: [],
		});
	});

	it("recognizes canonically equivalent HTTP and stdio servers installed under other names", () => {
		const skill = selectedSkill("release", [
			{
				type: "mcp",
				value: "docs alias that does not need installation",
				transport: "STREAMABLE_HTTP",
				url: "https://developers.openai.com/mcp",
			},
			{ type: "McP", value: "git-alias", transport: "StDiO", command: "git-mcp" },
		]);

		const plan = planExplicitSkillMcpDependencies({
			selectedSkills: [skill],
			configuredServers: [
				{
					id: "official-docs",
					transport: { kind: "http", url: "https://developers.openai.com/mcp" },
				},
				{ id: "git-tools", transport: { kind: "stdio", command: "git-mcp", args: ["serve"] } },
			],
		});

		expect(plan).toEqual({ missing: [], canonicalKeys: [], diagnostics: [] });
	});

	it("resolves a Plugin Skill relative stdio dependency against its Plugin root", () => {
		const pluginRoot = "/plugins/review-tools";
		const skill = {
			...selectedSkill("release", [
				{ type: "mcp", value: "local-review", transport: "stdio", command: "./bin/server" },
			]),
			origin: {
				scope: "user" as const,
				root: pluginRoot,
				priority: 0,
				kind: "plugin" as const,
				pluginName: "review-tools",
				pluginRoot,
			},
			qualifiedName: "review-tools:release",
		};

		const plan = planExplicitSkillMcpDependencies({
			selectedSkills: [skill],
			configuredServers: [
				{
					id: "plugin_review-tools_local-review",
					transport: { kind: "stdio", command: "/plugins/review-tools/bin/server" },
				},
			],
		});

		expect(plan).toEqual({ missing: [], canonicalKeys: [], diagnostics: [] });
	});

	it("does not equate the same relative stdio command from different Plugin roots", () => {
		const pluginRoot = "/plugins/release-tools";
		const skill = {
			...selectedSkill("release", [
				{ type: "mcp", value: "local-release", transport: "stdio", command: "./bin/server" },
			]),
			origin: {
				scope: "user" as const,
				root: pluginRoot,
				priority: 0,
				kind: "plugin" as const,
				pluginName: "release-tools",
				pluginRoot,
			},
			qualifiedName: "release-tools:release",
		};

		const plan = planExplicitSkillMcpDependencies({
			selectedSkills: [skill],
			configuredServers: [
				{
					id: "plugin_review-tools_local-review",
					transport: { kind: "stdio", command: "/plugins/review-tools/bin/server" },
				},
			],
		});

		expect(plan).toEqual({
			missing: [
				{
					canonicalKey: "mcp__stdio__/plugins/release-tools/bin/server",
					configuration: {
						id: "local-release",
						transport: { kind: "stdio", command: "/plugins/release-tools/bin/server" },
					},
					requestedBy: [
						{
							skillId: skill.candidate.id,
							skillName: "release",
							qualifiedName: "release-tools:release",
							plugin: {
								name: "release-tools",
								source: "User Skill",
								scope: "user",
							},
						},
					],
				},
			],
			canonicalKeys: ["mcp__stdio__/plugins/release-tools/bin/server"],
			diagnostics: [],
		});
	});

	it("rejects a Plugin Skill stdio command that canonicalizes outside the Plugin root", () => {
		const pluginRoot = "/plugins/review-tools";
		const skill = {
			...selectedSkill("release", [
				{ type: "mcp", value: "escaped", transport: "stdio", command: "../outside/server" },
			]),
			origin: {
				scope: "workspace" as const,
				root: pluginRoot,
				priority: 0,
				kind: "plugin" as const,
				pluginName: "review-tools",
				pluginRoot,
			},
			qualifiedName: "review-tools:release",
		};

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [skill], configuredServers: [] });

		expect(plan.missing).toEqual([]);
		expect(plan.canonicalKeys).toEqual([]);
		expect(plan.diagnostics).toEqual([
			expect.objectContaining({
				code: "skill-mcp-dependency-invalid",
				dependency: "escaped",
				message: expect.stringContaining("resolves outside its Agent Plugin root"),
			}),
		]);
	});

	it("rejects a Plugin Skill relative stdio command when no absolute Plugin root is available", () => {
		const skill = {
			...selectedSkill("release", [
				{ type: "mcp", value: "uncontained", transport: "stdio", command: "./bin/server" },
			]),
			origin: {
				scope: "workspace" as const,
				root: "/plugins/review-tools",
				priority: 0,
				kind: "plugin" as const,
				pluginName: "review-tools",
			},
			qualifiedName: "review-tools:release",
		};

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [skill], configuredServers: [] });

		expect(plan.missing).toEqual([]);
		expect(plan.diagnostics).toEqual([
			expect.objectContaining({
				code: "skill-mcp-dependency-invalid",
				dependency: "uncontained",
				message: expect.stringContaining("absolute Agent Plugin root"),
			}),
		]);
	});

	it("retains typed OAuth callback metadata and reports authentication as client-managed", () => {
		const skill = selectedSkill("oauth-docs", [
			{
				type: "mcp",
				value: "oauth-docs",
				url: "https://oauth.example.test/mcp",
				oauth: { callbackPort: 3118 },
			},
		]);

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [skill], configuredServers: [] });

		expect(plan.missing).toEqual([
			expect.objectContaining({
				configuration: {
					id: "oauth-docs",
					transport: { kind: "http", url: "https://oauth.example.test/mcp" },
					oauth: { callbackPort: 3118 },
				},
			}),
		]);
		expect(plan.diagnostics).toEqual([
			expect.objectContaining({
				code: "skill-mcp-dependency-oauth-client-managed",
				canonicalKey: "mcp__streamable_http__https://oauth.example.test/mcp",
				message: expect.stringContaining("authentication remains client-managed"),
			}),
		]);
	});

	it("diagnoses conflicting OAuth metadata instead of silently dropping it during canonical deduplication", () => {
		const alpha = selectedSkill("alpha", [
			{
				type: "mcp",
				value: "alpha-docs",
				url: "https://oauth.example.test/mcp",
				oauth: { callbackPort: 3118 },
			},
		]);
		const beta = selectedSkill("beta", [
			{
				type: "mcp",
				value: "beta-docs",
				url: "https://oauth.example.test/mcp",
				oauth: { callbackPort: 4118 },
			},
		]);

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [beta, alpha], configuredServers: [] });

		expect(plan.missing).toHaveLength(1);
		expect(plan.missing[0]?.configuration).toMatchObject({
			id: "alpha-docs",
			oauth: { callbackPort: 3118 },
		});
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "skill-mcp-dependency-name-conflict",
				skillName: "beta",
				message: expect.stringContaining("conflicting OAuth metadata"),
			}),
		);
	});

	it("isolates malformed MCP dependency records without hiding later valid records", () => {
		const skill = selectedSkill("mixed-dependencies", [
			{ type: "mcp-helper", value: "not-an-mcp", url: "https://ignored.example.test/mcp" },
			{ type: "mcp", value: "missing-url" },
			{ type: "MCP", value: "missing-command", transport: "stdio" },
			{ type: "mcp", value: "old-sse", transport: "sse", url: "https://example.test/sse" },
			{ type: "mcp", value: "not-a-url", url: "relative/path" },
			{ type: "mcp", value: "invalid name", url: "https://example.test/invalid-name" },
			{ type: "mcp", value: "local-tools", transport: "STDIO", command: "node" },
		]);

		const plan = planExplicitSkillMcpDependencies({ selectedSkills: [skill], configuredServers: [] });

		expect(plan.missing).toEqual([
			expect.objectContaining({
				canonicalKey: "mcp__stdio__node",
				configuration: { id: "local-tools", transport: { kind: "stdio", command: "node" } },
			}),
		]);
		expect(plan.canonicalKeys).toEqual(["mcp__stdio__node"]);
		expect(plan.diagnostics.map(({ code, dependency, message }) => ({ code, dependency, message }))).toEqual([
			{
				code: "skill-mcp-dependency-invalid",
				dependency: "missing-url",
				message: 'Skill "mixed-dependencies" MCP dependency "missing-url" is missing a Streamable HTTP URL',
			},
			{
				code: "skill-mcp-dependency-invalid",
				dependency: "missing-command",
				message: 'Skill "mixed-dependencies" MCP dependency "missing-command" is missing a stdio command',
			},
			{
				code: "skill-mcp-dependency-invalid",
				dependency: "old-sse",
				message: 'Skill "mixed-dependencies" MCP dependency "old-sse" uses unsupported transport "sse"',
			},
			{
				code: "skill-mcp-dependency-invalid",
				dependency: "not-a-url",
				message:
					'Skill "mixed-dependencies" MCP dependency "not-a-url" URL must be an http(s) URL without credentials or a fragment',
			},
			{
				code: "skill-mcp-dependency-invalid",
				dependency: "invalid name",
				message: 'Skill "mixed-dependencies" MCP dependency name "invalid name" is not a valid MCP Server id',
			},
		]);
	});

	it.each([
		" https://docs.example.test/mcp",
		"https:docs.example.test/mcp",
		"https:\\docs.example.test\\mcp",
		"https://@docs.example.test/mcp",
		"https://docs.example.test/mcp#",
	])("rejects non-canonical or credential/fragment dependency URLs: %s", (url) => {
		const plan = planExplicitSkillMcpDependencies({
			selectedSkills: [selectedSkill("review", [{ type: "mcp", value: "docs", transport: "streamable_http", url }])],
			configuredServers: [],
		});

		expect(plan.missing).toEqual([]);
		expect(plan.diagnostics).toMatchObject([{ code: "skill-mcp-dependency-invalid", dependency: "docs" }]);
	});

	it("never plans over an already configured server with the dependency name", () => {
		const skill = selectedSkill("new-docs", [{ type: "mcp", value: "docs", url: "https://new.example.test/mcp" }]);

		const plan = planExplicitSkillMcpDependencies({
			selectedSkills: [skill],
			configuredServers: [{ id: "docs", transport: { kind: "http", url: "https://existing.example.test/mcp" } }],
		});

		expect(plan.missing).toEqual([]);
		expect(plan.canonicalKeys).toEqual([]);
		expect(plan.diagnostics).toEqual([
			{
				code: "skill-mcp-dependency-name-conflict",
				severity: "warning",
				message:
					'Skill "new-docs" MCP dependency "docs" was not planned because that MCP Server id is already configured differently',
				skillId: skill.candidate.id,
				skillName: "new-docs",
				dependency: "docs",
				canonicalKey: "mcp__streamable_http__https://new.example.test/mcp",
			},
		]);
	});

	it("deduplicates canonical dependencies with deterministic names, requesters, and output order", () => {
		const alpha = selectedSkill("alpha", [
			{ type: "mcp", value: "alpha-docs", url: "https://docs.example.test/mcp" },
		]);
		const zeta = selectedSkill("zeta", [
			{ type: "mcp", value: "zeta-docs", url: "https://docs.example.test/mcp" },
			{ type: "mcp", value: "git-tools", transport: "stdio", command: "git-mcp" },
		]);

		const forward = planExplicitSkillMcpDependencies({
			selectedSkills: [zeta, alpha],
			configuredServers: [],
		});
		const reversed = planExplicitSkillMcpDependencies({
			selectedSkills: [alpha, zeta],
			configuredServers: [],
		});

		expect(forward).toEqual(reversed);
		expect(forward.canonicalKeys).toEqual([
			"mcp__stdio__git-mcp",
			"mcp__streamable_http__https://docs.example.test/mcp",
		]);
		expect(forward.missing).toEqual([
			expect.objectContaining({
				canonicalKey: "mcp__stdio__git-mcp",
				configuration: { id: "git-tools", transport: { kind: "stdio", command: "git-mcp" } },
			}),
			{
				canonicalKey: "mcp__streamable_http__https://docs.example.test/mcp",
				configuration: {
					id: "alpha-docs",
					transport: { kind: "http", url: "https://docs.example.test/mcp" },
				},
				requestedBy: [
					{ skillId: alpha.candidate.id, skillName: "alpha", qualifiedName: "alpha" },
					{ skillId: zeta.candidate.id, skillName: "zeta", qualifiedName: "zeta" },
				],
			},
		]);
	});

	it("isolates conflicting selected dependencies that request the same server id", () => {
		const alpha = selectedSkill("alpha", [{ type: "mcp", value: "shared-tools", url: "https://z.example.test/mcp" }]);
		const zeta = selectedSkill("zeta", [{ type: "mcp", value: "shared-tools", url: "https://a.example.test/mcp" }]);

		const forward = planExplicitSkillMcpDependencies({
			selectedSkills: [alpha, zeta],
			configuredServers: [],
		});
		const reversed = planExplicitSkillMcpDependencies({
			selectedSkills: [zeta, alpha],
			configuredServers: [],
		});

		expect(forward).toEqual(reversed);
		expect(forward.missing).toEqual([
			expect.objectContaining({
				canonicalKey: "mcp__streamable_http__https://a.example.test/mcp",
				configuration: {
					id: "shared-tools",
					transport: { kind: "http", url: "https://a.example.test/mcp" },
				},
			}),
		]);
		expect(forward.diagnostics).toEqual([
			expect.objectContaining({
				code: "skill-mcp-dependency-name-conflict",
				skillId: alpha.candidate.id,
				dependency: "shared-tools",
				canonicalKey: "mcp__streamable_http__https://z.example.test/mcp",
			}),
		]);
	});
});
