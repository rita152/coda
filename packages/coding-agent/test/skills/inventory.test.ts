import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkills, type SkillsSnapshot } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { skillExtensionEntries } from "../../src/commands/skill-extensions.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";
import { createSkillsCapabilitySource } from "../../src/skills/run-capability.ts";
import type { CodingSkillOrigin } from "../../src/skills/types.ts";

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
	const base = await mkdtemp(join(tmpdir(), "coda-skill-discovery-"));
	temporary.push(base);
	const workspacePath = join(base, "workspace");
	const home = join(base, "home");
	await Promise.all([mkdir(workspacePath, { recursive: true }), mkdir(home, { recursive: true })]);
	const workspace = await realpath(workspacePath);
	const fileSystem = createNodeFileSystem();
	const roots = await collectSkillRoots({ workspace, homeDirectory: home });
	return { base, workspace, home, fileSystem, roots };
}

describe("CodingSkills discovery and precedence", () => {
	it("merges a plugin Skill snapshot into the same inventory and routes activation through its loader", async () => {
		const value = await fixture();
		const skillRoot = join(value.workspace, ".agents", "plugins", "review-tools", "skills", "review");
		await writeSkill(
			join(value.workspace, ".agents", "plugins", "review-tools", "skills"),
			"review",
			"review",
			"Review from a plugin",
		);
		const pluginOrigin: CodingSkillOrigin = Object.freeze({
			scope: "workspace",
			root: skillRoot,
			priority: 1,
			sourceLabel: "./.agents/plugins/review-tools/skills/review",
			kind: "plugin",
			pluginName: "review-tools",
		});
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: [
				{
					path: skillRoot,
					origin: pluginOrigin,
					symlinks: {
						mode: "follow",
						containmentRoot: join(value.workspace, ".agents", "plugins", "review-tools"),
					},
				},
			],
			profile: "strict",
		});
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			supplementalSnapshots: () => [pluginSnapshot],
		});

		const snapshot = await manager.refresh();

		expect(snapshot.resolved).toHaveLength(1);
		expect(snapshot.resolved[0]).toMatchObject({
			sourceLabel: "./.agents/plugins/review-tools/skills/review",
			origin: { kind: "plugin", pluginName: "review-tools" },
		});
		await expect(snapshot.activate(snapshot.resolved[0]!.candidate.id)).resolves.toMatchObject({
			body: expect.stringContaining("Use review"),
		});
	});

	it("does not follow a Plugin Skill sidecar outside the canonical Plugin root", async () => {
		const value = await fixture();
		const pluginRoot = join(value.workspace, ".agents", "plugins", "review-tools");
		const skillRoot = join(pluginRoot, "skills", "review");
		await writeSkill(join(pluginRoot, "skills"), "review", "review", "Review from a plugin");
		await mkdir(join(skillRoot, "agents"), { recursive: true });
		const outside = join(value.base, "outside-openai.yaml");
		await writeFile(outside, "policy:\n  allow_implicit_invocation: false\n");
		await symlink(outside, join(skillRoot, "agents", "openai.yaml"));
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: [
				{
					path: skillRoot,
					origin: {
						scope: "workspace",
						root: pluginRoot,
						pluginRoot: await realpath(pluginRoot),
						priority: 1,
						sourceLabel: "./.agents/plugins/review-tools/skills/review",
						kind: "plugin",
						pluginName: "review-tools",
					},
					symlinks: { mode: "follow", containmentRoot: pluginRoot },
				},
			],
			profile: "strict",
		});
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			supplementalSnapshots: () => [pluginSnapshot],
		});

		const snapshot = await manager.refresh();

		expect(snapshot.resolved[0]?.implicitInvocation).toBe(true);
	});

	it("orders direct and plugin collisions by workspace scope before user scope", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "shared", "shared", "Direct workspace");
		await writeSkill(join(value.home, ".agents", "skills"), "shared", "shared", "Direct user");
		const loadPlugin = async (scope: "workspace" | "user", slot: string, description: string, priority: number) => {
			const parent = scope === "workspace" ? value.workspace : value.home;
			const pluginRoot = join(parent, ".agents", "plugins", slot);
			const skillRoot = join(pluginRoot, "skills", "shared");
			await writeSkill(join(pluginRoot, "skills"), "shared", "shared", description);
			return createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
				roots: [
					{
						path: skillRoot,
						origin: {
							scope,
							root: skillRoot,
							priority,
							sourceLabel: `${scope}:${slot}`,
							kind: "plugin",
							pluginName: slot,
						},
						symlinks: { mode: "follow", containmentRoot: pluginRoot },
					},
				],
				profile: "strict",
			});
		};
		const workspacePlugin = await loadPlugin("workspace", "workspace-tools", "Workspace plugin", 1);
		const userPlugin = await loadPlugin("user", "user-tools", "User plugin", 3);
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			supplementalSnapshots: () => [workspacePlugin, userPlugin],
		});

		const shared = (await manager.refresh()).resolved.filter(({ candidate }) => candidate.metadata.name === "shared");

		expect(shared.map(({ precedence }) => precedence)).toEqual([0, 1, 2, 3]);
		expect(shared.map(({ candidate }) => candidate.metadata.description)).toEqual([
			"Direct workspace",
			"Workspace plugin",
			"Direct user",
			"User plugin",
		]);
	});

	it("applies one maxSkills bound across direct and Plugin snapshots", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "direct", "direct", "Direct workspace");
		const pluginSnapshots: SkillsSnapshot<CodingSkillOrigin>[] = [];
		for (const [scope, slot, priority] of [
			["workspace", "workspace-tools", 1],
			["user", "user-tools", 3],
		] as const) {
			const parent = scope === "workspace" ? value.workspace : value.home;
			const pluginRoot = join(parent, ".agents", "plugins", slot);
			const skillRoot = join(pluginRoot, "skills", slot);
			await writeSkill(join(pluginRoot, "skills"), slot, slot, `${scope} plugin`);
			pluginSnapshots.push(
				await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
					roots: [
						{
							path: skillRoot,
							origin: {
								scope,
								root: pluginRoot,
								pluginRoot: await realpath(pluginRoot),
								priority,
								sourceLabel: `${scope}:${slot}`,
								kind: "plugin",
								pluginName: slot,
							},
							symlinks: { mode: "follow", containmentRoot: pluginRoot },
						},
					],
					profile: "strict",
				}),
			);
		}
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			limits: { maxSkills: 2 },
			supplementalSnapshots: () => pluginSnapshots,
		});

		const snapshot = await manager.refresh();

		expect(snapshot.resolved.map(({ candidate }) => candidate.metadata.description)).toEqual([
			"Direct workspace",
			"workspace plugin",
		]);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({ code: "skill-limit-exceeded", severity: "error" }),
		);
		await expect(snapshot.activate(snapshot.resolved[1]!.candidate.id)).resolves.toMatchObject({
			body: expect.stringContaining("Use workspace-tools"),
		});
	});

	it("loads workspace Skills without a trust record", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "review", "review", "Review changes");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });

		const snapshot = await manager.refresh();

		expect(snapshot.resolved.map(({ candidate }) => candidate.metadata.name)).toEqual(["review"]);
		expect(snapshot.diagnostics.some(({ code }) => code.startsWith("workspace-skills-"))).toBe(false);
	});

	it("refreshes workspace revisions while keeping user Skills available", async () => {
		const value = await fixture();
		const workspaceRoot = join(value.workspace, ".agents", "skills");
		const userRoot = join(value.home, ".agents", "skills");
		await writeSkill(workspaceRoot, "build", "build", "Build workspace");
		await writeSkill(userRoot, "personal", "personal", "Personal workflow");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });

		const initial = await manager.refresh();
		expect(initial.resolved.map(({ candidate }) => candidate.metadata.name)).toEqual(["build", "personal"]);

		await writeSkill(workspaceRoot, "build", "build", "Changed workspace build");
		const changed = await manager.refresh();
		expect(changed.resolved.map(({ candidate }) => candidate.metadata.name)).toEqual(["build", "personal"]);
		expect(changed.resolved[0]!.candidate.metadata.description).toBe("Changed workspace build");
	});

	it("keeps collision losers addressable while the project Skill owns the short alias", async () => {
		const value = await fixture();
		await writeSkill(join(value.workspace, ".agents", "skills"), "shared", "shared", "Workspace winner");
		await writeSkill(join(value.home, ".agents", "skills"), "shared", "shared", "User alternative");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const snapshot = await manager.refresh();
		const shared = snapshot.resolved.filter(({ candidate }) => candidate.metadata.name === "shared");

		expect(shared).toHaveLength(2);
		expect(shared[0]).toMatchObject({ winner: true, sourceLabel: "./.agents/skills" });
		expect(shared[1]!.winner).toBe(false);
		expect(shared[1]!.qualifiedName).toMatch(/^shared@user-[a-f0-9]{8}$/u);
		expect(snapshot.diagnostics.some(({ code }) => code === "skill-name-collision")).toBe(true);
		expect(skillExtensionEntries(snapshot).map(({ name }) => name)).toEqual(["shared", shared[1]!.qualifiedName]);
		expect("set" in snapshot.byId).toBe(false);
	});

	it("hides slash-only Skills from the model catalog and keeps them in the palette", async () => {
		const value = await fixture();
		const root = join(value.workspace, ".agents", "skills");
		await writeSkill(root, "codebase-design", "codebase-design", "Shared vocabulary for designing deep modules");
		await mkdir(join(root, "improve-codebase-architecture", "agents"), { recursive: true });
		await writeFile(
			join(root, "improve-codebase-architecture", "SKILL.md"),
			[
				"---",
				"name: improve-codebase-architecture",
				"description: Scan a codebase for deepening opportunities",
				"disable-model-invocation: true",
				"---",
				"",
				"Grill architecture improvements.",
				"",
			].join("\n"),
		);
		await writeFile(
			join(root, "improve-codebase-architecture", "agents", "openai.yaml"),
			"policy:\n  allow_implicit_invocation: false\n",
		);
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const snapshot = await manager.refresh();
		const source = createSkillsCapabilitySource(manager);
		const lease = await source.acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
			signal: new AbortController().signal,
		});
		try {
			expect(snapshot.resolved.map(({ candidate }) => candidate.metadata.name).sort()).toEqual([
				"codebase-design",
				"improve-codebase-architecture",
			]);
			expect(
				skillExtensionEntries(snapshot)
					.map(({ name }) => name)
					.sort(),
			).toEqual(["codebase-design", "improve-codebase-architecture"]);
			expect(lease.promptFragments[0]?.text).toContain("- codebase-design:");
			expect(lease.promptFragments[0]?.text).not.toContain("improve-codebase-architecture");
			expect(lease.tools[0]?.tool.name).toBe("skill");
		} finally {
			await lease.dispose();
		}
	});

	it("hides Skills whose Codex sidecar disables implicit invocation", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills", "slash-only");
		await mkdir(join(root, "agents"), { recursive: true });
		await writeFile(
			join(root, "SKILL.md"),
			"---\nname: slash-only\ndescription: Only the user should start this\n---\n\nStay slash-only.\n",
		);
		await writeFile(join(root, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const source = createSkillsCapabilitySource(manager);
		const lease = await source.acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
			signal: new AbortController().signal,
		});
		try {
			expect(manager.current?.resolved[0]?.implicitInvocation).toBe(false);
			expect(lease.promptFragments).toEqual([]);
			expect(lease.tools).toEqual([]);
		} finally {
			await lease.dispose();
		}
	});

	it("catalogs trigger rules and a name-or-id skill Tool", async () => {
		const value = await fixture();
		await writeSkill(join(value.home, ".agents", "skills"), "inspect", "inspect", "Inspect the current change");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const source = createSkillsCapabilitySource(manager);
		const lease = await source.acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
			signal: new AbortController().signal,
		});
		try {
			expect(lease.promptFragments[0]?.text).toContain("<skills_instructions>");
			expect(lease.promptFragments[0]?.text).toContain("### Available skills");
			expect(lease.promptFragments[0]?.text).toContain("### How to use skills");
			expect(lease.promptFragments[0]?.text).toContain("If you skip an obvious Skill, say why");
			expect(lease.promptFragments[0]?.text).toContain("(file:");
			expect(lease.promptFragments[0]?.text).toContain("inspect");
			expect(lease.tools[0]?.tool.name).toBe("skill");
		} finally {
			await lease.dispose();
		}
	});

	it("keeps discovery diagnostics when a scan limit is reached without a trust gate", async () => {
		const value = await fixture();
		const root = join(value.workspace, ".agents", "skills");
		await writeSkill(root, "one", "one", "First");
		await writeSkill(root, "two", "two", "Second");
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			limits: { maxEntries: 1 },
		});

		const snapshot = await manager.refresh();

		expect(snapshot.diagnostics.some(({ code }) => code.includes("limit"))).toBe(true);
	});

	it("keeps an earlier Run snapshot immutable when the next refresh observes a watcher change", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "watched", "watched", "First revision");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const first = await manager.refresh();
		const firstRevision = first.resolved[0]!.candidate.revision;

		await writeSkill(root, "watched", "watched", "Second revision");
		manager.markDirty();
		const second = await manager.refresh({ rescan: false });

		expect(second.resolved[0]!.candidate.revision).not.toBe(firstRevision);
		expect(first.resolved[0]!.candidate.revision).toBe(firstRevision);
		await expect(first.activate(first.resolved[0]!.candidate.id)).rejects.toThrow("changed after this snapshot");
		await expect(second.activate(second.resolved[0]!.candidate.id)).resolves.toMatchObject({
			body: expect.stringContaining("Use watched"),
		});
	});

	it("coalesces concurrent refreshes of one dirty generation and reuses the clean snapshot", async () => {
		const value = await fixture();
		const root = join(value.workspace, ".agents", "skills");
		await writeSkill(root, "coalesced", "coalesced", "Coalesced scan");
		let skillFileReads = 0;
		const fileSystem = {
			...value.fileSystem,
			readFile: async (path: string) => {
				if (path.endsWith("/SKILL.md")) skillFileReads++;
				return value.fileSystem.readFile(path);
			},
		};
		const manager = new CodingSkillsManager({ fileSystem, roots: value.roots });
		await manager.refresh();
		const readsPerScan = skillFileReads;
		expect(readsPerScan).toBeGreaterThan(0);
		const source = createSkillsCapabilitySource(manager);
		const acquisition = {
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 128_000,
				maxTokens: 16_000,
			},
			signal: new AbortController().signal,
		};
		await (await source.acquire(acquisition)).dispose();
		await (await source.acquire(acquisition)).dispose();
		expect(skillFileReads).toBe(readsPerScan);

		manager.markDirty();
		const leases = await Promise.all([
			source.acquire(acquisition),
			source.acquire(acquisition),
			source.acquire(acquisition),
		]);

		expect(skillFileReads).toBe(readsPerScan * 2);
		expect([...new Set(leases.map(({ revision }) => revision))]).toHaveLength(1);
		await Promise.all(leases.map((lease) => lease.dispose()));
		await (await source.acquire(acquisition)).dispose();
		expect(skillFileReads).toBe(readsPerScan * 2);
	});
});
