import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpToolDescriptor } from "@coda/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunMentions } from "../../src/app/run-mentions.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const mcpTools: readonly McpToolDescriptor[] = Object.freeze([
	{
		id: "mcp:docs:search",
		serverId: "docs",
		remoteName: "search",
		name: "mcp__docs__search",
		description: "Search docs",
		inputSchema: { type: "object", properties: {} },
	},
	{
		id: "mcp:docs:lookup",
		serverId: "docs",
		remoteName: "lookup",
		name: "mcp__docs__lookup",
		description: "Look up a page",
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
	await writeFile(
		join(skillDirectory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} workflow\n---\n\nFollow ${name}.\n`,
	);
	const roots = await collectSkillRoots({ workspace, homeDirectory: home });
	const manager = new CodingSkillsManager({ fileSystem: createNodeFileSystem(), roots });
	return manager.refresh();
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

	it("lets a Skill winner keep a colliding short name", async () => {
		const skills = await snapshotWithSkill("search");
		const resolved = resolveRunMentions({ composerText: "$search now", skills, mcpTools });
		expect(resolved.skillReferences.map(({ name }) => name)).toEqual(["search"]);
		expect(resolved.mcpToolIds).toEqual([]);
		expect(resolveRunMentions({ composerText: "$docs-search now", skills, mcpTools }).mcpToolIds).toEqual([
			"mcp:docs:search",
		]);
	});
});
