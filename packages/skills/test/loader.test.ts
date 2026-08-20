import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkills } from "../src/index.ts";
import { nodeSkillFileSystem, skillText } from "./helpers.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-skills-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeSkill(root: string, directory: string, text: string): Promise<string> {
	const target = join(root, directory);
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "SKILL.md"), text, "utf8");
	return target;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Skills loader", () => {
	it("discovers exact SKILL.md files deterministically and does not descend through a Skill root", async () => {
		const root = await temporaryDirectory();
		await writeSkill(root, "alpha", skillText("alpha"));
		await writeSkill(root, "group/beta", skillText("beta"));
		await writeSkill(root, "alpha/nested", skillText("nested"));
		await mkdir(join(root, "lower"));
		await writeFile(join(root, "lower", "skill.md"), skillText("lower"), "utf8");

		const snapshot = await createSkills<{ scope: string }>({ fileSystem: nodeSkillFileSystem() }).snapshot({
			roots: [{ path: root, origin: { scope: "workspace" } }],
		});

		expect(snapshot.candidates.map((candidate) => candidate.metadata.name)).toEqual(["alpha", "beta"]);
		expect(snapshot.candidates.every((candidate) => Object.isFrozen(candidate))).toBe(true);
	});

	it("retains same-name candidates and merges only canonical duplicates", async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();
		await writeSkill(first, "one", skillText("shared"));
		await writeSkill(second, "two", skillText("shared"));
		const snapshot = await createSkills<{ rank: number }>({ fileSystem: nodeSkillFileSystem() }).snapshot({
			roots: [
				{ path: first, origin: { rank: 0 } },
				{ path: first, origin: { rank: 1 } },
				{ path: second, origin: { rank: 2 } },
			],
		});

		expect(snapshot.candidates).toHaveLength(2);
		expect(snapshot.candidates.map((candidate) => candidate.metadata.name)).toEqual(["shared", "shared"]);
		expect(snapshot.candidates.some((candidate) => candidate.provenance.length === 2)).toBe(true);
		expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate-canonical-path" }));
	});

	it("applies scope-aware symlink containment", async () => {
		const workspace = await temporaryDirectory();
		const root = join(workspace, ".agents", "skills");
		const sharedInside = await writeSkill(workspace, "shared/inside", skillText("inside"));
		const outside = await temporaryDirectory();
		const sharedOutside = await writeSkill(outside, "outside", skillText("outside"));
		await mkdir(root, { recursive: true });
		await symlink(sharedInside, join(root, "inside"));
		await symlink(sharedOutside, join(root, "outside"));

		const runtime = createSkills<{ scope: string }>({ fileSystem: nodeSkillFileSystem() });
		const workspaceSnapshot = await runtime.snapshot({
			roots: [
				{
					path: root,
					origin: { scope: "workspace" },
					symlinks: { mode: "follow", containmentRoot: workspace },
				},
			],
		});
		expect(workspaceSnapshot.candidates.map((candidate) => candidate.metadata.name)).toEqual(["inside"]);
		expect(workspaceSnapshot.diagnostics).toContainEqual(
			expect.objectContaining({ code: "symlink-outside-boundary" }),
		);

		const userSnapshot = await runtime.snapshot({
			roots: [
				{
					path: root,
					origin: { scope: "user" },
					symlinks: { mode: "follow", allowOutsideRoot: true },
				},
			],
		});
		expect(userSnapshot.candidates.map((candidate) => candidate.metadata.name).sort()).toEqual(["inside", "outside"]);
	});

	it("applies the root policy to direct SKILL.md symlinks and diagnoses broken links", async () => {
		const root = await temporaryDirectory();
		const external = await temporaryDirectory();
		const externalDirectory = await writeSkill(external, "source", skillText("linked"));
		await mkdir(join(root, "linked"));
		await symlink(join(externalDirectory, "SKILL.md"), join(root, "linked", "SKILL.md"));
		await symlink(join(root, "missing"), join(root, "broken"));
		const runtime = createSkills({ fileSystem: nodeSkillFileSystem() });

		const ignored = await runtime.snapshot({ roots: [{ path: root, origin: "ignored" }] });
		expect(ignored.candidates).toEqual([]);
		expect(ignored.diagnostics).toContainEqual(expect.objectContaining({ code: "symlink-skipped" }));

		const followed = await runtime.snapshot({
			roots: [{ path: root, origin: "followed", symlinks: { mode: "follow", allowOutsideRoot: true } }],
		});
		expect(followed.candidates.map(({ metadata }) => metadata.name)).toEqual(["linked"]);
		expect(followed.diagnostics).toContainEqual(expect.objectContaining({ code: "symlink-broken" }));
	});

	it("treats non-standard files as ordinary resources and activates an exact SKILL.md revision lazily", async () => {
		const root = await temporaryDirectory();
		const source = ["---", "name: review", "description: Review a change", "---", "Use the checklist.", ""].join(
			"\n",
		);
		const directory = await writeSkill(root, "review", source);
		await mkdir(join(directory, "agents"));
		await writeFile(
			join(directory, "agents", "openai.yaml"),
			"interface:\n  display_name: Code Review\npolicy:\n  allow_implicit_invocation: true\n",
			"utf8",
		);
		await mkdir(join(directory, "references"));
		await writeFile(join(directory, "references", "checklist.md"), "Checklist", "utf8");
		await symlink(join(directory, "references", "checklist.md"), join(directory, "linked.md"));

		const snapshot = await createSkills<{ scope: string }>({ fileSystem: nodeSkillFileSystem() }).snapshot({
			roots: [{ path: root, origin: { scope: "user" } }],
		});
		const candidate = snapshot.candidates[0]!;
		expect(candidate.metadata).toEqual({
			name: "review",
			description: "Review a change",
			metadata: {},
		});

		const activated = await snapshot.activate(candidate.id, { arguments: "  inspect main  " });
		expect(activated).toMatchObject({
			ok: true,
			activation: {
				contents: source,
				body: "Use the checklist.\n",
				arguments: "inspect main",
				resources: ["agents/openai.yaml", "references/checklist.md"],
			},
		});
		if (activated.ok) {
			expect(activated.diagnostics).toContainEqual(expect.objectContaining({ code: "resource-symlink-skipped" }));
		}

		await writeFile(join(directory, "SKILL.md"), skillText("review", "Review a changed file"), "utf8");
		const stale = await snapshot.activate(candidate.id);
		expect(stale).toMatchObject({ ok: false, diagnostic: { code: "snapshot-stale" } });
	});

	it("supports strict discovery and hard traversal limits", async () => {
		const root = await temporaryDirectory();
		await writeSkill(root, "mismatch", skillText("other"));
		await writeSkill(root, "deep/one/two", skillText("two"));
		const runtime = createSkills({ fileSystem: nodeSkillFileSystem(), limits: { maxDepth: 1 } });

		const strict = await runtime.snapshot({ roots: [{ path: root, origin: "test" }], profile: "strict" });
		expect(strict.candidates).toEqual([]);
		expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: "name-directory-mismatch" }));
		expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: "scan-depth-exceeded" }));
	});

	it("diagnoses missing roots, invalid UTF-8, file bounds, symlink cycles, and resource bounds", async () => {
		const root = await temporaryDirectory();
		const missing = join(root, "missing");
		await mkdir(join(root, "invalid"));
		await writeFile(join(root, "invalid", "SKILL.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		await writeSkill(root, "large", skillText("large", "x".repeat(400)));
		const boundedDirectory = await writeSkill(root, "bounded", skillText("bounded"));
		await mkdir(join(boundedDirectory, "references"));
		await Promise.all(
			["a.md", "b.md", "c.md"].map((name) => writeFile(join(boundedDirectory, "references", name), name)),
		);
		await mkdir(join(root, "cycle"));
		await symlink(join(root, "cycle"), join(root, "cycle", "again"));

		const snapshot = await createSkills({
			fileSystem: nodeSkillFileSystem(),
			limits: { maxSkillFileBytes: 256, maxResourceEntries: 3 },
		}).snapshot({
			roots: [
				{ path: missing, origin: "missing" },
				{ path: root, origin: "root", symlinks: { mode: "follow", allowOutsideRoot: true } },
			],
		});

		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "root-not-found" }),
				expect.objectContaining({ code: "invalid-utf8" }),
				expect.objectContaining({ code: "skill-file-too-large" }),
				expect.objectContaining({ code: "symlink-cycle" }),
			]),
		);
		const bounded = snapshot.candidates.find(({ metadata }) => metadata.name === "bounded")!;
		const activation = await snapshot.activate(bounded.id);
		expect(activation.ok).toBe(true);
		if (activation.ok) {
			expect(activation.activation.resources).toEqual(["references/a.md", "references/b.md"]);
			expect(activation.activation.diagnostics).toContainEqual(
				expect.objectContaining({ code: "resource-limit-exceeded" }),
			);
			expect(activation.diagnostics).toContainEqual(expect.objectContaining({ code: "resource-limit-exceeded" }));
		}
	});

	it("bounds filesystem operations across concurrent snapshots", async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();
		await writeSkill(first, "one", skillText("one"));
		await writeSkill(second, "two", skillText("two"));
		const delegate = nodeSkillFileSystem();
		let active = 0;
		let maximum = 0;
		const runtime = createSkills({
			fileSystem: {
				...delegate,
				readFile: async (path) => {
					active++;
					maximum = Math.max(maximum, active);
					try {
						await new Promise((resolve) => setTimeout(resolve, 5));
						return await delegate.readFile(path);
					} finally {
						active--;
					}
				},
			},
			limits: { maxConcurrentReads: 1 },
		});

		await Promise.all([
			runtime.snapshot({ roots: [{ path: first, origin: "first" }] }),
			runtime.snapshot({ roots: [{ path: second, origin: "second" }] }),
		]);

		expect(maximum).toBe(1);
	});

	it("rejects ambiguous or unknown symlink policies as invalid API input", async () => {
		const root = await temporaryDirectory();
		const runtime = createSkills({ fileSystem: nodeSkillFileSystem() });

		await expect(
			runtime.snapshot({
				roots: [
					{
						path: root,
						origin: "test",
						symlinks: { mode: "follow", containmentRoot: root, allowOutsideRoot: true } as never,
					},
				],
			}),
		).rejects.toThrow("exactly one");
		await expect(
			runtime.snapshot({
				roots: [{ path: root, origin: "test", symlinks: { mode: "unknown" } as never }],
			}),
		).rejects.toThrow("Unknown Skill symlink policy");
	});

	it("propagates cancellation instead of converting it to an activation diagnostic", async () => {
		const root = await temporaryDirectory();
		await writeSkill(root, "cancel", skillText("cancel"));
		const delegate = nodeSkillFileSystem();
		const controller = new AbortController();
		let cancelRead = false;
		const runtime = createSkills({
			fileSystem: {
				...delegate,
				readFile: async (path) => {
					if (cancelRead && path.endsWith("SKILL.md")) controller.abort(new Error("activation canceled"));
					return delegate.readFile(path);
				},
			},
		});
		const snapshot = await runtime.snapshot({ roots: [{ path: root, origin: "test" }] });
		cancelRead = true;

		await expect(snapshot.activate(snapshot.candidates[0]!.id, { signal: controller.signal })).rejects.toThrow(
			"activation canceled",
		);
	});
});
