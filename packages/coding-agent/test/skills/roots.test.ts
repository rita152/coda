import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSkillRoots } from "../../src/skills/roots.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("collectSkillRoots", () => {
	it("returns only the project and global cross-client Agent Skills directories", async () => {
		const base = await mkdtemp(join(tmpdir(), "coda-skill-roots-"));
		temporary.push(base);
		const workspace = join(base, "workspace");
		const home = join(base, "home");
		const roots = await collectSkillRoots({ workspace, homeDirectory: home });

		expect(roots.map(({ path }) => path)).toEqual([
			join(workspace, ".agents", "skills"),
			join(home, ".agents", "skills"),
		]);
		expect(roots.map(({ origin }) => origin)).toEqual([
			{ scope: "workspace", root: join(workspace, ".agents", "skills"), priority: 0 },
			{ scope: "user", root: join(home, ".agents", "skills"), priority: 1 },
		]);
		expect(roots[0]!.symlinks).toEqual({ mode: "follow", containmentRoot: workspace });
		expect(roots[1]!.symlinks).toEqual({ mode: "follow", allowOutsideRoot: true });
	});

	it("rejects relative project or global roots", async () => {
		await expect(collectSkillRoots({ workspace: "relative", homeDirectory: "/home/user" })).rejects.toThrow(
			"absolute",
		);
		await expect(collectSkillRoots({ workspace: "/workspace", homeDirectory: "relative" })).rejects.toThrow(
			"absolute",
		);
	});
});
