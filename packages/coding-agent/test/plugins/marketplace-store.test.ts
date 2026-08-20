import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { AGENT_PLUGIN_SCHEMA } from "@coda/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../../src/host/process-runner.ts";
import { createCodingPluginMarketplaceStore } from "../../src/plugins/marketplace-store.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugin-marketplace-store-"));
	temporaryDirectories.push(directory);
	return directory;
}

class TestIds implements IdGenerator {
	#next = 0;

	generate(): string {
		return `test-${++this.#next}`;
	}
}

const unexpectedProcessRunner: ProcessRunner = {
	run: async () => Promise.reject(new Error("local Marketplace sources must not run a process")),
};

async function writeMarketplace(
	root: string,
	name: string,
	pluginName = "review-tools",
	version = "1.0.0",
): Promise<void> {
	const marketplaceRoot = join(root, ".agents", "plugins");
	const packageRoot = join(marketplaceRoot, "packages", pluginName);
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "plugin.json"),
		JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: pluginName, version }),
	);
	await writeFile(
		join(marketplaceRoot, "marketplace.json"),
		JSON.stringify({ name, plugins: [{ name: pluginName, source: `./packages/${pluginName}` }] }),
	);
}

function processResult(stdout = "", exitCode = 0, stderr = ""): ProcessRunResult {
	return {
		exitCode,
		signal: null,
		stdout,
		stderr,
		timedOut: false,
		truncated: false,
	};
}

class FakeGitRunner implements ProcessRunner {
	readonly requests: ProcessRunRequest[] = [];
	readonly #checkouts: { readonly fixture: string; readonly revision: string }[];
	readonly #revisionByRoot = new Map<string, string>();

	constructor(checkouts: readonly { readonly fixture: string; readonly revision: string }[]) {
		this.#checkouts = [...checkouts];
	}

	async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
		this.requests.push(request);
		if (request.executable !== "git") return processResult("", 127, "unexpected executable");
		if (request.args[0] === "clone") {
			const checkout = this.#checkouts.shift();
			if (!checkout) return processResult("", 1, "no configured checkout");
			const destination = request.args.at(-1);
			if (!destination) return processResult("", 1, "missing destination");
			await cp(checkout.fixture, destination, { recursive: true, verbatimSymlinks: true });
			this.#revisionByRoot.set(destination, checkout.revision);
			return processResult();
		}
		if (request.args[2] === "rev-parse") {
			const root = request.args[1];
			const revision = root ? this.#revisionByRoot.get(root) : undefined;
			return revision ? processResult(`${revision}\n`) : processResult("", 1, "unknown checkout");
		}
		return processResult();
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin Marketplace store", () => {
	it("adds, catalogs, and removes one canonical local Marketplace source", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot, "team-market");
		const storeRoot = join(await temporaryDirectory(), "store");
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: { PATH: "/usr/bin" },
		});

		const added = await store.add({ source: "local", root: sourceRoot });
		const canonicalSourceRoot = await realpath(sourceRoot);

		expect(added).toEqual({
			name: "team-market",
			source: { source: "local", root: canonicalSourceRoot },
			root: canonicalSourceRoot,
		});
		expect(await store.list()).toEqual({ version: 1, marketplaces: [added] });
		expect(JSON.parse(await readFile(join(await realpath(storeRoot), "marketplaces.v1.json"), "utf8"))).toEqual({
			version: 1,
			marketplaces: [added],
		});

		const catalog = await store.catalog();
		expect(catalog).toMatchObject({
			version: 1,
			entries: [{ pluginId: "review-tools@team-market", name: "review-tools", marketplace: "team-market" }],
			diagnostics: [],
		});
		expect(catalog.marketplaces).toHaveLength(1);
		expect(catalog.marketplaces[0]).toMatchObject({ status: "loaded", name: "team-market" });

		await store.remove("team-market");
		expect(await store.list()).toEqual({ version: 1, marketplaces: [] });
		expect(await store.catalog()).toEqual({ version: 1, marketplaces: [], entries: [], diagnostics: [] });
	});

	it("stages and atomically upgrades a Git Marketplace by immutable HEAD revision", async () => {
		const firstFixture = await temporaryDirectory();
		const secondFixture = await temporaryDirectory();
		await writeMarketplace(firstFixture, "remote-market", "review-tools", "1.0.0");
		await writeMarketplace(secondFixture, "remote-market", "review-tools", "2.0.0");
		const firstRevision = "1".repeat(40);
		const secondRevision = "2".repeat(40);
		const processRunner = new FakeGitRunner([
			{ fixture: firstFixture, revision: firstRevision },
			{ fixture: secondFixture, revision: secondRevision },
		]);
		const storeRoot = join(await temporaryDirectory(), "store");
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner,
			idGenerator: new TestIds(),
			environment: { PATH: "/opt/git/bin" },
		});
		const source = {
			source: "git" as const,
			url: "https://example.test/team-market.git",
			ref: "release/v1",
			sparse: [".agents/plugins", "docs/*.md"],
		};

		const first = await store.add(source);
		const canonicalStoreRoot = await realpath(storeRoot);
		expect(first).toMatchObject({
			name: "remote-market",
			source,
			revision: firstRevision,
			digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		const [cacheNamespace, sourceNamespace, cachedRevision, cachedDigest] = relative(
			join(canonicalStoreRoot, "cache"),
			first.root,
		).split(sep);
		expect(cacheNamespace).toMatch(/^[a-f0-9]{64}$/u);
		expect(sourceNamespace).toMatch(/^[a-f0-9]{64}$/u);
		expect(cachedRevision).toBe(firstRevision);
		expect(cachedDigest).toBe(first.digest);
		expect(
			JSON.parse(
				await readFile(join(first.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"), "utf8"),
			),
		).toMatchObject({ version: "1.0.0" });

		const second = await store.upgrade("remote-market");
		expect(second).toMatchObject({
			name: first.name,
			source: first.source,
			revision: secondRevision,
			digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(relative(join(canonicalStoreRoot, "cache"), second.root).split(sep)).toEqual([
			cacheNamespace,
			sourceNamespace,
			secondRevision,
			second.digest,
		]);
		expect(second.digest).not.toBe(first.digest);
		expect((await store.list()).marketplaces).toEqual([second]);
		expect(
			JSON.parse(
				await readFile(join(second.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"), "utf8"),
			),
		).toMatchObject({ version: "2.0.0" });
		expect(
			JSON.parse(
				await readFile(join(first.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"), "utf8"),
			),
		).toMatchObject({ version: "1.0.0" });
		await store.remove("remote-market");
		expect((await store.list()).marketplaces).toEqual([]);
		expect(
			JSON.parse(
				await readFile(join(second.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"), "utf8"),
			),
		).toMatchObject({ version: "2.0.0" });

		const sparseRequests = processRunner.requests.filter(({ args }) => args[2] === "sparse-checkout");
		expect(sparseRequests.map(({ args }) => args.slice(2))).toEqual([
			["sparse-checkout", "init", "--no-cone"],
			["sparse-checkout", "set", "--no-cone", "--", ".agents/plugins", "docs/*.md"],
			["sparse-checkout", "init", "--no-cone"],
			["sparse-checkout", "set", "--no-cone", "--", ".agents/plugins", "docs/*.md"],
		]);
		expect(
			processRunner.requests.filter(({ args }) => args[0] === "clone").map(({ args }) => args.slice(0, -1)),
		).toEqual([
			["clone", "--no-checkout", "--filter=blob:none", "--", source.url],
			["clone", "--no-checkout", "--filter=blob:none", "--", source.url],
		]);
		expect(
			processRunner.requests.filter(({ args }) => args[2] === "checkout").map(({ args }) => args.slice(2)),
		).toEqual([
			["checkout", "--detach", "release/v1", "--"],
			["checkout", "--detach", "release/v1", "--"],
		]);
		expect(processRunner.requests.every(({ executable }) => executable === "git")).toBe(true);
		expect(processRunner.requests.every(({ environment }) => environment.PATH === "/opt/git/bin")).toBe(true);
	});

	it("re-adds the same Git revision with another sparse selection without reusing stale content", async () => {
		const firstFixture = await temporaryDirectory();
		const secondFixture = await temporaryDirectory();
		await writeMarketplace(firstFixture, "remote-market");
		await writeMarketplace(secondFixture, "remote-market");
		await mkdir(join(firstFixture, "selection-a"));
		await mkdir(join(secondFixture, "selection-b"));
		await writeFile(join(firstFixture, "selection-a", "notes.txt"), "first sparse tree\n");
		await writeFile(join(secondFixture, "selection-b", "notes.txt"), "second sparse tree\n");
		const revision = "8".repeat(40);
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([
				{ fixture: firstFixture, revision },
				{ fixture: secondFixture, revision },
			]),
			idGenerator: new TestIds(),
			environment: {},
		});

		const first = await store.add({
			source: "git",
			url: "https://example.test/remote.git",
			sparse: [".agents/plugins", "selection-a"],
		});
		await store.remove("remote-market");
		const second = await store.add({
			source: "git",
			url: "https://example.test/remote.git",
			sparse: [".agents/plugins", "selection-b"],
		});

		expect(first.revision).toBe(revision);
		expect(second.revision).toBe(revision);
		expect(second.root).not.toBe(first.root);
		expect(second.digest).not.toBe(first.digest);
		expect(await readFile(join(first.root, "selection-a", "notes.txt"), "utf8")).toBe("first sparse tree\n");
		expect(await readFile(join(second.root, "selection-b", "notes.txt"), "utf8")).toBe("second sparse tree\n");
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["review-tools@remote-market"]);
	});

	it("keeps exact sparse selections independent when they resolve to the same protocol tree", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const revision = "c".repeat(40);
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([
				{ fixture, revision },
				{ fixture, revision },
			]),
			idGenerator: new TestIds(),
			environment: {},
		});

		const first = await store.add({
			source: "git",
			url: "https://example.test/remote.git",
			sparse: [".agents/plugins", "docs/a"],
		});
		await store.remove("remote-market");
		const second = await store.add({
			source: "git",
			url: "https://example.test/remote.git",
			sparse: [".agents/plugins", "docs/b"],
		});

		expect(second.digest).toBe(first.digest);
		expect(second.root).not.toBe(first.root);
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["review-tools@remote-market"]);
	});

	it("keeps one cache identity when identical content moves through another staging location", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const revision = "d".repeat(40);
		const source = { source: "git" as const, url: "https://example.test/remote.git" };
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([
				{ fixture, revision },
				{ fixture, revision },
			]),
			idGenerator: new TestIds(),
			environment: {},
		});

		const first = await store.add(source);
		await store.remove("remote-market");
		const second = await store.add(source);

		expect(second.digest).toBe(first.digest);
		expect(second.root).toBe(first.root);
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["review-tools@remote-market"]);
	});

	it("restores and upgrades a content-addressed Git Marketplace after restart", async () => {
		const firstFixture = await temporaryDirectory();
		const secondFixture = await temporaryDirectory();
		await writeMarketplace(firstFixture, "remote-market", "review-tools", "1.0.0");
		await writeMarketplace(secondFixture, "remote-market", "review-tools", "2.0.0");
		const firstRevision = "9".repeat(40);
		const secondRevision = "a".repeat(40);
		const storeRoot = join(await temporaryDirectory(), "store");
		const source = { source: "git" as const, url: "https://example.test/remote.git", ref: "stable" };
		const initial = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture: firstFixture, revision: firstRevision }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await initial.add(source);

		const restarted = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture: secondFixture, revision: secondRevision }]),
			idGenerator: new TestIds(),
			environment: {},
		});

		expect((await restarted.list()).marketplaces).toEqual([selected]);
		expect((await restarted.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual([
			"review-tools@remote-market",
		]);
		const upgraded = await restarted.upgrade("remote-market");
		expect(upgraded.revision).toBe(secondRevision);
		expect(upgraded.root).not.toBe(selected.root);
		expect(
			JSON.parse(
				await readFile(
					join(upgraded.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"),
					"utf8",
				),
			),
		).toMatchObject({ version: "2.0.0" });
		expect((await restarted.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual([
			"review-tools@remote-market",
		]);
	});

	it("rejects legacy revision-only cache state and an exact-source mismatch", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const revision = "b".repeat(40);
		const storeRoot = join(await temporaryDirectory(), "store");
		const source = {
			source: "git" as const,
			url: "https://example.test/remote.git",
			sparse: [".agents/plugins", "docs/a"],
		};
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add(source);
		const canonicalStoreRoot = await realpath(storeRoot);
		const statePath = join(canonicalStoreRoot, "marketplaces.v1.json");
		const legacyRoot = join(
			canonicalStoreRoot,
			"cache",
			"8617fdb8b9807040d714ba68a66c5b73f57edc54f7dd146faa206fc53590674f",
			revision,
		);
		await cp(selected.root, legacyRoot, { recursive: true, verbatimSymlinks: true });
		await writeFile(
			statePath,
			`${JSON.stringify({ version: 1, marketplaces: [{ ...selected, root: legacyRoot }] })}\n`,
		);
		const restartedFromLegacy = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(restartedFromLegacy.list()).rejects.toThrow(/content-addressed cache identity/u);

		await writeFile(
			statePath,
			`${JSON.stringify({
				version: 1,
				marketplaces: [{ ...selected, source: { ...source, sparse: [".agents/plugins", "docs/b"] } }],
			})}\n`,
		);
		const restartedWithChangedSource = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(restartedWithChangedSource.list()).rejects.toThrow(/content-addressed cache identity/u);

		await writeFile(
			statePath,
			`${JSON.stringify({
				version: 1,
				marketplaces: [{ ...selected, digest: "f".repeat(64) }],
			})}\n`,
		);
		const restartedWithChangedDigest = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(restartedWithChangedDigest.list()).rejects.toThrow(/content-addressed cache identity/u);
	});

	it("accepts internal Git Marketplace symlinks and revalidates their containment from cache", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "linked-market");
		await mkdir(join(fixture, "shared"));
		await writeFile(join(fixture, "shared", "notes.txt"), "portable linked notes\n");
		await symlink("shared", join(fixture, "linked-directory"), "dir");
		await symlink("shared/notes.txt", join(fixture, "linked-file"), "file");
		const outside = join(await temporaryDirectory(), "outside.txt");
		await writeFile(outside, "must not load\n");
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision: "a".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});

		const selected = await store.add({ source: "git", url: "https://example.test/linked.git" });
		expect(await readFile(join(selected.root, "linked-file"), "utf8")).toBe("portable linked notes\n");
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["review-tools@linked-market"]);

		await rm(join(selected.root, "linked-file"));
		await symlink(outside, join(selected.root, "linked-file"), "file");
		const rejected = await store.catalog();
		expect(rejected.entries).toEqual([]);
		expect(rejected.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-marketplace-store-integrity-invalid" }),
		);
	});

	it("rejects a symbolic-link cycle in a staged Git Marketplace", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "cycle-market");
		await symlink(".", join(fixture, "cycle"), "dir");
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision: "b".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/cycle.git" })).rejects.toThrow(/cycle/u);
		expect((await store.list()).marketplaces).toEqual([]);
	});

	it("never probes a canonical .codex-plugin target of a staged Marketplace symlink", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "reserved-link-market");
		await mkdir(join(fixture, ".codex-plugin"));
		await writeFile(join(fixture, ".codex-plugin", "secret.txt"), "must not be read\n");
		await symlink(".codex-plugin", join(fixture, "portable-looking"), "dir");
		const base = createNodeFileSystem();
		let reservedProbes = 0;
		const forbidden = (path: string): boolean =>
			path.split(sep).includes(".codex-plugin") || path.includes(`${sep}.codex-plugin${sep}`);
		const rejectReserved = (path: string): never => {
			reservedProbes++;
			throw new Error(`reserved staged target was probed: ${path}`);
		};
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...base,
				realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
				lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
				stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
				readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
				readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
			},
			processRunner: new FakeGitRunner([{ fixture, revision: "c".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/reserved.git" })).rejects.toThrow(
			/\.codex-plugin/u,
		);
		expect(reservedProbes).toBe(0);
		expect((await store.list()).marketplaces).toEqual([]);
	});

	it("rejects a symlink-swapped Git Marketplace cache before reading its external target", async () => {
		const fixture = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		await writeMarketplace(outside, "remote-market", "outside-tools", "9.9.9");
		const storeRoot = join(await temporaryDirectory(), "store");
		const base = createNodeFileSystem();
		let selectedRoot: string | undefined;
		let forbiddenProbes = 0;
		const forbidden = (path: string): boolean =>
			path === outside ||
			path.startsWith(`${outside}${sep}`) ||
			(selectedRoot !== undefined && (path === selectedRoot || path.startsWith(`${selectedRoot}${sep}`)));
		const rejectProbe = (path: string): never => {
			forbiddenProbes++;
			throw new Error(`External Marketplace cache was probed: ${path}`);
		};
		const fileSystem = {
			...base,
			realpath: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.realpath(path)),
			stat: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.stat(path)),
			readDirectory: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.readDirectory(path)),
			readFile: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.readFile(path)),
		};
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem,
			processRunner: new FakeGitRunner([{ fixture, revision: "3".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "https://example.test/remote.git" });
		selectedRoot = selected.root;
		await rm(selected.root, { recursive: true, force: true });
		await symlink(outside, selected.root, "dir");

		const catalog = await store.catalog();

		expect(forbiddenProbes).toBe(0);
		expect(catalog.entries).toEqual([]);
		expect(catalog.marketplaces).toEqual([expect.objectContaining({ status: "rejected", root: selected.root })]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-store-integrity-invalid",
				marketplace: "remote-market",
			}),
		);
		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("rejects modified Git Marketplace cache content while retaining its durable selection", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision: "4".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "https://example.test/remote.git" });
		expect(selected.digest).toMatch(/^[a-f0-9]{64}$/u);
		await writeFile(
			join(selected.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", version: "9.9.9" }),
		);

		const catalog = await store.catalog();

		expect(catalog.entries).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-store-integrity-invalid",
				message: expect.stringContaining("digest"),
			}),
		);
		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("rejects an exact directory mode mutation in a Git Marketplace cache", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const packageRoot = join(fixture, ".agents", "plugins", "packages", "review-tools");
		await chmod(packageRoot, 0o755);
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision: "5".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "https://example.test/remote.git" });
		await chmod(join(selected.root, ".agents", "plugins", "packages", "review-tools"), 0o700);

		const catalog = await store.catalog();

		expect(catalog.entries).toEqual([]);
		expect(catalog.marketplaces).toEqual([expect.objectContaining({ status: "rejected", root: selected.root })]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-store-integrity-invalid",
				message: expect.stringContaining("digest"),
			}),
		);
		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("rejects an exact file mode mutation in a Git Marketplace cache", async () => {
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		const manifestPath = join(fixture, ".agents", "plugins", "packages", "review-tools", "plugin.json");
		await chmod(manifestPath, 0o644);
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([{ fixture, revision: "6".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "https://example.test/remote.git" });
		await chmod(join(selected.root, ".agents", "plugins", "packages", "review-tools", "plugin.json"), 0o600);

		const catalog = await store.catalog();

		expect(catalog.entries).toEqual([]);
		expect(catalog.marketplaces).toEqual([expect.objectContaining({ status: "rejected", root: selected.root })]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-store-integrity-invalid",
				message: expect.stringContaining("digest"),
			}),
		);
		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("retains the selected Git revision when a fresh upgrade declares another Marketplace name", async () => {
		const firstFixture = await temporaryDirectory();
		const invalidUpgrade = await temporaryDirectory();
		await writeMarketplace(firstFixture, "remote-market");
		await writeMarketplace(invalidUpgrade, "other-market");
		const processRunner = new FakeGitRunner([
			{ fixture: firstFixture, revision: "a".repeat(40) },
			{ fixture: invalidUpgrade, revision: "b".repeat(40) },
		]);
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner,
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "ssh://git@example.test/team.git" });

		await expect(store.upgrade("remote-market")).rejects.toThrow(/declared "other-market" instead/u);

		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("does not configure a Git Marketplace when clone fails", async () => {
		const processRunner: ProcessRunner = {
			run: async () => processResult("", 128, "repository unavailable"),
		};
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/missing.git" })).rejects.toThrow(
			/clone failed: repository unavailable/u,
		);

		expect(await store.list()).toEqual({ version: 1, marketplaces: [] });
	});

	it("retains the selected Git revision when the atomic state rename fails", async () => {
		const firstFixture = await temporaryDirectory();
		const secondFixture = await temporaryDirectory();
		await writeMarketplace(firstFixture, "remote-market", "review-tools", "1.0.0");
		await writeMarketplace(secondFixture, "remote-market", "review-tools", "2.0.0");
		const processRunner = new FakeGitRunner([
			{ fixture: firstFixture, revision: "c".repeat(40) },
			{ fixture: secondFixture, revision: "d".repeat(40) },
		]);
		const baseFileSystem = createNodeFileSystem();
		let failStateRename = false;
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (failStateRename && to.endsWith("marketplaces.v1.json")) {
						throw new Error("simulated state rename failure");
					}
					await baseFileSystem.rename(from, to);
				},
			},
			processRunner,
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "git", url: "https://example.test/team.git" });
		failStateRename = true;

		await expect(store.upgrade("remote-market")).rejects.toThrow(/simulated state rename failure/u);

		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("rejects unsupported or option-injecting sources before running Git", async () => {
		let processRuns = 0;
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					processRuns++;
					return processResult();
				},
			},
			idGenerator: new TestIds(),
			environment: {},
		});
		const cases: readonly [input: unknown, expected: RegExp][] = [
			[{ source: "npm", package: "review-tools" }, /unsupported.*npm/iu],
			[{ source: "git", url: "file:///tmp/repository" }, /URL is invalid/u],
			[{ source: "git", url: "ssh://-oProxyCommand%3Dmalicious@example.test/team.git" }, /URL is invalid/u],
			[{ source: "git", url: "https://example.test/team.git", ref: "--upload-pack=malicious" }, /ref is invalid/u],
			[{ source: "git", url: "https://example.test/team.git", sparse: ["../outside"] }, /sparse path is invalid/u],
			[{ source: "git", url: "https://example.test/team.git", sparse: ["--help"] }, /sparse path is invalid/u],
			[
				{ source: "git", url: "https://example.test/team.git", sparse: ["docs\noutside"] },
				/sparse path is invalid/u,
			],
		];

		for (const [input, expected] of cases) {
			await expect(store.add(input as never)).rejects.toThrow(expected);
		}

		expect(processRuns).toBe(0);
		expect(await store.list()).toEqual({ version: 1, marketplaces: [] });
	});

	it("serializes concurrent additions without losing either Marketplace", async () => {
		const alphaRoot = await temporaryDirectory();
		const betaRoot = await temporaryDirectory();
		await writeMarketplace(alphaRoot, "alpha-market", "alpha-tools");
		await writeMarketplace(betaRoot, "beta-market", "beta-tools");
		const baseFileSystem = createNodeFileSystem();
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...baseFileSystem,
				rename: async (from, to) => {
					if (to.endsWith("marketplaces.v1.json")) {
						await new Promise<void>((resolve) => setTimeout(resolve, 10));
					}
					await baseFileSystem.rename(from, to);
				},
			},
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await Promise.all([
			store.add({ source: "local", root: betaRoot }),
			store.add({ source: "local", root: alphaRoot }),
		]);

		expect((await store.list()).marketplaces.map(({ name }) => name)).toEqual(["alpha-market", "beta-market"]);
	});

	it("serializes state updates across Marketplace Store instances without losing either source", async () => {
		const alphaRoot = await temporaryDirectory();
		const betaRoot = await temporaryDirectory();
		await writeMarketplace(alphaRoot, "alpha-market", "alpha-tools");
		await writeMarketplace(betaRoot, "beta-market", "beta-tools");
		const storeRoot = join(await temporaryDirectory(), "store");
		await mkdir(storeRoot, { recursive: true });
		const statePath = join(await realpath(storeRoot), "marketplaces.v1.json");
		await writeFile(statePath, '{"version":1,"marketplaces":[]}\n');
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
		const firstStore = createCodingPluginMarketplaceStore({
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
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});
		const secondStore = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: {
				...base,
				rename: async (from, to) => {
					await base.rename(from, to);
					if (to === statePath) reportSecondWrite();
				},
			},
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		const firstAddition = firstStore.add({ source: "local", root: alphaRoot });
		await firstRead;
		const secondAddition = secondStore.add({ source: "local", root: betaRoot });
		await Promise.all([firstAddition, secondAddition]);

		expect((await firstStore.list()).marketplaces.map(({ name }) => name)).toEqual(["alpha-market", "beta-market"]);
	});

	it("keeps case-distinct Git Marketplace names in independent lowercase cache namespaces", async () => {
		const upperFixture = await temporaryDirectory();
		const lowerFixture = await temporaryDirectory();
		await writeMarketplace(upperFixture, "Team", "alpha-tools");
		await writeMarketplace(lowerFixture, "team", "beta-tools");
		const revision = "7".repeat(40);
		const storeRoot = join(await temporaryDirectory(), "store");
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: new FakeGitRunner([
				{ fixture: upperFixture, revision },
				{ fixture: lowerFixture, revision },
			]),
			idGenerator: new TestIds(),
			environment: {},
		});

		const upper = await store.add({ source: "git", url: "https://example.test/upper.git" });
		const lower = await store.add({ source: "git", url: "https://example.test/lower.git" });
		const cacheRoot = join(await realpath(storeRoot), "cache");
		const upperNamespace = relative(cacheRoot, upper.root).split(sep)[0];
		const lowerNamespace = relative(cacheRoot, lower.root).split(sep)[0];

		expect(upperNamespace).toMatch(/^[a-f0-9]{64}$/u);
		expect(lowerNamespace).toMatch(/^[a-f0-9]{64}$/u);
		expect(upperNamespace).not.toBe(lowerNamespace);
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual([
			"alpha-tools@Team",
			"beta-tools@team",
		]);

		await store.remove("Team");

		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["beta-tools@team"]);
		expect((await store.list()).marketplaces).toEqual([lower]);
	});

	it("fails closed on corrupt versioned state without overwriting it", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		await mkdir(storeRoot);
		const statePath = join(storeRoot, "marketplaces.v1.json");
		const corruptState = '{"version":2,"marketplaces":[]}\n';
		await writeFile(statePath, corruptState);
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot, "team-market");
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.list()).rejects.toThrow(/state is invalid/u);
		await expect(store.add({ source: "local", root: sourceRoot })).rejects.toThrow(/state is invalid/u);

		expect(await readFile(statePath, "utf8")).toBe(corruptState);
	});

	it.each(["workspace-local", "user-local"])(
		"rejects the reserved %s Marketplace on add and after a state-file restart",
		async (name) => {
			const sourceRoot = await temporaryDirectory();
			await writeMarketplace(sourceRoot, name);
			const storeRoot = join(await temporaryDirectory(), "store");
			const store = createCodingPluginMarketplaceStore({
				root: storeRoot,
				fileSystem: createNodeFileSystem(),
				processRunner: unexpectedProcessRunner,
				idGenerator: new TestIds(),
				environment: {},
			});

			await expect(store.add({ source: "local", root: sourceRoot })).rejects.toThrow(/reserved/u);
			await mkdir(storeRoot, { recursive: true });
			const statePath = join(storeRoot, "marketplaces.v1.json");
			const corruptState = `${JSON.stringify({
				version: 1,
				marketplaces: [{ name, source: { source: "local", root: sourceRoot }, root: sourceRoot }],
			})}\n`;
			await writeFile(statePath, corruptState);
			const restarted = createCodingPluginMarketplaceStore({
				root: storeRoot,
				fileSystem: createNodeFileSystem(),
				processRunner: unexpectedProcessRunner,
				idGenerator: new TestIds(),
				environment: {},
			});

			await expect(restarted.list()).rejects.toThrow(/reserved/u);
			expect(await readFile(statePath, "utf8")).toBe(corruptState);
		},
	);

	it("rejects duplicate Marketplace names and duplicate canonical sources", async () => {
		const firstRoot = await temporaryDirectory();
		const secondRoot = await temporaryDirectory();
		await writeMarketplace(firstRoot, "team-market");
		await writeMarketplace(secondRoot, "team-market", "other-tools");
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});
		const selected = await store.add({ source: "local", root: firstRoot });

		await expect(store.add({ source: "local", root: firstRoot })).rejects.toThrow(/source is already configured/u);
		await expect(store.add({ source: "local", root: secondRoot })).rejects.toThrow(
			/Marketplace "team-market" is already configured/u,
		);

		expect((await store.list()).marketplaces).toEqual([selected]);
	});

	it("isolates a broken selected Marketplace while cataloging healthy siblings", async () => {
		const brokenRoot = await temporaryDirectory();
		const healthyRoot = await temporaryDirectory();
		await writeMarketplace(brokenRoot, "broken-market", "broken-tools");
		await writeMarketplace(healthyRoot, "healthy-market", "healthy-tools");
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});
		await store.add({ source: "local", root: brokenRoot });
		await store.add({ source: "local", root: healthyRoot });
		await writeFile(join(brokenRoot, ".agents", "plugins", "marketplace.json"), "not JSON");

		const catalog = await store.catalog();

		expect(catalog.marketplaces.map(({ status }) => status)).toEqual(["rejected", "loaded"]);
		expect(catalog.entries.map(({ pluginId }) => pluginId)).toEqual(["healthy-tools@healthy-market"]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-marketplace-manifest-unreadable", severity: "error" }),
		);
	});

	it("rejects local and staged symlink escapes without selecting either source", async () => {
		const localRoot = await temporaryDirectory();
		const outsideMarketplace = await temporaryDirectory();
		await writeMarketplace(outsideMarketplace, "outside-market");
		await mkdir(join(localRoot, ".agents"));
		await symlink(join(outsideMarketplace, ".agents", "plugins"), join(localRoot, ".agents", "plugins"));
		const fileSystem = createNodeFileSystem();
		const localStore = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "local-store"),
			fileSystem,
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(localStore.add({ source: "local", root: localRoot })).rejects.toThrow(/resolves outside/u);
		expect((await localStore.list()).marketplaces).toEqual([]);

		const stagedOutside = await temporaryDirectory();
		await writeMarketplace(stagedOutside, "staged-outside");
		const stagedStore = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "git-store"),
			fileSystem,
			processRunner: {
				run: async (request) => {
					if (request.args[0] === "clone") {
						await symlink(stagedOutside, request.args.at(-1)!);
					}
					return processResult();
				},
			},
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(stagedStore.add({ source: "git", url: "https://example.test/symlink.git" })).rejects.toThrow(
			/regular checkout directory/u,
		);
		expect((await stagedStore.list()).marketplaces).toEqual([]);
		expect(
			JSON.parse(await readFile(join(stagedOutside, ".agents", "plugins", "marketplace.json"), "utf8")),
		).toMatchObject({
			name: "staged-outside",
		});
	});

	it("rejects a staging parent symlink before Git can write outside the store", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const outside = await temporaryDirectory();
		await mkdir(storeRoot);
		await symlink(outside, join(storeRoot, "staging"));
		let processRuns = 0;
		const fileSystem = createNodeFileSystem();
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem,
			processRunner: {
				run: async () => {
					processRuns++;
					return processResult();
				},
			},
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/team.git" })).rejects.toThrow(
			/staging.*resolves outside/iu,
		);

		expect(processRuns).toBe(0);
		expect(await fileSystem.readDirectory(outside)).toEqual([]);
	});

	it("rejects a traversal-shaped generated staging identity before running Git", async () => {
		let processRuns = 0;
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					processRuns++;
					return processResult();
				},
			},
			idGenerator: { generate: () => ".." },
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/team.git" })).rejects.toThrow(
			/invalid Plugin Marketplace identity/u,
		);

		expect(processRuns).toBe(0);
		expect((await store.list()).marketplaces).toEqual([]);
	});

	it("rejects a cache parent symlink without moving the staged checkout outside the store", async () => {
		const storeRoot = join(await temporaryDirectory(), "store");
		const outside = await temporaryDirectory();
		const fixture = await temporaryDirectory();
		await writeMarketplace(fixture, "remote-market");
		await mkdir(storeRoot);
		await symlink(outside, join(storeRoot, "cache"));
		const fileSystem = createNodeFileSystem();
		const store = createCodingPluginMarketplaceStore({
			root: storeRoot,
			fileSystem,
			processRunner: new FakeGitRunner([{ fixture, revision: "e".repeat(40) }]),
			idGenerator: new TestIds(),
			environment: {},
		});

		await expect(store.add({ source: "git", url: "https://example.test/team.git" })).rejects.toThrow(
			/cache.*resolves outside/iu,
		);

		expect(await fileSystem.readDirectory(outside)).toEqual([]);
		expect((await store.list()).marketplaces).toEqual([]);
	});

	it("never probes a nested .codex-plugin directory while adding or cataloging", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot, "portable-market");
		const legacyRoot = join(sourceRoot, ".agents", "plugins", ".codex-plugin");
		await mkdir(legacyRoot);
		await writeFile(join(legacyRoot, "plugin.json"), JSON.stringify({ name: "legacy" }));
		const baseFileSystem = createNodeFileSystem();
		let legacyAccesses = 0;
		const rejectLegacyPath = (path: string): void => {
			if (!path.includes(`${sep}.codex-plugin`)) return;
			legacyAccesses++;
			throw new Error("legacy Codex package content must not be probed");
		};
		const store = createCodingPluginMarketplaceStore({
			root: join(await temporaryDirectory(), "store"),
			fileSystem: {
				...baseFileSystem,
				realpath: async (path) => {
					rejectLegacyPath(path);
					return baseFileSystem.realpath(path);
				},
				stat: async (path) => {
					rejectLegacyPath(path);
					return baseFileSystem.stat(path);
				},
				lstat: async (path) => {
					rejectLegacyPath(path);
					return baseFileSystem.lstat(path);
				},
				readFile: async (path) => {
					rejectLegacyPath(path);
					return baseFileSystem.readFile(path);
				},
				readDirectory: async (path) => {
					rejectLegacyPath(path);
					return baseFileSystem.readDirectory(path);
				},
			},
			processRunner: unexpectedProcessRunner,
			idGenerator: new TestIds(),
			environment: {},
		});

		await store.add({ source: "local", root: sourceRoot });
		expect((await store.catalog()).entries.map(({ pluginId }) => pluginId)).toEqual(["review-tools@portable-market"]);
		expect(legacyAccesses).toBe(0);
	});

	it.each(["lexical", "canonical-ancestor"] as const)(
		"rejects a %s local Marketplace root below .codex-plugin before probing reserved content",
		async (kind) => {
			const parent = await temporaryDirectory();
			const reservedParent = join(parent, ".codex-plugin");
			const reservedRoot = join(reservedParent, "portable-market");
			await writeMarketplace(reservedRoot, "must-not-load");
			const canonicalReservedRoot = await realpath(reservedRoot);
			let configuredRoot = reservedRoot;
			if (kind === "canonical-ancestor") {
				const aliasParent = join(parent, "portable-looking");
				await symlink(reservedParent, aliasParent, "dir");
				configuredRoot = join(aliasParent, "portable-market");
			}
			const base = createNodeFileSystem();
			let forbiddenProbes = 0;
			const forbidden = (path: string): boolean =>
				path === reservedRoot ||
				path.startsWith(`${reservedRoot}${sep}`) ||
				path === canonicalReservedRoot ||
				path.startsWith(`${canonicalReservedRoot}${sep}`);
			const rejectForbidden = (path: string): never => {
				forbiddenProbes++;
				throw new Error(`reserved local Marketplace was probed: ${path}`);
			};
			const store = createCodingPluginMarketplaceStore({
				root: join(await temporaryDirectory(), "store"),
				fileSystem: {
					...base,
					realpath: async (path) => (forbidden(path) ? rejectForbidden(path) : base.realpath(path)),
					stat: async (path) => (forbidden(path) ? rejectForbidden(path) : base.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectForbidden(path) : base.lstat(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectForbidden(path) : base.readDirectory(path)),
					readFile: async (path) => (forbidden(path) ? rejectForbidden(path) : base.readFile(path)),
				},
				processRunner: unexpectedProcessRunner,
				idGenerator: new TestIds(),
				environment: {},
			});

			await expect(store.add({ source: "local", root: configuredRoot })).rejects.toThrow(
				/\.codex-plugin|reserved/iu,
			);
			expect(forbiddenProbes).toBe(0);
			expect((await store.list()).marketplaces).toEqual([]);
		},
	);
});
