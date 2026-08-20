import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { IdGenerator } from "@coda/agent";
import { AGENT_PLUGIN_SCHEMA } from "@coda/plugins";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSystem } from "../../src/host/file-system.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import {
	type CodingPluginInstallationLimits,
	type CodingPluginInstallationStore,
	createCodingPluginInstallationStore,
} from "../../src/plugins/installation-store.ts";
import type { CodingPluginMarketplaceEntry } from "../../src/plugins/marketplace.ts";

const temporaryDirectories: string[] = [];
const executeFile = promisify(execFile);

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugin-installation-store-"));
	temporaryDirectories.push(directory);
	return directory;
}

class TestIds implements IdGenerator {
	#next = 0;

	generate(): string {
		return `test-${++this.#next}`;
	}
}

function marketplaceEntry(
	name = "review-tools",
	marketplace = "team-market",
	root = "/resolved/marketplace/package",
): CodingPluginMarketplaceEntry {
	return Object.freeze({
		pluginId: `${name}@${marketplace}`,
		name,
		marketplace,
		source: Object.freeze({ source: "local" as const, path: `./${name}`, root }),
	});
}

async function writePlugin(
	parent: string,
	options: { readonly name?: string; readonly version?: string; readonly body?: string } = {},
): Promise<string> {
	const root = join(parent, options.name ?? "review-tools");
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await writeFile(
		join(root, "plugin.json"),
		JSON.stringify({
			$schema: AGENT_PLUGIN_SCHEMA,
			name: options.name ?? "review-tools",
			...(options.version ? { version: options.version } : {}),
		}),
	);
	await writeFile(
		join(root, "skills", "review", "SKILL.md"),
		options.body ?? "---\nname: review\ndescription: Review changes\n---\n\nReview changes.\n",
	);
	return root;
}

async function createStore(
	root: string,
	limits?: Partial<CodingPluginInstallationLimits>,
): Promise<CodingPluginInstallationStore> {
	return createCodingPluginInstallationStore({
		root,
		fileSystem: createNodeFileSystem(),
		idGenerator: new TestIds(),
		limits,
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin installation store", () => {
	it("keeps empty revision retention and collection lazy for an uninitialized store", async () => {
		const configuredRoot = join(await temporaryDirectory(), "missing", "store");
		const base = createNodeFileSystem();
		let directoryCreations = 0;
		const store = createCodingPluginInstallationStore({
			root: configuredRoot,
			fileSystem: {
				...base,
				makeDirectory: async (...args) => {
					directoryCreations++;
					await base.makeDirectory(...args);
				},
			},
			idGenerator: new TestIds(),
		});

		const lease = await store.retainRevisions([]);
		await lease.dispose();
		await lease.dispose();
		await store.collectRetiredRevisions();

		expect(directoryCreations).toBe(0);
		await expect(lstat(configuredRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("installs one validated Agent Plugin into a content-addressed cache", async () => {
		const sourceParent = await temporaryDirectory();
		const packageRoot = await writePlugin(sourceParent, { version: "1.2.3" });
		const storeRoot = join(await temporaryDirectory(), "store");
		const store = await createStore(storeRoot);

		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });
		const snapshot = await store.list();

		expect(installed).toMatchObject({
			pluginId: "review-tools@team-market",
			name: "review-tools",
			marketplace: "team-market",
			version: "1.2.3",
			digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
			revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		const [cacheSlot, selectedDigest] = relative(
			join(await realpath(storeRoot), "cache"),
			installed.selectedRoot,
		).split(sep);
		expect(cacheSlot).toMatch(/^[a-f0-9]{64}$/u);
		expect(selectedDigest).toBe(installed.digest);
		expect(JSON.parse(await readFile(join(installed.selectedRoot, "plugin.json"), "utf8"))).toMatchObject({
			name: "review-tools",
		});
		expect(snapshot).toEqual({ version: 1, installations: [installed] });
		expect(Object.isFrozen(installed)).toBe(true);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.installations)).toBe(true);
		expect("enabled" in installed).toBe(false);
	});

	it.each(["staging", "cache"] as const)(
		"rejects a pre-existing %s symlink before any external read or write",
		async (ownedDirectory) => {
			const packageRoot = await writePlugin(await temporaryDirectory());
			const storeRoot = join(await temporaryDirectory(), "store");
			const outsideRoot = await temporaryDirectory();
			await mkdir(storeRoot, { recursive: true });
			const aliasedRoot = join(storeRoot, ownedDirectory);
			await symlink(outsideRoot, aliasedRoot, "dir");
			const base = createNodeFileSystem();
			let externalReadsOrWrites = 0;
			const beneathAlias = (path: string): boolean => path.startsWith(`${aliasedRoot}${sep}`);
			const observe = (path: string): void => {
				if (beneathAlias(path) || path === outsideRoot || path.startsWith(`${outsideRoot}${sep}`)) {
					externalReadsOrWrites++;
				}
			};
			const store = createCodingPluginInstallationStore({
				root: storeRoot,
				fileSystem: {
					...base,
					makeDirectory: async (path, options) => {
						if (beneathAlias(path)) externalReadsOrWrites++;
						await base.makeDirectory(path, options);
					},
					open: async (path, flags, mode) => {
						observe(path);
						return base.open(path, flags, mode);
					},
					readDirectory: async (path) => {
						observe(path);
						return base.readDirectory(path);
					},
					readFile: async (path) => {
						observe(path);
						return base.readFile(path);
					},
					rename: async (from, to) => {
						observe(from);
						observe(to);
						await base.rename(from, to);
					},
				},
				idGenerator: new TestIds(),
			});

			await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/store-owned/u);

			expect(externalReadsOrWrites).toBe(0);
			expect(await base.readDirectory(outsideRoot)).toEqual([]);
			expect((await store.list()).installations).toEqual([]);
		},
	);

	it("rejects pre-existing cache-slot and revision symlinks before external access or state commit", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0", body: "first" });
		const slotAttackRoot = await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "slot" });
		const revisionAttackRoot = await writePlugin(await temporaryDirectory(), {
			version: "3.0.0",
			body: "revision",
		});
		const outsideRevision = await writePlugin(await temporaryDirectory(), {
			version: "3.0.0",
			body: "revision",
		});
		const original = await createStore(storeRoot);
		const first = await original.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const cacheSlot = dirname(first.selectedRoot);
		const outsideSlot = await temporaryDirectory();
		await rm(cacheSlot, { recursive: true, force: true });
		await symlink(outsideSlot, cacheSlot, "dir");

		await expect(original.install({ entry: marketplaceEntry(), packageRoot: slotAttackRoot })).rejects.toThrow(
			/store-owned/u,
		);
		expect(await createNodeFileSystem().readDirectory(outsideSlot)).toEqual([]);
		expect((await original.list()).installations).toEqual([first]);

		await rm(cacheSlot, { force: true });
		await mkdir(cacheSlot, { mode: 0o700 });
		const revisionDigest = await original.digestPackage(revisionAttackRoot);
		const revisionAlias = join(cacheSlot, revisionDigest);
		await symlink(outsideRevision, revisionAlias, "dir");
		const base = createNodeFileSystem();
		let externalReadsOrWrites = 0;
		const observe = (path: string): void => {
			if (
				path === outsideRevision ||
				path.startsWith(`${outsideRevision}${sep}`) ||
				path.startsWith(`${revisionAlias}${sep}`)
			) {
				externalReadsOrWrites++;
			}
		};
		const restarted = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readDirectory: async (path) => {
					observe(path);
					return base.readDirectory(path);
				},
				readFile: async (path) => {
					observe(path);
					return base.readFile(path);
				},
				open: async (path, flags, mode) => {
					observe(path);
					return base.open(path, flags, mode);
				},
				rename: async (from, to) => {
					observe(from);
					observe(to);
					await base.rename(from, to);
				},
			},
			idGenerator: new TestIds(),
		});

		await expect(restarted.install({ entry: marketplaceEntry(), packageRoot: revisionAttackRoot })).rejects.toThrow(
			/store-owned/u,
		);

		expect(externalReadsOrWrites).toBe(0);
		expect((await restarted.list()).installations).toEqual([first]);
	});

	it.each(["skill", "mcp"] as const)(
		"rejects a still-valid %s mutation after restart when it no longer matches the selected digest",
		async (component) => {
			const packageRoot = await writePlugin(await temporaryDirectory(), { version: "1.2.3" });
			if (component === "mcp") {
				await writeFile(
					join(packageRoot, "mcp.json"),
					JSON.stringify({
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: { docs: { type: "streamable-http", url: "https://example.test/initial" } },
					}),
				);
			}
			const storeRoot = join(await temporaryDirectory(), "store");
			const original = await createStore(storeRoot);
			const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
			if (component === "skill") {
				await writeFile(
					join(installed.selectedRoot, "skills", "review", "SKILL.md"),
					"---\nname: review\ndescription: Review changed content\n---\n\nReview changed content.\n",
				);
			} else {
				await writeFile(
					join(installed.selectedRoot, "mcp.json"),
					JSON.stringify({
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: { docs: { type: "streamable-http", url: "https://example.test/changed" } },
					}),
				);
			}
			const restarted = await createStore(storeRoot);
			const selected = (await restarted.list()).installations[0]!;

			await expect(restarted.verify(selected)).resolves.toMatchObject({
				status: "rejected",
				code: "plugin-installation-digest-mismatch",
				record: selected,
			});
		},
	);

	it("rejects an executable-bit mutation that changes a managed stdio program's semantics", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory(), { version: "1.2.3" });
		await mkdir(join(packageRoot, "bin"));
		await writeFile(join(packageRoot, "bin", "server"), "#!/bin/sh\nexit 0\n");
		await chmod(join(packageRoot, "bin", "server"), 0o755);
		const storeRoot = join(await temporaryDirectory(), "store");
		const original = await createStore(storeRoot);
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		await chmod(join(installed.selectedRoot, "bin", "server"), 0o644);
		const restarted = await createStore(storeRoot);
		const selected = (await restarted.list()).installations[0]!;

		await expect(restarted.verify(selected)).resolves.toMatchObject({
			status: "rejected",
			code: "plugin-installation-digest-mismatch",
		});
	});

	it("rejects an exact directory mode mutation in the managed package cache", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory(), { version: "1.2.3" });
		await mkdir(join(packageRoot, "work"), { mode: 0o755 });
		const storeRoot = join(await temporaryDirectory(), "store");
		const original = await createStore(storeRoot);
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		await chmod(join(installed.selectedRoot, "work"), 0o644);
		const restarted = await createStore(storeRoot);
		const selected = (await restarted.list()).installations[0]!;

		await expect(restarted.verify(selected)).resolves.toMatchObject({
			status: "rejected",
			code: "plugin-installation-digest-mismatch",
		});
	});

	it("rejects a 0700 to 0001 file mode mutation in the managed package cache", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory(), { version: "1.2.3" });
		await mkdir(join(packageRoot, "bin"));
		await writeFile(join(packageRoot, "bin", "server"), "#!/bin/sh\nexit 0\n");
		await chmod(join(packageRoot, "bin", "server"), 0o700);
		const storeRoot = join(await temporaryDirectory(), "store");
		const original = await createStore(storeRoot);
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		const cachedProgram = join(installed.selectedRoot, "bin", "server");
		const installedBytes = await readFile(cachedProgram);
		await chmod(cachedProgram, 0o001);
		const base = createNodeFileSystem();
		const restarted = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readFile: async (path) => (path === cachedProgram ? installedBytes : base.readFile(path)),
			},
			idGenerator: new TestIds(),
		});
		const selected = (await restarted.list()).installations[0]!;

		await expect(restarted.verify(selected)).resolves.toMatchObject({
			status: "rejected",
			code: "plugin-installation-digest-mismatch",
		});
	});

	it("rejects a selected-root symlink swap before reading its external target", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const original = await createStore(storeRoot);
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		const outsideRoot = await writePlugin(await temporaryDirectory());
		await writeFile(
			join(outsideRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { escaped: { command: "outside-plugin-process" } },
			}),
		);
		await rm(installed.selectedRoot, { recursive: true, force: true });
		await symlink(outsideRoot, installed.selectedRoot, "dir");
		const base = createNodeFileSystem();
		let outsideReads = 0;
		const observeOutside = (path: string): void => {
			if (path === outsideRoot || path.startsWith(`${outsideRoot}${sep}`)) outsideReads++;
		};
		const restarted = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readDirectory: async (path) => {
					observeOutside(path);
					return base.readDirectory(path);
				},
				readFile: async (path) => {
					observeOutside(path);
					return base.readFile(path);
				},
			},
			idGenerator: new TestIds(),
		});
		const selected = (await restarted.list()).installations[0]!;

		await expect(restarted.verify(selected)).resolves.toMatchObject({
			status: "rejected",
			code: "plugin-installation-root-invalid",
			record: selected,
		});
		expect(outsideReads).toBe(0);
	});

	it("rejects an injected .codex-plugin cache entry without probing any reserved descendant", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const original = await createStore(storeRoot);
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		const reservedRoot = join(installed.selectedRoot, ".codex-plugin");
		await mkdir(reservedRoot);
		await writeFile(join(reservedRoot, "plugin.json"), "poisoned legacy package");
		const base = createNodeFileSystem();
		let forbiddenProbes = 0;
		const assertAllowed = (path: string): void => {
			if (path === reservedRoot || path.startsWith(`${reservedRoot}${sep}`)) {
				forbiddenProbes++;
				throw new Error(`Reserved package path was probed: ${path}`);
			}
		};
		const guarded = {
			...base,
			lstat: async (path: string) => {
				assertAllowed(path);
				return base.lstat(path);
			},
			readDirectory: async (path: string) => {
				assertAllowed(path);
				return base.readDirectory(path);
			},
			readFile: async (path: string) => {
				assertAllowed(path);
				return base.readFile(path);
			},
		};
		const restarted = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: guarded,
			idGenerator: new TestIds(),
		});
		const selected = (await restarted.list()).installations[0]!;

		await expect(restarted.verify(selected)).resolves.toMatchObject({
			status: "rejected",
			code: "plugin-installation-verification-failed",
			message: expect.stringContaining(".codex-plugin"),
		});
		expect(forbiddenProbes).toBe(0);
	});

	it.each(["workspace-local", "user-local"])(
		"rejects managed installation identity in the reserved %s namespace",
		async (marketplace) => {
			const packageRoot = await writePlugin(await temporaryDirectory());
			const store = await createStore(join(await temporaryDirectory(), "store"));

			await expect(
				store.install({ entry: marketplaceEntry("review-tools", marketplace), packageRoot }),
			).rejects.toThrow(/reserved/u);
		},
	);

	it("atomically selects a new content revision when the same PluginId is upgraded", async () => {
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0", body: "first" });
		const secondRoot = await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "second" });
		const store = await createStore(join(await temporaryDirectory(), "store"));

		const first = await store.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const second = await store.install({ entry: marketplaceEntry(), packageRoot: secondRoot });

		expect(second.version).toBe("2.0.0");
		expect(second.digest).not.toBe(first.digest);
		expect(second.revision).not.toBe(first.revision);
		expect((await store.list()).installations).toEqual([second]);
	});

	it("keeps case-distinct PluginIds in independent lowercase cache slots through removal and verification", async () => {
		const upperRoot = await writePlugin(await temporaryDirectory(), { name: "p" });
		const lowerRoot = await writePlugin(await temporaryDirectory(), { name: "p" });
		const storeRoot = join(await temporaryDirectory(), "store");
		const store = await createStore(storeRoot);

		const upper = await store.install({ entry: marketplaceEntry("p", "Team"), packageRoot: upperRoot });
		const lower = await store.install({ entry: marketplaceEntry("p", "team"), packageRoot: lowerRoot });
		const cacheRoot = join(await realpath(storeRoot), "cache");
		const upperSlot = relative(cacheRoot, upper.selectedRoot).split(sep)[0];
		const lowerSlot = relative(cacheRoot, lower.selectedRoot).split(sep)[0];

		expect(upperSlot).toMatch(/^[a-f0-9]{64}$/u);
		expect(lowerSlot).toMatch(/^[a-f0-9]{64}$/u);
		expect(upperSlot).not.toBe(lowerSlot);

		await store.remove(upper.pluginId);
		await store.collectRetiredRevisions();

		await expect(lstat(upper.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(store.verify(lower)).resolves.toMatchObject({ status: "verified", record: lower });
		expect((await store.list()).installations).toEqual([lower]);
	});

	it("retains the selected revision when an upgrade package is invalid", async () => {
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const mismatchedRoot = await writePlugin(await temporaryDirectory(), {
			name: "other-tools",
			version: "2.0.0",
		});
		const store = await createStore(join(await temporaryDirectory(), "store"));
		const first = await store.install({ entry: marketplaceEntry(), packageRoot: firstRoot });

		await expect(store.install({ entry: marketplaceEntry(), packageRoot: mismatchedRoot })).rejects.toThrow(
			/does not match PluginId name/u,
		);

		expect((await store.list()).installations).toEqual([first]);
	});

	it("derives the digest from sorted relative paths, entry kinds, exact modes, and file bytes", async () => {
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const movedRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		await writeFile(join(firstRoot, "alpha.txt"), "same bytes");
		await writeFile(join(movedRoot, "alpha.txt"), "same bytes");
		const changedPathRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		await writeFile(join(changedPathRoot, "zeta.txt"), "same bytes");
		const emptyDirectoryRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		await writeFile(join(emptyDirectoryRoot, "alpha.txt"), "same bytes");
		await mkdir(join(emptyDirectoryRoot, "resources", "empty"), { recursive: true });
		const store = await createStore(join(await temporaryDirectory(), "store"));

		const first = await store.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const moved = await store.install({ entry: marketplaceEntry(), packageRoot: movedRoot });
		const changedPath = await store.install({ entry: marketplaceEntry(), packageRoot: changedPathRoot });
		const emptyDirectory = await store.install({ entry: marketplaceEntry(), packageRoot: emptyDirectoryRoot });

		expect(moved.digest).toBe(first.digest);
		expect(moved.selectedRoot).toBe(first.selectedRoot);
		expect(changedPath.digest).not.toBe(first.digest);
		expect(emptyDirectory.digest).not.toBe(first.digest);
	});

	it("preserves exact source modes and derives different digests for new installations", async () => {
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const secondRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const firstModeRoot = join(firstRoot, "resources", "mode");
		const secondModeRoot = join(secondRoot, "resources", "mode");
		await mkdir(firstModeRoot, { recursive: true });
		await mkdir(secondModeRoot, { recursive: true });
		await chmod(firstModeRoot, 0o755);
		await chmod(secondModeRoot, 0o777);
		const base = createNodeFileSystem();
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...base,
				makeDirectory: async (path, options) =>
					base.makeDirectory(
						path,
						options?.mode === undefined ? options : { ...options, mode: options.mode & 0o755 },
					),
			},
			idGenerator: new TestIds(),
		});

		const first = await store.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const second = await store.install({ entry: marketplaceEntry(), packageRoot: secondRoot });

		expect(second.digest).not.toBe(first.digest);
		await expect(store.verify(second)).resolves.toMatchObject({ status: "verified", record: second });
		expect((await lstat(join(second.selectedRoot, "resources", "mode"))).mode & 0o777).toBe(0o777);
	});

	it.each([
		[{ maxFiles: 1 }, /maximum file count of 1/u],
		[{ maxBytes: 1 }, /maximum byte count of 1/u],
		[{ maxDepth: 1 }, /maximum copy depth of 1/u],
	] as const)("rejects a package outside bounded copy limits: %o", async (limits, expected) => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		const store = await createStore(join(await temporaryDirectory(), "store"), limits);

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(expected);
		expect((await store.list()).installations).toEqual([]);
	});

	it("dereferences internal file and directory symlinks into a verified symlink-free cache", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		const sharedDirectory = join(packageRoot, "shared");
		const sharedFile = join(sharedDirectory, "runner.sh");
		await mkdir(sharedDirectory, { recursive: true });
		await writeFile(sharedFile, "#!/bin/sh\necho linked\n");
		await chmod(sharedDirectory, 0o751);
		await chmod(sharedFile, 0o500);
		await symlink("shared", join(packageRoot, "linked-directory"), "dir");
		await symlink("shared/runner.sh", join(packageRoot, "linked-file"), "file");
		const store = await createStore(join(await temporaryDirectory(), "store"));

		const sourceDigest = await store.digestPackage(packageRoot);
		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });

		expect(installed.digest).toBe(sourceDigest);
		expect(await readFile(join(installed.selectedRoot, "linked-file"), "utf8")).toContain("echo linked");
		expect((await lstat(join(installed.selectedRoot, "linked-file"))).isSymbolicLink()).toBe(false);
		expect((await lstat(join(installed.selectedRoot, "linked-file"))).mode & 0o777).toBe(0o500);
		expect((await lstat(join(installed.selectedRoot, "linked-directory"))).isSymbolicLink()).toBe(false);
		expect((await lstat(join(installed.selectedRoot, "linked-directory"))).mode & 0o777).toBe(0o751);
		await expect(store.listVerified()).resolves.toMatchObject({
			verifications: [{ status: "verified", record: installed }],
		});
	});

	it("counts dereferenced symlink bytes against installation limits", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		await writeFile(join(packageRoot, "shared.txt"), "x".repeat(600));
		const store = await createStore(join(await temporaryDirectory(), "store"), { maxBytes: 1_000 });
		await expect(store.digestPackage(packageRoot)).resolves.toMatch(/^[a-f0-9]{64}$/u);

		await symlink("shared.txt", join(packageRoot, "linked.txt"), "file");

		await expect(store.digestPackage(packageRoot)).rejects.toThrow(/maximum byte count/u);
		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(
			/maximum byte count of 1000/u,
		);
		expect((await store.list()).installations).toEqual([]);
	});

	it("rejects a package symbolic-link cycle without selecting it", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		await symlink(".", join(packageRoot, "cycle"), "dir");
		const store = await createStore(join(await temporaryDirectory(), "store"));

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/cycle/u);
		expect((await store.list()).installations).toEqual([]);
	});

	it("rejects an internal symlink into .codex-plugin without probing the reserved target", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		const reservedRoot = join(packageRoot, ".codex-plugin");
		await mkdir(reservedRoot);
		await writeFile(join(reservedRoot, "secret.txt"), "must not be copied\n");
		await symlink(".codex-plugin", join(packageRoot, "portable-looking"), "dir");
		const canonicalReservedRoot = await realpath(reservedRoot);
		const base = createNodeFileSystem();
		let reservedProbes = 0;
		const forbidden = (path: string): boolean =>
			path === canonicalReservedRoot || path.startsWith(`${canonicalReservedRoot}${sep}`);
		const rejectReserved = (path: string): never => {
			reservedProbes++;
			throw new Error(`reserved symlink target was probed: ${path}`);
		};
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...base,
				realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
				lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
				stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
				readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
				readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
			},
			idGenerator: new TestIds(),
		});

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/\.codex-plugin/u);
		expect(reservedProbes).toBe(0);
		expect((await store.list()).installations).toEqual([]);
	});

	it("rejects a package containing a symbolic link without selecting it", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		const outside = join(await temporaryDirectory(), "outside.txt");
		await writeFile(outside, "outside");
		await symlink(outside, join(packageRoot, "escape.txt"));
		const store = await createStore(join(await temporaryDirectory(), "store"));

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(
			/symbolic link: escape\.txt/u,
		);
		expect((await store.list()).installations).toEqual([]);
	});

	it("rejects a package containing a special filesystem entry", async () => {
		const packageRoot = await realpath(await writePlugin(await temporaryDirectory()));
		const specialPath = join(packageRoot, "device");
		const base = createNodeFileSystem();
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...base,
				readDirectory: async (path) =>
					path === packageRoot
						? [...(await base.readDirectory(path)), { name: "device", kind: "other" as const }]
						: base.readDirectory(path),
				lstat: async (path) =>
					path === specialPath ? { kind: "other", size: 0, mode: 0, modifiedAt: 0 } : base.lstat(path),
			},
			idGenerator: new TestIds(),
		});

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/special file: device/u);
	});

	it("rejects a traversal-shaped directory entry before accessing its target", async () => {
		const packageRoot = await realpath(await writePlugin(await temporaryDirectory()));
		const base = createNodeFileSystem();
		let traversalAccesses = 0;
		const traversalTarget = join(packageRoot, "..");
		const rejectTraversal = (path: string): void => {
			if (path !== traversalTarget) return;
			traversalAccesses++;
			throw new Error("traversal target was accessed");
		};
		const fileSystem: FileSystem = {
			...base,
			readDirectory: async (path) =>
				path === packageRoot
					? [...(await base.readDirectory(path)), { name: "..", kind: "directory" as const }]
					: base.readDirectory(path),
			lstat: async (path) => {
				rejectTraversal(path);
				return base.lstat(path);
			},
			readFile: async (path) => {
				rejectTraversal(path);
				return base.readFile(path);
			},
		};
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem,
			idGenerator: new TestIds(),
		});

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/unsafe path entry/u);
		expect(traversalAccesses).toBe(0);
	});

	it("omits a poisoned .codex-plugin subtree without statting or reading it", async () => {
		const packageRoot = await writePlugin(await temporaryDirectory());
		const legacyRoot = join(packageRoot, ".codex-plugin");
		await mkdir(legacyRoot, { recursive: true });
		await writeFile(join(legacyRoot, "plugin.json"), JSON.stringify({ name: "legacy-poison" }));
		const base = createNodeFileSystem();
		let legacyAccesses = 0;
		const rejectLegacy = (path: string): void => {
			if (path !== legacyRoot && !path.includes(`${sep}.codex-plugin${sep}`)) return;
			legacyAccesses++;
			throw new Error("legacy subtree was accessed");
		};
		const fileSystem: FileSystem = {
			...base,
			realpath: async (path) => {
				rejectLegacy(path);
				return base.realpath(path);
			},
			stat: async (path) => {
				rejectLegacy(path);
				return base.stat(path);
			},
			lstat: async (path) => {
				rejectLegacy(path);
				return base.lstat(path);
			},
			readDirectory: async (path) => {
				rejectLegacy(path);
				return base.readDirectory(path);
			},
			readFile: async (path) => {
				rejectLegacy(path);
				return base.readFile(path);
			},
		};
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem,
			idGenerator: new TestIds(),
		});

		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });

		expect(legacyAccesses).toBe(0);
		await expect(lstat(join(installed.selectedRoot, ".codex-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a package beneath .codex-plugin before reading any package path", async () => {
		const packageRoot = await realpath(
			await writePlugin(join(await temporaryDirectory(), ".codex-plugin", "nested")),
		);
		const base = createNodeFileSystem();
		let packageAccesses = 0;
		const rejectPackageAccess = (path: string): void => {
			if (path !== packageRoot && !path.startsWith(`${packageRoot}${sep}`)) return;
			packageAccesses++;
			throw new Error("legacy package path was accessed");
		};
		const fileSystem: FileSystem = {
			...base,
			lstat: async (path) => {
				rejectPackageAccess(path);
				return base.lstat(path);
			},
			realpath: async (path) => {
				rejectPackageAccess(path);
				return base.realpath(path);
			},
			readDirectory: async (path) => {
				rejectPackageAccess(path);
				return base.readDirectory(path);
			},
			readFile: async (path) => {
				rejectPackageAccess(path);
				return base.readFile(path);
			},
		};
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem,
			idGenerator: new TestIds(),
		});

		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(/\.codex-plugin/u);
		expect(packageAccesses).toBe(0);
	});

	it("rejects a package alias resolving beneath .codex-plugin before reading the alias or target", async () => {
		const targetRoot = await realpath(await writePlugin(join(await temporaryDirectory(), ".codex-plugin", "nested")));
		const aliasRoot = join(await temporaryDirectory(), "portable-looking");
		await symlink(targetRoot, aliasRoot, "dir");
		const base = createNodeFileSystem();
		let packageReads = 0;
		const rejectPackageRead = (path: string): void => {
			if (
				path !== aliasRoot &&
				!path.startsWith(`${aliasRoot}${sep}`) &&
				path !== targetRoot &&
				!path.startsWith(`${targetRoot}${sep}`)
			) {
				return;
			}
			packageReads++;
			throw new Error("aliased legacy package was read");
		};
		const fileSystem: FileSystem = {
			...base,
			lstat: async (path) => {
				rejectPackageRead(path);
				return base.lstat(path);
			},
			readDirectory: async (path) => {
				rejectPackageRead(path);
				return base.readDirectory(path);
			},
			readFile: async (path) => {
				rejectPackageRead(path);
				return base.readFile(path);
			},
		};
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem,
			idGenerator: new TestIds(),
		});

		await expect(store.install({ entry: marketplaceEntry(), packageRoot: aliasRoot })).rejects.toThrow(
			/\.codex-plugin/u,
		);
		expect(packageReads).toBe(0);
	});

	it("retains the old selection when the atomic state rename fails", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const secondRoot = await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "upgrade" });
		const base = createNodeFileSystem();
		const original = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: base,
			idGenerator: new TestIds(),
		});
		const first = await original.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const failing = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					if (to.endsWith(`${sep}installations.v1.json`)) throw new Error("simulated state write interruption");
					await base.rename(from, to);
				},
			},
			idGenerator: new TestIds(),
		});

		await expect(failing.install({ entry: marketplaceEntry(), packageRoot: secondRoot })).rejects.toThrow(
			/simulated state write interruption/u,
		);

		expect((await original.list()).installations).toEqual([first]);
	});

	it("retains the old selection when installation is aborted after cache activation", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0" });
		const secondRoot = await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "upgrade" });
		const base = createNodeFileSystem();
		const original = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: base,
			idGenerator: new TestIds(),
		});
		const first = await original.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		const controller = new AbortController();
		const interrupted = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					await base.rename(from, to);
					if (to.includes(`${sep}cache${sep}`)) controller.abort(new Error("simulated interruption"));
				},
			},
			idGenerator: new TestIds(),
		});

		await expect(
			interrupted.install({ entry: marketplaceEntry(), packageRoot: secondRoot, signal: controller.signal }),
		).rejects.toThrow(/simulated interruption/u);

		expect((await original.list()).installations).toEqual([first]);
	});

	it("removes only the selected installation cache and never Plugin data", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const pluginData = join(storeRoot, "plugin-data", "review-tools", "keep.txt");
		await mkdir(join(storeRoot, "plugin-data", "review-tools"), { recursive: true });
		await writeFile(pluginData, "persistent data");
		const reviewRoot = await writePlugin(await temporaryDirectory(), { name: "review-tools" });
		const formatRoot = await writePlugin(await temporaryDirectory(), { name: "format-tools" });
		const store = await createStore(storeRoot);
		const review = await store.install({ entry: marketplaceEntry("review-tools"), packageRoot: reviewRoot });
		const format = await store.install({ entry: marketplaceEntry("format-tools"), packageRoot: formatRoot });

		await store.remove(review.pluginId);
		await store.collectRetiredRevisions();

		expect((await store.list()).installations).toEqual([format]);
		await expect(lstat(review.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(format.selectedRoot)).isDirectory()).toBe(true);
		expect(await readFile(pluginData, "utf8")).toBe("persistent data");
	});

	it("retires a removed revision until a new Project publication and the last Run lease release", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const base = createNodeFileSystem();
		let selectedRoot = "";
		let selectedRootCleanupCount = 0;
		const store = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				removeDirectory: async (path) => {
					if (path === selectedRoot) selectedRootCleanupCount++;
					await base.removeDirectory(path);
				},
			},
			idGenerator: new TestIds(),
		});
		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });
		selectedRoot = installed.selectedRoot;
		const activeRun = await store.retainRevisions([installed.selectedRoot]);

		await store.remove(installed.pluginId);
		expect((await store.list()).installations).toEqual([]);
		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);

		await store.collectRetiredRevisions();
		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);
		expect(selectedRootCleanupCount).toBe(0);

		await Promise.all([activeRun.dispose(), activeRun.dispose()]);
		await expect(lstat(installed.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect(selectedRootCleanupCount).toBe(1);
	});

	it("keeps an old revision retained across Store instances until its lease is disposed", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const firstRoot = await writePlugin(await temporaryDirectory(), { version: "1.0.0", body: "first" });
		const secondRoot = await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "second" });
		const base = createNodeFileSystem();
		let retiredRoot = "";
		let retiredRootCleanupCount = 0;
		const fileSystem = {
			...base,
			removeDirectory: async (path: string) => {
				if (path === retiredRoot) retiredRootCleanupCount++;
				await base.removeDirectory(path);
			},
		};
		const firstStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem,
			idGenerator: new TestIds(),
		});
		const secondStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem,
			idGenerator: new TestIds(),
		});
		const first = await firstStore.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		retiredRoot = first.selectedRoot;
		const activeRun = await firstStore.retainRevisions([first.selectedRoot]);

		const second = await secondStore.install({ entry: marketplaceEntry(), packageRoot: secondRoot });
		await secondStore.collectRetiredRevisions();

		expect((await lstat(first.selectedRoot)).isDirectory()).toBe(true);
		expect((await lstat(second.selectedRoot)).isDirectory()).toBe(true);

		await activeRun.dispose();

		await expect(lstat(first.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(second.selectedRoot)).isDirectory()).toBe(true);
		expect(retiredRootCleanupCount).toBe(1);
	});

	it("keeps a revision until every durable lease from independent Store instances is disposed", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const firstStore = await createStore(storeRoot);
		const secondStore = await createStore(storeRoot);
		const installed = await firstStore.install({ entry: marketplaceEntry(), packageRoot });
		const firstLease = await firstStore.retainRevisions([installed.selectedRoot]);
		const secondLease = await secondStore.retainRevisions([installed.selectedRoot]);

		await firstStore.remove(installed.pluginId);
		await secondStore.collectRetiredRevisions();
		await firstLease.dispose();

		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);

		await secondLease.dispose();

		await expect(lstat(installed.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not collect an unselected revision on lease release before Project publication marks it retired", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const store = await createStore(storeRoot);
		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });
		const activeRun = await store.retainRevisions([installed.selectedRoot]);

		await store.remove(installed.pluginId);
		await activeRun.dispose();

		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);

		await store.collectRetiredRevisions();

		await expect(lstat(installed.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails closed on corrupt retired-revision state without deleting a marked cache revision", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const store = await createStore(storeRoot);
		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });
		const activeRun = await store.retainRevisions([installed.selectedRoot]);
		await store.remove(installed.pluginId);
		await store.collectRetiredRevisions();
		const retiredState = join(await realpath(storeRoot), "retired-revisions.v1.json");
		await writeFile(retiredState, '{"version":2,"revisions":[]}\n');

		await expect(activeRun.dispose()).rejects.toThrow(/corrupt retired Plugin revision state/u);
		await expect(store.collectRetiredRevisions()).rejects.toThrow(/corrupt retired Plugin revision state/u);

		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);
		expect(await readFile(retiredState, "utf8")).toBe('{"version":2,"revisions":[]}\n');
	});

	it("collects an unselected revision retained only by a process that has exited", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const store = await createStore(storeRoot);
		const installed = await store.install({ entry: marketplaceEntry(), packageRoot });
		const installationStoreUrl = new URL("../../src/plugins/installation-store.ts", import.meta.url).href;
		const nodeFileSystemUrl = new URL("../../src/host/node-file-system.ts", import.meta.url).href;
		const childSource = `
			import { createCodingPluginInstallationStore } from ${JSON.stringify(installationStoreUrl)};
			import { createNodeFileSystem } from ${JSON.stringify(nodeFileSystemUrl)};
			const store = createCodingPluginInstallationStore({
				root: process.env.CODA_TEST_PLUGIN_STORE_ROOT,
				fileSystem: createNodeFileSystem(),
				idGenerator: { generate: () => "child-process" },
			});
			await store.retainRevisions([process.env.CODA_TEST_PLUGIN_REVISION]);
		`;
		await executeFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
			cwd: new URL("../../../..", import.meta.url),
			env: {
				...process.env,
				CODA_TEST_PLUGIN_STORE_ROOT: storeRoot,
				CODA_TEST_PLUGIN_REVISION: installed.selectedRoot,
			},
		});

		await store.remove(installed.pluginId);
		await store.collectRetiredRevisions();

		await expect(lstat(installed.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not clean a cache when atomic removal state publication fails", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const packageRoot = await writePlugin(await temporaryDirectory());
		const base = createNodeFileSystem();
		const original = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: base,
			idGenerator: new TestIds(),
		});
		const installed = await original.install({ entry: marketplaceEntry(), packageRoot });
		const failing = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					if (to.endsWith(`${sep}installations.v1.json`)) throw new Error("simulated remove state failure");
					await base.rename(from, to);
				},
			},
			idGenerator: new TestIds(),
		});

		await expect(failing.remove(installed.pluginId)).rejects.toThrow(/simulated remove state failure/u);

		expect((await original.list()).installations).toEqual([installed]);
		expect((await lstat(installed.selectedRoot)).isDirectory()).toBe(true);
	});

	it("fails closed without replacing a corrupt versioned state file", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		await mkdir(storeRoot, { recursive: true });
		const statePath = join(await realpath(storeRoot), "installations.v1.json");
		const corruptState = '{"version":2,"installations":[]}\n';
		await writeFile(statePath, corruptState);
		const packageRoot = await writePlugin(await temporaryDirectory());
		const store = await createStore(storeRoot);

		await expect(store.list()).rejects.toThrow(/corrupt Plugin installation state/u);
		await expect(store.install({ entry: marketplaceEntry(), packageRoot })).rejects.toThrow(
			/corrupt Plugin installation state/u,
		);
		await expect(store.remove("review-tools@team-market")).rejects.toThrow(/corrupt Plugin installation state/u);
		expect(await readFile(statePath, "utf8")).toBe(corruptState);
	});

	it("serializes overlapping installation operations and returns immutable snapshots", async () => {
		const firstRoot = await realpath(
			await writePlugin(await temporaryDirectory(), { version: "1.0.0", body: "first" }),
		);
		const secondRoot = await realpath(
			await writePlugin(await temporaryDirectory(), { version: "2.0.0", body: "second" }),
		);
		const base = createNodeFileSystem();
		let releaseFirst!: () => void;
		let reportFirstRead!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			reportFirstRead = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let blocked = false;
		let secondReads = 0;
		const store = createCodingPluginInstallationStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (path.startsWith(firstRoot) && !blocked) {
						blocked = true;
						reportFirstRead();
						await firstGate;
					}
					if (path.startsWith(secondRoot)) secondReads++;
					return base.readFile(path);
				},
			},
			idGenerator: new TestIds(),
		});

		const first = store.install({ entry: marketplaceEntry(), packageRoot: firstRoot });
		await firstRead;
		const second = store.install({ entry: marketplaceEntry(), packageRoot: secondRoot });
		await Promise.resolve();
		expect(secondReads).toBe(0);
		releaseFirst();
		await first;
		const selected = await second;
		const snapshot = await store.list();

		expect(snapshot.installations).toEqual([selected]);
		expect(Object.isFrozen(snapshot.installations[0]?.source)).toBe(true);
	});

	it("serializes installation state updates across Store instances without losing either Plugin", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		await mkdir(storeRoot, { recursive: true });
		const statePath = join(await realpath(storeRoot), "installations.v1.json");
		await writeFile(statePath, '{"version":1,"installations":[]}\n');
		const alphaRoot = await writePlugin(await temporaryDirectory(), { name: "alpha-tools" });
		const betaRoot = await writePlugin(await temporaryDirectory(), { name: "beta-tools" });
		const base = createNodeFileSystem();
		let reportFirstRead!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			reportFirstRead = resolve;
		});
		let reportSecondWrite!: () => void;
		const secondWrite = new Promise<void>((resolve) => {
			reportSecondWrite = resolve;
		});
		let delayed = false;
		const firstStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readFile: async (path) => {
					const bytes = await base.readFile(path);
					if (path === statePath && !delayed) {
						delayed = true;
						reportFirstRead();
						await Promise.race([secondWrite, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
					}
					return bytes;
				},
			},
			idGenerator: new TestIds(),
		});
		const secondStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					await base.rename(from, to);
					if (to === statePath) reportSecondWrite();
				},
			},
			idGenerator: new TestIds(),
		});

		const firstInstall = firstStore.install({
			entry: marketplaceEntry("alpha-tools"),
			packageRoot: alphaRoot,
		});
		await firstRead;
		const secondInstall = secondStore.install({
			entry: marketplaceEntry("beta-tools"),
			packageRoot: betaRoot,
		});
		await Promise.all([firstInstall, secondInstall]);

		expect((await firstStore.list()).installations.map(({ pluginId }) => pluginId)).toEqual([
			"alpha-tools@team-market",
			"beta-tools@team-market",
		]);
	});

	it("does not let a Store that observed an exited mutex owner replace a newer Store owner", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		await mkdir(storeRoot, { recursive: true });
		const canonicalRoot = await realpath(storeRoot);
		const lockPath = join(canonicalRoot, "installations.v1.lock");
		await writeFile(
			lockPath,
			`${JSON.stringify({ version: 1, token: "exited-owner", pid: 2_147_483_647, acquiredAt: 1 })}\n`,
		);
		const alphaRoot = await realpath(await writePlugin(await temporaryDirectory(), { name: "alpha-tools" }));
		const betaRoot = await realpath(await writePlugin(await temporaryDirectory(), { name: "beta-tools" }));
		const base = createNodeFileSystem();
		let reportStaleRead!: () => void;
		const staleRead = new Promise<void>((resolve) => {
			reportStaleRead = resolve;
		});
		let releaseStaleRead!: () => void;
		const staleReadGate = new Promise<void>((resolve) => {
			releaseStaleRead = resolve;
		});
		let reportCurrentOwnerRead!: () => void;
		const currentOwnerRead = new Promise<void>((resolve) => {
			reportCurrentOwnerRead = resolve;
		});
		let reportAlphaOperation!: () => void;
		const alphaOperation = new Promise<void>((resolve) => {
			reportAlphaOperation = resolve;
		});
		let reportBetaOperation!: () => void;
		const betaOperation = new Promise<void>((resolve) => {
			reportBetaOperation = resolve;
		});
		let releaseBetaOperation!: () => void;
		const betaOperationGate = new Promise<void>((resolve) => {
			releaseBetaOperation = resolve;
		});
		let lockReads = 0;
		let betaBlocked = false;
		const staleObserverStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readFile: async (path) => {
					const bytes = await base.readFile(path);
					if (path === lockPath) {
						lockReads++;
						if (lockReads === 1) {
							reportStaleRead();
							await staleReadGate;
						} else {
							reportCurrentOwnerRead();
						}
					}
					if (path.startsWith(alphaRoot)) reportAlphaOperation();
					return bytes;
				},
			},
			idGenerator: { generate: () => "alpha-operation" },
		});
		const newerOwnerStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readFile: async (path) => {
					const bytes = await base.readFile(path);
					if (path.startsWith(betaRoot) && !betaBlocked) {
						betaBlocked = true;
						reportBetaOperation();
						await betaOperationGate;
					}
					return bytes;
				},
			},
			idGenerator: { generate: () => "beta-operation" },
		});

		const alphaInstallation = staleObserverStore.install({
			entry: marketplaceEntry("alpha-tools"),
			packageRoot: alphaRoot,
		});
		await staleRead;
		const betaInstallation = newerOwnerStore.install({
			entry: marketplaceEntry("beta-tools"),
			packageRoot: betaRoot,
		});
		await betaOperation;
		releaseStaleRead();
		const firstProgress = await Promise.race([
			alphaOperation.then(() => "entered-operation" as const),
			currentOwnerRead.then(() => "observed-current-owner" as const),
		]);
		releaseBetaOperation();
		await Promise.all([alphaInstallation, betaInstallation]);

		expect(firstProgress).toBe("observed-current-owner");
		expect((await staleObserverStore.list()).installations.map(({ pluginId }) => pluginId)).toEqual([
			"alpha-tools@team-market",
			"beta-tools@team-market",
		]);
	});

	it("serializes removal with another Store's installation state update", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const alphaRoot = await writePlugin(await temporaryDirectory(), { name: "alpha-tools" });
		const betaRoot = await writePlugin(await temporaryDirectory(), { name: "beta-tools" });
		const gammaRoot = await writePlugin(await temporaryDirectory(), { name: "gamma-tools" });
		const base = createNodeFileSystem();
		const initialStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: base,
			idGenerator: new TestIds(),
		});
		const alpha = await initialStore.install({
			entry: marketplaceEntry("alpha-tools"),
			packageRoot: alphaRoot,
		});
		await initialStore.install({ entry: marketplaceEntry("beta-tools"), packageRoot: betaRoot });
		const statePath = join(await realpath(storeRoot), "installations.v1.json");
		let reportFirstRead!: () => void;
		const firstRead = new Promise<void>((resolve) => {
			reportFirstRead = resolve;
		});
		let reportSecondWrite!: () => void;
		const secondWrite = new Promise<void>((resolve) => {
			reportSecondWrite = resolve;
		});
		let delayed = false;
		const removingStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				readFile: async (path) => {
					const bytes = await base.readFile(path);
					if (path === statePath && !delayed) {
						delayed = true;
						reportFirstRead();
						await Promise.race([secondWrite, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
					}
					return bytes;
				},
			},
			idGenerator: new TestIds(),
		});
		const installingStore = createCodingPluginInstallationStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					await base.rename(from, to);
					if (to === statePath) reportSecondWrite();
				},
			},
			idGenerator: new TestIds(),
		});

		const removal = removingStore.remove(alpha.pluginId);
		await firstRead;
		const installation = installingStore.install({
			entry: marketplaceEntry("gamma-tools"),
			packageRoot: gammaRoot,
		});
		await Promise.all([removal, installation]);

		expect((await initialStore.list()).installations.map(({ pluginId }) => pluginId)).toEqual([
			"beta-tools@team-market",
			"gamma-tools@team-market",
		]);
	});
});
