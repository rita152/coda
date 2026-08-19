import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { SkillFileSystem } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_SCHEMA, createPlugins } from "../src/index.ts";
import { nodePluginFileSystem } from "./helpers.ts";

const temporaryDirectories: string[] = [];

async function pluginRoot(index: number): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "coda-plugins-runtime-"));
	temporaryDirectories.push(root);
	await writeFile(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: `plugin-${index}` }),
	);
	await mkdir(join(root, "skills", `skill-${index}`), { recursive: true });
	await writeFile(
		join(root, "skills", `skill-${index}`, "SKILL.md"),
		`---\nname: skill-${index}\ndescription: Runtime limiter fixture\n---\n\nRun it.\n`,
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Agent Plugin runtime", () => {
	it("shares the @coda/skills read limiter across concurrent loads", async () => {
		const base = nodePluginFileSystem();
		let activeSkillReads = 0;
		let maximumSkillReads = 0;
		const fileSystem: SkillFileSystem = {
			...base,
			readFile: async (path) => {
				if (!path.endsWith(`${sep}SKILL.md`)) return base.readFile(path);
				activeSkillReads++;
				maximumSkillReads = Math.max(maximumSkillReads, activeSkillReads);
				try {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return await base.readFile(path);
				} finally {
					activeSkillReads--;
				}
			},
		};
		const roots = await Promise.all(Array.from({ length: 24 }, (_, index) => pluginRoot(index)));
		const plugins = createPlugins({ fileSystem });

		const snapshots = await Promise.all(roots.map((root) => plugins.load({ root, origin: "test" })));

		expect(snapshots.every(({ status }) => status === "loaded")).toBe(true);
		expect(maximumSkillReads).toBeGreaterThan(1);
		expect(maximumSkillReads).toBeLessThanOrEqual(16);
	});
});
