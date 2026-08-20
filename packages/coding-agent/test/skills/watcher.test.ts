import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSkillWatcherFactory } from "../../src/skills/watcher.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function expectChangeAfter(changeCount: () => number, action: () => Promise<void>): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
	const before = changeCount();
	await action();
	await vi.waitFor(() => expect(changeCount()).toBeGreaterThan(before), { timeout: 2_000, interval: 10 });
}

async function waitForQueuedEvents(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("Node Skill watcher", () => {
	it("discovers Skill and Plugin roots created after watching begins", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-skill-watcher-"));
		temporaryDirectories.push(workspace);
		const agents = join(workspace, ".agents");
		const skills = join(agents, "skills");
		const plugins = join(agents, "plugins");
		let changes = 0;
		const errors: Error[] = [];
		const watcher = createNodeSkillWatcherFactory().watch(
			[skills, plugins, skills],
			() => {
				changes += 1;
			},
			(error) => errors.push(error),
		);

		try {
			await expectChangeAfter(
				() => changes,
				() => mkdir(agents),
			);
			await expectChangeAfter(
				() => changes,
				() => mkdir(skills),
			);
			await expectChangeAfter(
				() => changes,
				() => writeFile(join(skills, "SKILL.md"), "---\nname: local\n---\n"),
			);
			await expectChangeAfter(
				() => changes,
				() => mkdir(plugins),
			);
			const plugin = join(plugins, "review");
			await expectChangeAfter(
				() => changes,
				() => mkdir(plugin),
			);
			await expectChangeAfter(
				() => changes,
				() => writeFile(join(plugin, "plugin.json"), '{"name":"review"}\n'),
			);
		} finally {
			watcher.dispose();
		}

		expect(errors).toEqual([]);
	});

	it("ignores unrelated changes while following a missing root", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-skill-watcher-bounded-"));
		temporaryDirectories.push(workspace);
		const skills = join(workspace, ".agents", "skills");
		let changes = 0;
		const watcher = createNodeSkillWatcherFactory().watch([skills], () => {
			changes += 1;
		});

		try {
			const unrelated = join(workspace, "unrelated");
			await mkdir(unrelated);
			await writeFile(join(unrelated, "file.txt"), "unrelated\n");
			await waitForQueuedEvents();
			expect(changes).toBe(0);

			await expectChangeAfter(
				() => changes,
				() => mkdir(join(workspace, ".agents")),
			);
		} finally {
			watcher.dispose();
		}
	});

	it("does not notify after disposal", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-skill-watcher-dispose-"));
		temporaryDirectories.push(workspace);
		const skills = join(workspace, ".agents", "skills");
		await mkdir(skills, { recursive: true });
		let changes = 0;
		const errors: Error[] = [];
		const watcher = createNodeSkillWatcherFactory().watch(
			[skills],
			() => {
				changes += 1;
			},
			(error) => errors.push(error),
		);

		await expectChangeAfter(
			() => changes,
			() => writeFile(join(skills, "before-dispose.txt"), "before\n"),
		);
		watcher.dispose();
		watcher.dispose();
		const atDisposal = changes;
		await writeFile(join(skills, "after-dispose.txt"), "after\n");
		await waitForQueuedEvents();

		expect(changes).toBe(atDisposal);
		expect(errors).toEqual([]);
	});

	it("reports an invalid path through onError", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "coda-skill-watcher-error-"));
		temporaryDirectories.push(workspace);
		const agentsFile = join(workspace, ".agents");
		await writeFile(agentsFile, "not a directory\n");
		const errors: Error[] = [];
		const watcher = createNodeSkillWatcherFactory().watch(
			[join(agentsFile, "skills")],
			() => undefined,
			(error) => errors.push(error),
		);

		try {
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toContain(`non-directory path: ${agentsFile}`);
		} finally {
			watcher.dispose();
		}
	});
});
