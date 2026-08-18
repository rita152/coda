import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { resolveSkillSelector } from "../../src/skills/resolve.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveSkillSelector", () => {
	it("resolves a catalog winner by name or exact id", async () => {
		const base = await mkdtemp(join(tmpdir(), "coda-skill-resolve-"));
		temporary.push(base);
		const workspace = join(base, "workspace");
		const home = join(base, "home");
		const skillDirectory = join(home, ".agents", "skills", "inspect");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
		await writeFile(
			join(skillDirectory, "SKILL.md"),
			"---\nname: inspect\ndescription: Inspect the current change\n---\n\nFollow the checklist.\n",
		);
		const roots = await collectSkillRoots({ workspace, homeDirectory: home });
		const snapshot = await new CodingSkillsManager({ fileSystem: createNodeFileSystem(), roots }).refresh();
		const id = snapshot.resolved[0]!.candidate.id;
		expect(resolveSkillSelector(snapshot, "inspect")?.candidate.id).toBe(id);
		expect(resolveSkillSelector(snapshot, String(id))?.candidate.id).toBe(id);
		expect(resolveSkillSelector(snapshot, "missing")).toBeUndefined();
	});
});
