import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@coda/agent";
import { createSkills, type SkillsSnapshot } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { skillExtensionEntries } from "../../src/commands/skill-extensions.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { resolveSkillSelector } from "../../src/skills/resolve.ts";
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
	await writeFile(join(workspacePath, ".git"), "gitdir: fake\n");
	const workspace = await realpath(workspacePath);
	const fileSystem = createNodeFileSystem();
	const roots = await collectSkillRoots({ workspace, homeDirectory: home, fileSystem });
	return { base, workspace, home, fileSystem, roots };
}

function toolContext(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run-skills" as ToolExecutionContext["runId"],
		turnId: "turn-skills" as ToolExecutionContext["turnId"],
		invocationId: "invocation-skills" as ToolExecutionContext["invocationId"],
		resultMessageId: "message-skills" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider-skills",
	};
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
			qualifiedName: "review-tools:review",
			origin: { kind: "plugin", pluginName: "review-tools" },
		});
		expect(skillExtensionEntries(snapshot).map(({ name }) => name)).toEqual(["review-tools:review"]);
		await expect(snapshot.activate(snapshot.resolved[0]!.candidate.id)).resolves.toMatchObject({
			body: expect.stringContaining("Use review"),
		});
	});

	it("names plugin Skills by plugin namespace in the model catalog and Skill Tool", async () => {
		const value = await fixture();
		const pluginRoot = join(value.workspace, ".agents", "plugins", "review-tools");
		const skillRoot = join(pluginRoot, "skills", "review");
		await writeSkill(join(pluginRoot, "skills"), "review", "review", "Review from a plugin");
		const pluginOrigin: CodingSkillOrigin = Object.freeze({
			scope: "workspace",
			root: skillRoot,
			priority: 1,
			sourceLabel: "./.agents/plugins/review-tools/skills/review",
			kind: "plugin",
			pluginName: "review-tools",
			pluginRoot,
		});
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: [{ path: skillRoot, origin: pluginOrigin }],
			profile: "strict",
		});
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			supplementalSnapshots: () => [pluginSnapshot],
		});
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			const prompt = lease.promptFragments[0]?.text ?? "";
			expect(prompt).toContain("- review-tools:review: Review from a plugin");
			expect(prompt).not.toMatch(/^- review: /mu);
			await expect(lease.tools[0]!.tool.execute({ skill: "review" }, toolContext())).rejects.toThrow(
				"Skill is not available in this Run: review",
			);
			await expect(
				lease.tools[0]!.tool.execute({ skill: "review-tools:review" }, toolContext()),
			).resolves.toMatchObject({
				content: expect.stringContaining("<name>review-tools:review</name>"),
				details: { name: "review-tools:review", truncated: false },
			});
			await expect(
				lease.tools[0]!.tool.execute({ skill: String(manager.current!.resolved[0]!.candidate.id) }, toolContext()),
			).resolves.toMatchObject({
				content: expect.stringContaining("<name>review-tools:review</name>"),
			});
		} finally {
			await lease.dispose();
		}
	});

	it("applies the same Codex interface metadata semantics to Agent Plugin Skills", async () => {
		const value = await fixture();
		const pluginRoot = join(value.workspace, ".agents", "plugins", "review-tools");
		const skillRoot = join(pluginRoot, "skills", "review");
		await writeSkill(join(pluginRoot, "skills"), "review", "review", "Canonical plugin workflow");
		await mkdir(join(skillRoot, "agents"), { recursive: true });
		await writeFile(
			join(skillRoot, "agents", "openai.yaml"),
			[
				"interface:",
				"  display_name: Plugin review helper",
				"  short_description: Review through the Agent Plugin",
				"  default_prompt: Use $review to review this change",
				"  icon_small: ../../assets/review.svg",
				"dependencies:",
				"  tools:",
				"    - type: mcp",
				"      value: review-server",
				"policy:",
				"  products: [CODEX]",
			].join("\n"),
		);
		const canonicalPluginRoot = await realpath(pluginRoot);
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: [
				{
					path: skillRoot,
					origin: {
						scope: "workspace",
						root: canonicalPluginRoot,
						pluginRoot: canonicalPluginRoot,
						priority: 1,
						sourceLabel: "review-tools@workspace",
						kind: "plugin",
						pluginName: "review-tools",
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

		expect(snapshot.resolved[0]?.interface).toEqual({
			displayName: "Plugin review helper",
			shortDescription: "Review through the Agent Plugin",
			defaultPrompt: "Use $review to review this change",
			iconSmall: join(canonicalPluginRoot, "assets", "review.svg"),
		});
		expect(snapshot.resolved[0]?.dependencies).toEqual({
			tools: [{ type: "mcp", value: "review-server" }],
		});
		expect(snapshot.resolved[0]?.policy).toEqual({ products: ["codex"] });
		expect(skillExtensionEntries(snapshot)).toMatchObject([
			{
				name: "review-tools:review",
				title: "Plugin review helper",
				description: "Review through the Agent Plugin",
				defaultPrompt: "Use $review-tools:review to review this change",
			},
		]);
		expect(resolveSkillSelector(snapshot, "review-tools:review")).toBe(snapshot.resolved[0]);
		expect(resolveSkillSelector(snapshot, "review")).toBeUndefined();
		expect(resolveSkillSelector(snapshot, "Plugin review helper")).toBeUndefined();
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
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			await expect(
				lease.tools[0]!.tool.execute({ skill: "workspace-tools:shared" }, toolContext()),
			).resolves.toMatchObject({ content: expect.stringContaining("description: Workspace plugin") });
			await expect(
				lease.tools[0]!.tool.execute({ skill: "user-tools:shared" }, toolContext()),
			).resolves.toMatchObject({ content: expect.stringContaining("description: User plugin") });
			expect((await lease.tools[0]!.tool.execute({ skill: "shared" }, toolContext())).details).toMatchObject({
				name: "shared",
				source: "./.agents/skills",
			});
		} finally {
			await lease.dispose();
		}
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
		await rm(join(root, "improve-codebase-architecture", "SKILL.md"));
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
			await expect(
				lease.tools[0]!.tool.execute({ skill: "improve-codebase-architecture" }, toolContext()),
			).rejects.toThrow("Skill is not available in this Run");
			await expect(lease.tools[0]!.tool.execute({ skill: "codebase-design" }, toolContext())).resolves.toMatchObject(
				{
					content: expect.stringContaining("Use codebase-design."),
				},
			);
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

	it("uses Codex interface metadata in the Skill palette without changing the canonical selector", async () => {
		const value = await fixture();
		const skillDirectory = join(value.home, ".agents", "skills", "review");
		await writeSkill(join(value.home, ".agents", "skills"), "review", "review", "Canonical review workflow");
		await mkdir(join(skillDirectory, "agents"), { recursive: true });
		await writeFile(
			join(skillDirectory, "agents", "openai.yaml"),
			[
				"interface:",
				"  display_name: Review helper",
				"  short_description: Review the selected changes",
				"  default_prompt: Review this change",
			].join("\n"),
		);
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });

		const snapshot = await manager.refresh();

		expect(snapshot.resolved[0]?.interface).toEqual({
			displayName: "Review helper",
			shortDescription: "Review the selected changes",
			defaultPrompt: "Review this change",
		});
		expect(skillExtensionEntries(snapshot)).toMatchObject([
			{
				name: "review",
				title: "Review helper",
				description: "Review the selected changes",
				defaultPrompt: "$review Review this change",
			},
		]);
		expect(resolveSkillSelector(snapshot, "review")).toBe(snapshot.resolved[0]);
		expect(resolveSkillSelector(snapshot, "Review helper")).toBeUndefined();
	});

	it("excludes non-Codex product Skills while allowing Codex and unrestricted Skills", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		for (const [name, products] of [
			["codex-only", "[codex]"],
			["other-products", "[CHATGPT, atlas]"],
			["unrestricted", "[]"],
		] as const) {
			await writeSkill(root, name, name, `${name} workflow`);
			await mkdir(join(root, name, "agents"), { recursive: true });
			await writeFile(join(root, name, "agents", "openai.yaml"), `policy:\n  products: ${products}\n`);
		}
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });

		const snapshot = await manager.refresh();

		expect(snapshot.resolved.map(({ candidate }) => candidate.metadata.name)).toEqual(["codex-only", "unrestricted"]);
		expect(snapshot.candidates.map(({ metadata }) => metadata.name).sort()).toEqual(["codex-only", "unrestricted"]);
		expect(skillExtensionEntries(snapshot).map(({ name }) => name)).toEqual(["codex-only", "unrestricted"]);
	});

	it("changes the Skills capability revision when sidecar dependencies change", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		const skillDirectory = join(root, "review");
		const sidecar = join(skillDirectory, "agents", "openai.yaml");
		await writeSkill(root, "review", "review", "Review a change");
		await mkdir(join(skillDirectory, "agents"), { recursive: true });
		const writeDependency = (url: string) =>
			writeFile(
				sidecar,
				`dependencies:\n  tools:\n    - type: mcp\n      value: docs\n      transport: streamable_http\n      url: ${url}\npolicy:\n  products: [codex]\n`,
			);
		await writeDependency("https://example.test/one");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
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
		const first = await source.acquire(acquisition);
		await writeDependency("https://example.test/two");
		manager.markDirty();
		const second = await source.acquire(acquisition);

		expect(second.revision).not.toBe(first.revision);
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("lets an unrestricted fallback win when a higher-precedence Skill excludes Codex", async () => {
		const value = await fixture();
		const workspaceRoot = join(value.workspace, ".agents", "skills");
		const userRoot = join(value.home, ".agents", "skills");
		await writeSkill(workspaceRoot, "shared", "shared", "Workspace ChatGPT workflow");
		await mkdir(join(workspaceRoot, "shared", "agents"), { recursive: true });
		await writeFile(join(workspaceRoot, "shared", "agents", "openai.yaml"), "policy:\n  products: [CHATGPT]\n");
		await writeSkill(userRoot, "shared", "shared", "User Codex fallback");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });

		const snapshot = await manager.refresh();

		expect(snapshot.resolved).toHaveLength(1);
		expect(snapshot.resolved[0]).toMatchObject({
			winner: true,
			collisionCount: 1,
			sourceLabel: "~/.agents/skills",
			candidate: { metadata: { description: "User Codex fallback" } },
		});
		expect(snapshot.diagnostics.some(({ code }) => code === "skill-name-collision")).toBe(false);
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
			expect(lease.promptFragments[0]?.text).toContain("If you skip an obvious skill, say why");
			expect(lease.promptFragments[0]?.text).toContain("(file:");
			expect(lease.promptFragments[0]?.text).toContain("inspect");
			expect(lease.tools[0]?.tool.name).toBe("skill");
		} finally {
			await lease.dispose();
		}
	});

	it("renders Codex HostAliases with the configured lexical root instead of a canonical alias target", async () => {
		const value = await fixture();
		const canonicalHome = join(value.base, "canonical-home");
		const aliasedHome = join(value.base, "aliased-home");
		await mkdir(canonicalHome);
		await symlink(canonicalHome, aliasedHome, "dir");
		const roots = await collectSkillRoots({
			workspace: value.workspace,
			homeDirectory: aliasedHome,
			fileSystem: value.fileSystem,
		});
		await writeSkill(join(aliasedHome, ".agents", "skills"), "inspect", "inspect", "Inspect the current change");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			const prompt = lease.promptFragments[0]?.text ?? "";
			const userSkillRoot = join(aliasedHome, ".agents", "skills");
			const canonicalSkillRoot = await realpath(userSkillRoot);
			expect(canonicalSkillRoot).not.toBe(userSkillRoot);
			expect(prompt).toContain(
				"A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.",
			);
			expect(prompt).toContain(`- \`r0\` = \`${userSkillRoot}\``);
			expect(prompt).not.toContain(`- \`r0\` = \`${canonicalSkillRoot}\``);
			expect(prompt).toContain("- inspect: Inspect the current change (file: r0/inspect/SKILL.md)");
			expect(prompt).toContain("- How to use a skill (progressive disclosure):");
			expect(prompt).toContain(
				"the main agent must expand the listed short `path` with the matching alias from `### Skill roots`",
			);
		} finally {
			await lease.dispose();
		}
	});

	it("groups multiple Plugin Skills under one contained Plugin skills alias", async () => {
		const value = await fixture();
		const pluginRoot = join(value.workspace, ".agents", "plugins", "review-tools");
		const pluginSkillsRoot = join(pluginRoot, "skills");
		await writeSkill(pluginSkillsRoot, "release", "release", "Prepare a release");
		await writeSkill(pluginSkillsRoot, "review", "review", "Review the current change");
		const canonicalPluginRoot = await realpath(pluginRoot);
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: ["release", "review"].map((name) => ({
				path: join(canonicalPluginRoot, "skills", name),
				origin: {
					scope: "workspace" as const,
					root: canonicalPluginRoot,
					pluginRoot: canonicalPluginRoot,
					priority: 1,
					sourceLabel: `review-tools:${name}`,
					kind: "plugin" as const,
					pluginName: "review-tools",
				},
				symlinks: { mode: "follow" as const, containmentRoot: canonicalPluginRoot },
			})),
			profile: "strict",
		});
		const manager = new CodingSkillsManager({
			fileSystem: value.fileSystem,
			roots: value.roots,
			supplementalSnapshots: () => [pluginSnapshot],
		});
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			const prompt = lease.promptFragments[0]?.text ?? "";
			const canonicalSkillsRoot = join(canonicalPluginRoot, "skills");
			expect(prompt.match(/^- `r\d+` = /gmu)).toHaveLength(1);
			expect(prompt).toContain(`- \`r0\` = \`${canonicalSkillsRoot}\``);
			expect(prompt).toContain("- review-tools:release: Prepare a release (file: r0/release/SKILL.md)");
			expect(prompt).toContain("- review-tools:review: Review the current change (file: r0/review/SKILL.md)");
			expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(8_000);
		} finally {
			await lease.dispose();
		}
	});

	it("does not group a Plugin Skill whose file escapes the declared Plugin skills root", async () => {
		const value = await fixture();
		const pluginRoot = join(value.workspace, ".agents", "plugins", "review-tools");
		const outsideRoot = join(value.workspace, "outside-skills");
		await mkdir(pluginRoot, { recursive: true });
		await writeSkill(outsideRoot, "escaped", "escaped", "Outside the declared Plugin");
		const canonicalPluginRoot = await realpath(pluginRoot);
		const canonicalOutsideRoot = await realpath(outsideRoot);
		const skillRoot = join(canonicalOutsideRoot, "escaped");
		const pluginSnapshot = await createSkills<CodingSkillOrigin>({ fileSystem: value.fileSystem }).snapshot({
			roots: [
				{
					path: skillRoot,
					origin: {
						scope: "workspace",
						root: canonicalPluginRoot,
						pluginRoot: canonicalPluginRoot,
						priority: 1,
						sourceLabel: "review-tools:escaped",
						kind: "plugin",
						pluginName: "review-tools",
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
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			const prompt = lease.promptFragments[0]?.text ?? "";
			expect(prompt).not.toContain(join(canonicalPluginRoot, "skills"));
			expect(prompt).toContain(`- \`r0\` = \`${skillRoot}\``);
			expect(prompt).toContain("(file: r0/SKILL.md)");
			expect(prompt).not.toContain("../");
		} finally {
			await lease.dispose();
		}
	});

	it("budgets Skill metadata separately from fixed instructions for a 16k context window", async () => {
		const value = await fixture();
		await writeSkill(join(value.home, ".agents", "skills"), "inspect", "inspect", "Inspect the current change");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 16_000,
				maxTokens: 4_000,
			},
			signal: new AbortController().signal,
		});
		try {
			expect(lease.promptFragments[0]?.text).toContain("- inspect: Inspect the current change");
			expect(lease.tools[0]?.tool.name).toBe("skill");
		} finally {
			await lease.dispose();
		}
	});

	it("uses the model's two-percent metadata budget without an unrelated 8k whole-catalog cap", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		for (let index = 0; index < 100; index++) {
			const name = `short-${String(index).padStart(3, "0")}`;
			await writeSkill(root, name, name, "Short catalog description");
		}
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 400_000,
				maxTokens: 16_000,
			},
			signal: new AbortController().signal,
		});
		try {
			const prompt = lease.promptFragments[0]?.text ?? "";
			expect(Array.from(prompt.matchAll(/^- short-\d{3}:/gmu))).toHaveLength(100);
			expect(new TextEncoder().encode(prompt).byteLength).toBeGreaterThan(8_000);
			expect(prompt).not.toContain("additional skills omitted");
		} finally {
			await lease.dispose();
		}
	});

	it("uses frontmatter description in the model catalog while retaining interface metadata for the palette", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "review", "review", "Long frontmatter routing description");
		await mkdir(join(root, "review", "agents"), { recursive: true });
		await writeFile(
			join(root, "review", "agents", "openai.yaml"),
			"interface:\n  short_description: '  Concise   interface route  '\n",
		);
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
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
			const prompt = lease.promptFragments[0]?.text ?? "";
			expect(prompt).toContain("- review: Long frontmatter routing description");
			expect(prompt).not.toContain("Concise interface route");
			expect(skillExtensionEntries(manager.current!).at(0)?.description).toBe("Concise interface route");
		} finally {
			await lease.dispose();
		}
	});

	it("skips an oversized Skill metadata row and continues with later rows that fit", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		const oversizedDirectory = `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}/alpha`;
		await writeSkill(root, oversizedDirectory, "alpha", "Oversized locator");
		await writeSkill(root, "beta", "beta", "Later compact locator");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 4_000,
				maxTokens: 1_000,
			},
			signal: new AbortController().signal,
		});
		try {
			const prompt = lease.promptFragments[0]?.text ?? "";
			expect(prompt).not.toMatch(/^- alpha:/mu);
			expect(prompt).toContain("- beta: Later compact locator");
			expect(prompt).toContain("- 1 additional skill omitted from this bounded skills list.");
		} finally {
			await lease.dispose();
		}
	});

	it("shares a constrained metadata budget fairly across Skill descriptions", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		await writeSkill(root, "alpha", "alpha", "A".repeat(500));
		await writeSkill(root, "beta", "beta", "B".repeat(500));
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 4_000,
				maxTokens: 1_000,
			},
			signal: new AbortController().signal,
		});
		try {
			const prompt = lease.promptFragments[0]?.text ?? "";
			const alphaLength = /- alpha: (A+) \(file:/u.exec(prompt)?.[1]?.length ?? 0;
			const betaLength = /- beta: (B+) \(file:/u.exec(prompt)?.[1]?.length ?? 0;
			expect(alphaLength).toBeGreaterThan(0);
			expect(betaLength).toBeGreaterThan(0);
			// Per-line token rounding can differ by a few UTF-8 bytes, but both rows advance in turns.
			expect(Math.abs(alphaLength - betaLength)).toBeLessThanOrEqual(4);
			expect(alphaLength).toBeLessThan(500);
		} finally {
			await lease.dispose();
		}
	});

	it("reports omitted Skills in the model-visible bounded catalog", async () => {
		const value = await fixture();
		const root = join(value.home, ".agents", "skills");
		for (let index = 0; index < 12; index++) {
			const name = `skill-${String(index).padStart(2, "0")}`;
			await writeSkill(root, name, name, `Description for ${name}`);
		}
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 4_000,
				maxTokens: 1_000,
			},
			signal: new AbortController().signal,
		});
		try {
			const prompt = lease.promptFragments[0]?.text ?? "";
			const included = Array.from(prompt.matchAll(/^- (skill-\d\d):/gmu), (match) => match[1]);
			const omitted = Number(
				/^- (\d+) additional skills? omitted from this bounded skills list\.$/mu.exec(prompt)?.[1],
			);
			expect(included.length).toBeGreaterThan(0);
			expect(included).toEqual(
				Array.from({ length: included.length }, (_, index) => `skill-${String(index).padStart(2, "0")}`),
			);
			expect(omitted).toBe(12 - included.length);
		} finally {
			await lease.dispose();
		}
	});

	it("omits the catalog fragment when even the omission marker exceeds the metadata budget", async () => {
		const value = await fixture();
		await writeSkill(join(value.home, ".agents", "skills"), "inspect", "inspect", "Inspect the current change");
		const manager = new CodingSkillsManager({ fileSystem: value.fileSystem, roots: value.roots });
		const lease = await createSkillsCapabilitySource(manager).acquire({
			model: {
				id: "skills-test",
				name: "Skills test",
				api: "test",
				provider: "test",
				baseUrl: "http://localhost.invalid",
				reasoning: false,
				input: ["text" as const],
				contextWindow: 1,
				maxTokens: 1,
			},
			signal: new AbortController().signal,
		});
		try {
			expect(lease.promptFragments).toEqual([]);
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

	it("coalesces concurrent refreshes while freezing exact Skill contents for each Run", async () => {
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
		expect(skillFileReads).toBe(readsPerScan + 2);

		manager.markDirty();
		const beforeDirtyAcquisitions = skillFileReads;
		const leases = await Promise.all([
			source.acquire(acquisition),
			source.acquire(acquisition),
			source.acquire(acquisition),
		]);

		expect(skillFileReads).toBe(beforeDirtyAcquisitions + readsPerScan + leases.length);
		expect([...new Set(leases.map(({ revision }) => revision))]).toHaveLength(1);
		await Promise.all(leases.map((lease) => lease.dispose()));
		const beforeFinalAcquisition = skillFileReads;
		await (await source.acquire(acquisition)).dispose();
		expect(skillFileReads).toBe(beforeFinalAcquisition + 1);
	});
});
