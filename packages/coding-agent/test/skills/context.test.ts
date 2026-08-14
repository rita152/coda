import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "../../src/skills/context.ts";
import { CodingSkillsManager, skillExtensionEntries } from "../../src/skills/manager.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeSkill(root: string, name: string, body: string, extra = ""): Promise<string> {
	const directory = join(root, name);
	await mkdir(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	await writeFile(path, `---\nname: ${name}\ndescription: ${name} workflow\n${extra}---\n\n${body}\n`);
	return path;
}

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), "coda-skill-context-"));
	temporary.push(base);
	const workspace = join(base, "workspace");
	const home = join(base, "home");
	await Promise.all([mkdir(workspace), mkdir(home)]);
	const fileSystem = createNodeFileSystem();
	const roots = await collectSkillRoots({ workspace, homeDirectory: home });
	const manager = new CodingSkillsManager({ fileSystem, roots });
	return { workspace, home, fileSystem, manager };
}

describe("Skill activation context", () => {
	it("gives every explicit Skill the same Composer arguments with all structured tokens removed", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "one", "First body");
		await writeSkill(root, "two", "Second body");
		const snapshot = await value.manager.refresh();
		const one = snapshot.resolved.find(({ candidate }) => candidate.metadata.name === "one")!;
		const two = snapshot.resolved.find(({ candidate }) => candidate.metadata.name === "two")!;
		const composerText = "/one /two do the work";
		const references = [
			{
				id: "ref:one",
				commandId: String(one.candidate.id),
				source: "skill" as const,
				name: "one",
				start: 0,
				end: 4,
			},
			{
				id: "ref:two",
				commandId: String(two.candidate.id),
				source: "skill" as const,
				name: "two",
				start: 5,
				end: 9,
			},
		];

		expect(sharedSkillArguments(composerText, references)).toBe("do the work");
		const activations = await activateExplicitSkillReferences({ snapshot, references, composerText });
		expect(activations.map(({ activation }) => activation.arguments)).toEqual(["do the work", "do the work"]);
		const context = renderExplicitSkillContext(activations);
		const input = prependSkillContext("do the work", context, renderExplicitSkillReferences(activations));
		expect(input).toEqual([
			{ type: "skill", name: "one", path: one.candidate.skillFile },
			{ type: "skill", name: "two", path: two.candidate.skillFile },
			{ type: "text", text: context },
			{ type: "text", text: "do the work" },
		]);
		expect(context).toContain("First body");
		expect(context).toContain("Second body");
		expect(context).not.toContain("description: one workflow");
		expect(context).toContain(String(one.candidate.revision));
	});

	it("accepts the Codex-style $ Skill mention token for a structured reference", () => {
		expect(
			sharedSkillArguments("$review finish the work", [
				{
					id: "ref:review",
					commandId: `skill:${"1".repeat(32)}`,
					source: "skill",
					name: "review",
					start: 0,
					end: "$review".length,
				},
			]),
		).toBe("finish the work");
	});

	it("exposes every discovered standard Skill and returns exact activation provenance", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "visible", "Visible body");
		const snapshot = await value.manager.refresh();

		expect(snapshot.resolved).toHaveLength(1);
		const id = snapshot.resolved[0]!.candidate.id;
		const activation = await snapshot.activate(id, { arguments: "focus" });
		expect(activation.body).toContain("Visible body");
		expect(activation.arguments).toBe("focus");
		expect(String(activation.revision)).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("fails stale activation instead of reading changed instructions", async () => {
		const value = await fixture();
		const path = await writeSkill(join(value.home, ".agents", "skills"), "stale", "Original body");
		const snapshot = await value.manager.refresh();
		const skill = snapshot.resolved[0]!;
		await writeFile(path, "---\nname: stale\ndescription: changed\n---\n\nChanged body\n");

		await expect(snapshot.activate(skill.candidate.id)).rejects.toThrow("changed after this snapshot");
	});

	it("does not give non-standard invocation fields product semantics", async () => {
		const value = await fixture();
		await writeSkill(
			join(value.home, ".agents", "skills"),
			"portable",
			"Portable body",
			"user-invocable: false\ndisable-model-invocation: true\n",
		);
		const snapshot = await value.manager.refresh();

		expect(snapshot.resolved.map(({ candidate }) => candidate.id)).toEqual([snapshot.resolved[0]!.candidate.id]);
		expect(skillExtensionEntries(snapshot).map(({ name }) => name)).toEqual(["portable"]);
		expect(snapshot.diagnostics.filter(({ code }) => code === "unknown-field")).toHaveLength(2);
	});

	it("rejects overlapping or text-mismatched structured reference ranges", () => {
		expect(() =>
			sharedSkillArguments("/one /two", [
				{ id: "one", commandId: `skill:${"1".repeat(32)}`, source: "skill", name: "one", start: 0, end: 4 },
				{ id: "two", commandId: `skill:${"2".repeat(32)}`, source: "skill", name: "two", start: 3, end: 9 },
			]),
		).toThrow("ordered Composer token");
		expect(() =>
			sharedSkillArguments("/one", [
				{ id: "one", commandId: `skill:${"1".repeat(32)}`, source: "skill", name: "other", start: 0, end: 4 },
			]),
		).toThrow("ordered Composer token");
	});

	it("uses the same project-first winner for the model catalog and explicit activation", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "shared", "Project body");
		await writeSkill(join(value.home, ".agents", "skills"), "shared", "User body");
		const snapshot = await value.manager.refresh();

		const catalog = snapshot.resolved.filter(({ candidate }) => candidate.metadata.name === "shared");
		expect(catalog).toHaveLength(2);
		expect(catalog[0]).toMatchObject({ winner: true, sourceLabel: "./.agents/skills" });
		expect(skillExtensionEntries(snapshot)[0]).toMatchObject({ name: "shared" });
	});
});
