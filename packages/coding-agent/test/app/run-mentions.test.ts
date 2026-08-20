import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpToolDescriptor } from "@coda/mcp";
import { createSkills, type SkillsSnapshot } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunMentions } from "../../src/app/run-mentions.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";
import type { CodingSkillOrigin } from "../../src/skills/types.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const mcpTools: readonly McpToolDescriptor[] = Object.freeze([
	{
		id: "mcp:docs:search",
		serverId: "docs",
		serverSemanticName: "docs",
		remoteName: "search",
		name: "mcp__docs__search",
		description: "Search docs",
		inputSchema: { type: "object", properties: {} },
	},
	{
		id: "mcp:docs:lookup",
		serverId: "docs",
		serverSemanticName: "docs",
		remoteName: "lookup",
		name: "mcp__docs__lookup",
		description: "Look up a page",
		inputSchema: { type: "object", properties: {} },
	},
]);

const pluginMcpTools: readonly McpToolDescriptor[] = Object.freeze([
	{
		id: `mcp:p_${"a".repeat(62)}:search`,
		serverId: `p_${"a".repeat(62)}`,
		serverSemanticName: "portable-tools:Docs",
		remoteName: "search",
		name: `mcp__p_${"a".repeat(62)}__search`,
		description: "Search portable docs",
		inputSchema: { type: "object", properties: {} },
	},
]);

async function snapshotWithSkill(name: string) {
	const base = await mkdtemp(join(tmpdir(), "coda-run-mentions-"));
	temporary.push(base);
	const workspace = join(base, "workspace");
	const home = join(base, "home");
	const skillDirectory = join(home, ".agents", "skills", name);
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
	await writeFile(join(workspace, ".git"), "gitdir: fake\n");
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} workflow\n---\n\nFollow ${name}.\n`,
	);
	const fileSystem = createNodeFileSystem();
	const roots = await collectSkillRoots({ workspace, homeDirectory: home, fileSystem });
	const manager = new CodingSkillsManager({ fileSystem, roots });
	return manager.refresh();
}

async function snapshotWithPluginSkills(pluginNames: readonly string[]) {
	const base = await mkdtemp(join(tmpdir(), "coda-run-plugin-mentions-"));
	temporary.push(base);
	const workspace = join(base, "workspace");
	const home = join(base, "home");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true })]);
	await writeFile(join(workspace, ".git"), "gitdir: fake\n");
	const fileSystem = createNodeFileSystem();
	const supplemental: SkillsSnapshot<CodingSkillOrigin>[] = [];
	for (const pluginName of pluginNames) {
		const pluginRoot = join(workspace, ".agents", "plugins", pluginName);
		const skillRoot = join(pluginRoot, "skills", "review");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			`---\nname: review\ndescription: ${pluginName} review workflow\n---\n\nFollow ${pluginName}.\n`,
		);
		supplemental.push(
			await createSkills<CodingSkillOrigin>({ fileSystem }).snapshot({
				roots: [
					{
						path: skillRoot,
						origin: {
							scope: "workspace",
							root: pluginRoot,
							pluginRoot,
							priority: 1,
							sourceLabel: `${pluginName}@workspace-local`,
							kind: "plugin",
							pluginName,
						},
					},
				],
				profile: "strict",
			}),
		);
	}
	const roots = await collectSkillRoots({ workspace, homeDirectory: home, fileSystem });
	return new CodingSkillsManager({
		fileSystem,
		roots,
		supplementalSnapshots: () => supplemental,
	}).refresh();
}

describe("resolveRunMentions", () => {
	it("injects a unique Skill winner from `$name` and keeps MCP Tools unselected", async () => {
		const skills = await snapshotWithSkill("inspect");
		expect(
			resolveRunMentions({ composerText: "$inspect do the work", skills, mcpTools }).skillReferences.map(
				({ name, commandId }) => ({ name, commandId }),
			),
		).toEqual([{ name: "inspect", commandId: String(skills.resolved[0]!.candidate.id) }]);
		expect(resolveRunMentions({ composerText: "$inspect do the work", skills, mcpTools }).mcpToolIds).toEqual([]);
	});

	it("admits one MCP Tool, a Server's Tools, or a namespaced alias from `$` text", async () => {
		const skills = await snapshotWithSkill("inspect");
		expect(resolveRunMentions({ composerText: "Use $search", skills, mcpTools }).mcpToolIds).toEqual([
			"mcp:docs:search",
		]);
		expect(resolveRunMentions({ composerText: "Use $docs:search", skills, mcpTools }).mcpToolIds).toEqual([
			"mcp:docs:search",
		]);
		expect(resolveRunMentions({ composerText: "Use $mcp__docs__search", skills, mcpTools }).mcpToolIds).toEqual([
			"mcp:docs:search",
		]);
		expect([...resolveRunMentions({ composerText: "Use $docs", skills, mcpTools }).mcpToolIds].sort()).toEqual([
			"mcp:docs:lookup",
			"mcp:docs:search",
		]);
	});

	it("resolves a Plugin Server's semantic Composer mention to its internal Tool identity", async () => {
		const skills = await snapshotWithSkill("inspect");
		const internalToolId = pluginMcpTools[0]!.id;

		expect(
			resolveRunMentions({ composerText: "Use $portable-tools:Docs", skills, mcpTools: pluginMcpTools }).mcpToolIds,
		).toEqual([internalToolId]);
		expect(
			resolveRunMentions({
				composerText: "Use $portable-tools:Docs-search",
				skills,
				mcpTools: pluginMcpTools,
			}).mcpToolIds,
		).toEqual([internalToolId]);
	});

	it("requires canonical Plugin Skill mentions even when the bare Skill name is unique", async () => {
		const skills = await snapshotWithPluginSkills(["alpha-tools", "beta-tools"]);
		const byName = new Map(skills.resolved.map((entry) => [entry.qualifiedName, String(entry.candidate.id)]));

		expect(resolveRunMentions({ composerText: "$review the change", skills }).skillReferences).toEqual([]);
		expect(
			resolveRunMentions({ composerText: "$alpha-tools:review the change", skills }).skillReferences.map(
				({ name, commandId }) => ({ name, commandId }),
			),
		).toEqual([{ name: "alpha-tools:review", commandId: byName.get("alpha-tools:review") }]);
		expect(
			resolveRunMentions({ composerText: "$beta-tools:review the change", skills }).skillReferences.map(
				({ name, commandId }) => ({ name, commandId }),
			),
		).toEqual([{ name: "beta-tools:review", commandId: byName.get("beta-tools:review") }]);
	});

	it("keeps case-sensitive Plugin Server siblings distinct in exact semantic mentions", async () => {
		const skills = await snapshotWithSkill("inspect");
		const upperId = `p_${"a".repeat(62)}`;
		const lowerId = "plugin_portable-tools_docs";
		const siblingTools: readonly McpToolDescriptor[] = [
			{
				id: `mcp:${upperId}:search`,
				serverId: upperId,
				serverSemanticName: "portable-tools:Docs",
				remoteName: "search",
				name: `mcp__${upperId}__search`,
				description: "Search upper docs",
				inputSchema: { type: "object", properties: {} },
			},
			{
				id: `mcp:${lowerId}:lookup`,
				serverId: lowerId,
				serverSemanticName: "portable-tools:docs",
				remoteName: "lookup",
				name: `mcp__${lowerId}__lookup`,
				description: "Search lower docs",
				inputSchema: { type: "object", properties: {} },
			},
		];

		expect(
			resolveRunMentions({ composerText: "Use $portable-tools:Docs", skills, mcpTools: siblingTools }).mcpToolIds,
		).toEqual([`mcp:${upperId}:search`]);
		expect(
			resolveRunMentions({ composerText: "Use $portable-tools:docs", skills, mcpTools: siblingTools }).mcpToolIds,
		).toEqual([`mcp:${lowerId}:lookup`]);
		expect(
			resolveRunMentions({ composerText: "Use $PORTABLE-TOOLS:DOCS", skills, mcpTools: siblingTools }).mcpToolIds,
		).toEqual([]);
	});

	it("lets a Skill winner keep a colliding short name", async () => {
		const skills = await snapshotWithSkill("search");
		const resolved = resolveRunMentions({ composerText: "$search now", skills, mcpTools });
		expect(resolved.skillReferences.map(({ name }) => name)).toEqual(["search"]);
		expect(resolved.mcpToolIds).toEqual([]);
		expect(resolveRunMentions({ composerText: "$docs-search now", skills, mcpTools }).mcpToolIds).toEqual([
			"mcp:docs:search",
		]);
	});

	it("resolves Unicode and environment-like Skill names against the installed catalog", async () => {
		const unicode = await snapshotWithSkill("数据-分析");
		expect(
			resolveRunMentions({ composerText: "请用 $数据-分析。", skills: unicode, mcpTools }).skillReferences.map(
				({ name }) => name,
			),
		).toEqual(["数据-分析"]);

		const environmentLike = await snapshotWithSkill("home");
		expect(
			resolveRunMentions({ composerText: "Use $HOME", skills: environmentLike, mcpTools }).skillReferences.map(
				({ name }) => name,
			),
		).toEqual(["HOME"]);
	});

	it("activates each Skill mention at most once while preserving first-mention order", async () => {
		const skills = await snapshotWithSkill("inspect");
		const resolved = resolveRunMentions({
			composerText: "$inspect then $INSPECT then $inspect",
			skills,
			mcpTools,
		});

		expect(resolved.skillReferences.map(({ name }) => name)).toEqual(["inspect"]);
	});
});
