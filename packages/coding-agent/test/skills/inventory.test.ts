import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { workspaceSkillsTrustRecord } from "../../src/skills/inventory.ts";
import { CodingSkillsManager, skillExtensionEntries } from "../../src/skills/manager.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeSkill(root: string, directory: string, name: string, description: string): Promise<void> {
	const path = join(root, directory);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`);
}

async function fixture() {
	const base = await mkdtemp(join(tmpdir(), "coda-skill-inventory-"));
	temporary.push(base);
	const workspacePath = join(base, "workspace");
	const home = join(base, "home");
	await Promise.all([mkdir(workspacePath, { recursive: true }), mkdir(home, { recursive: true })]);
	const workspace = await realpath(workspacePath);
	const fileSystem = createNodeFileSystem();
	const roots = await collectSkillRoots({ workspace, homeDirectory: home });
	return { base, workspace, home, fileSystem, roots };
}

describe("CodingSkills inventory and precedence", () => {
	it("omits untrusted workspace Skills, then admits the exact trusted inventory", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "review", "review", "Review changes");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			workspace: value.workspace,
			roots: value.roots,
		});

		const untrusted = await manager.refresh();
		expect(untrusted.inventory.trust).toBe("untrusted");
		expect(untrusted.admitted).toEqual([]);
		const record = workspaceSkillsTrustRecord(untrusted);
		const trusted = await manager.refresh([record], { rescan: false });
		expect(trusted.inventory.trust).toBe("trusted");
		expect(trusted.admitted.map(({ candidate }) => candidate.metadata.name)).toEqual(["review"]);
	});

	it("invalidates trust on revision change without invalidating user Skills", async () => {
		const value = await fixture();
		const workspaceRoot = join(value.workspace, ".agents", "skills");
		const userRoot = join(value.home, ".agents", "skills");
		await writeSkill(workspaceRoot, "build", "build", "Build workspace");
		await writeSkill(userRoot, "personal", "personal", "Personal workflow");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			workspace: value.workspace,
			roots: value.roots,
		});
		const initial = await manager.refresh();
		const record = workspaceSkillsTrustRecord(initial);
		expect((await manager.refresh([record])).inventory.trust).toBe("trusted");

		await writeSkill(workspaceRoot, "build", "build", "Changed workspace build");
		const changed = await manager.refresh([record]);
		expect(changed.inventory.trust).toBe("untrusted");
		expect(changed.inventory.diff.changed).toHaveLength(1);
		expect(changed.admitted.map(({ candidate }) => candidate.metadata.name)).toEqual(["personal"]);
	});

	it("keeps collision losers addressable while the project Skill owns the short alias", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "shared", "shared", "Workspace winner");
		await writeSkill(join(value.home, ".agents", "skills"), "shared", "shared", "User alternative");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			workspace: value.workspace,
			roots: value.roots,
		});
		const initial = await manager.refresh();
		const snapshot = await manager.refresh([workspaceSkillsTrustRecord(initial)], { rescan: false });
		const shared = snapshot.admitted.filter(({ candidate }) => candidate.metadata.name === "shared");

		expect(shared).toHaveLength(2);
		expect(shared[0]).toMatchObject({ winner: true, sourceLabel: "./.agents/skills" });
		expect(shared[1]!.winner).toBe(false);
		expect(shared[1]!.qualifiedName).toMatch(/^shared@user-[a-f0-9]{8}$/u);
		expect(snapshot.diagnostics.some(({ code }) => code === "skill-name-collision")).toBe(true);
		expect(skillExtensionEntries(snapshot).map(({ name }) => name)).toEqual(["shared", shared[1]!.qualifiedName]);
		expect("set" in snapshot.byId).toBe(false);
	});

	it("never treats an empty partial Workspace inventory as trust-free", async () => {
		const value = await fixture();
		const root = join(value.workspace, ".agents", "skills");
		await writeSkill(root, "one", "one", "First");
		await writeSkill(root, "two", "two", "Second");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			workspace: value.workspace,
			roots: value.roots,
			limits: { maxEntries: 1 },
		});

		const snapshot = await manager.refresh();

		expect(snapshot.inventory.items).toEqual([]);
		expect(snapshot.inventory.complete).toBe(false);
		expect(snapshot.inventory.trust).toBe("incomplete");
		expect(() => workspaceSkillsTrustRecord(snapshot)).toThrow("incomplete");
	});

	it("keeps an earlier Run snapshot immutable when the next refresh observes a watcher change", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "watched", "watched", "First revision");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			workspace: value.workspace,
			roots: value.roots,
		});
		const first = await manager.refresh();
		const firstRevision = first.admitted[0]!.candidate.revision;

		await writeSkill(root, "watched", "watched", "Second revision");
		manager.markDirty();
		const second = await manager.refresh([], { rescan: false });

		expect(second.admitted[0]!.candidate.revision).not.toBe(firstRevision);
		expect(first.admitted[0]!.candidate.revision).toBe(firstRevision);
		await expect(first.activate(first.admitted[0]!.candidate.id)).rejects.toThrow("changed after this snapshot");
		await expect(second.activate(second.admitted[0]!.candidate.id)).resolves.toMatchObject({
			body: expect.stringContaining("Use watched"),
		});
	});
});
