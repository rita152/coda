import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("collectSkillRoots", () => {
	it("discovers every repo layer from the nearest .git root to cwd even before Skill roots exist", async () => {
		const base = await mkdtemp(join(tmpdir(), "coda-skill-roots-ancestry-"));
		temporary.push(base);
		const repository = join(base, "repository");
		const workspace = join(repository, "packages", "app");
		const home = join(base, "home");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true })]);
		await writeFile(join(repository, ".git"), "gitdir: fake\n");

		const roots = await collectSkillRoots({
			workspace,
			homeDirectory: home,
			fileSystem: createNodeFileSystem(),
		});

		expect(roots.map(({ path }) => path)).toEqual([
			join(repository, ".agents", "skills"),
			join(repository, "packages", ".agents", "skills"),
			join(workspace, ".agents", "skills"),
			join(home, ".agents", "skills"),
			join(home, ".codex", "skills"),
		]);
		const repoPriorities = roots.slice(0, 3).map(({ origin }) => origin.priority);
		expect(repoPriorities[0]).toBeGreaterThan(repoPriorities[1]!);
		expect(repoPriorities[1]).toBeGreaterThan(repoPriorities[2]!);
		expect(repoPriorities[2]).toBe(0);
	});

	it("returns the cwd, standard user, and deprecated Codex personal Skill roots", async () => {
		const base = await mkdtemp(join(tmpdir(), "coda-skill-roots-"));
		temporary.push(base);
		const workspace = join(base, "workspace");
		const home = join(base, "home");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true })]);
		await writeFile(join(workspace, ".git"), "gitdir: fake\n");
		const roots = await collectSkillRoots({
			workspace,
			homeDirectory: home,
			fileSystem: createNodeFileSystem(),
		});

		expect(roots.map(({ path }) => path)).toEqual([
			join(workspace, ".agents", "skills"),
			join(home, ".agents", "skills"),
			join(home, ".codex", "skills"),
		]);
		expect(roots.map(({ origin }) => origin)).toEqual([
			{
				scope: "workspace",
				root: join(workspace, ".agents", "skills"),
				priority: 0,
				sourceLabel: "./.agents/skills",
				kind: "direct",
			},
			{
				scope: "user",
				root: join(home, ".agents", "skills"),
				priority: 2,
				sourceLabel: "~/.agents/skills",
				kind: "direct",
			},
			{
				scope: "user",
				root: join(home, ".codex", "skills"),
				priority: 2.5,
				sourceLabel: "~/.codex/skills",
				kind: "direct",
			},
		]);
		expect(roots[0]!.symlinks).toEqual({ mode: "follow", containmentRoot: workspace });
		expect(roots[1]!.symlinks).toEqual({ mode: "follow", allowOutsideRoot: true });
		expect(roots[2]!.symlinks).toEqual({ mode: "follow", allowOutsideRoot: true });
	});

	it("deduplicates normalized roots while retaining the higher-precedence origin", async () => {
		const base = await mkdtemp(join(tmpdir(), "coda-skill-roots-dedup-"));
		temporary.push(base);
		await writeFile(join(base, ".git"), "gitdir: fake\n");

		const roots = await collectSkillRoots({
			workspace: base,
			homeDirectory: join(base, "nested", ".."),
			fileSystem: createNodeFileSystem(),
		});

		expect(roots.map(({ path }) => path)).toEqual([join(base, ".agents", "skills"), join(base, ".codex", "skills")]);
		expect(roots[0]?.origin.scope).toBe("workspace");
	});

	it("falls back to cwd roots when project marker probes fail", async () => {
		const denied = Object.assign(new Error("denied"), { code: "EACCES" });
		const roots = await collectSkillRoots({
			workspace: "/workspace/nested",
			homeDirectory: "/home/user",
			fileSystem: { stat: async () => Promise.reject(denied) },
		});

		expect(roots.map(({ path }) => path)).toEqual([
			"/workspace/nested/.agents/skills",
			"/home/user/.agents/skills",
			"/home/user/.codex/skills",
		]);
	});

	it("rejects relative project or global roots", async () => {
		const fileSystem = createNodeFileSystem();
		await expect(
			collectSkillRoots({ workspace: "relative", homeDirectory: "/home/user", fileSystem }),
		).rejects.toThrow("absolute");
		await expect(
			collectSkillRoots({ workspace: "/workspace", homeDirectory: "relative", fileSystem }),
		).rejects.toThrow("absolute");
	});
});
