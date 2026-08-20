import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { IdGenerator } from "@coda/agent";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA } from "@coda/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../../src/host/node-process-runner.ts";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../../src/host/process-runner.ts";
import { createCodingPluginInstallationStore } from "../../src/plugins/installation-store.ts";
import {
	CodingPluginChangeNotificationError,
	type CodingPluginManagement,
	type CodingPluginManagementSnapshot,
	createCodingPluginManagement,
} from "../../src/plugins/management.ts";
import { createCodingPluginMarketplaceStore } from "../../src/plugins/marketplace-store.ts";
import type { UserSettings } from "../../src/settings/types.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugin-management-"));
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
	run: async () => Promise.reject(new Error("local Plugin operations must not run a process")),
};

interface ManagementFixture {
	readonly management: CodingPluginManagement;
	readonly changed: { count: number };
	readonly root: string;
	settings(): UserSettings;
	restart(): CodingPluginManagement;
}

async function createManagementFixture(
	options: {
		readonly root?: string;
		readonly processRunner?: ProcessRunner;
		readonly initialSettings?: UserSettings;
		readonly loadSettings?: (current: UserSettings) => Promise<UserSettings>;
		readonly updateSettings?: (
			mutator: (settings: UserSettings) => UserSettings,
			current: UserSettings,
		) => Promise<UserSettings>;
		readonly saveSettings?: (settings: UserSettings) => Promise<void>;
		readonly onChanged?: (snapshot: CodingPluginManagementSnapshot) => void | Promise<void>;
		readonly fileSystem?: ReturnType<typeof createNodeFileSystem>;
		readonly marketplaceBaseDirectory?: string;
	} = {},
): Promise<ManagementFixture> {
	const root = options.root ?? (await temporaryDirectory());
	const fileSystem = options.fileSystem ?? createNodeFileSystem();
	const ids = new TestIds();
	let settings = options.initialSettings ?? {};
	const changed = { count: 0 };
	const marketplaceStore = createCodingPluginMarketplaceStore({
		root: join(root, "marketplaces"),
		fileSystem,
		processRunner: options.processRunner ?? unexpectedProcessRunner,
		idGenerator: ids,
		environment: { PATH: "/usr/bin" },
	});
	const installationStore = createCodingPluginInstallationStore({
		root: join(root, "installations"),
		fileSystem,
		idGenerator: ids,
	});
	const restart = (): CodingPluginManagement =>
		createCodingPluginManagement({
			marketplaceStore,
			installationStore,
			fileSystem,
			processRunner: options.processRunner ?? unexpectedProcessRunner,
			idGenerator: ids,
			stagingRoot: join(root, "plugin-staging"),
			environment: { PATH: "/usr/bin" },
			...(options.marketplaceBaseDirectory ? { marketplaceBaseDirectory: options.marketplaceBaseDirectory } : {}),
			loadSettings: async () => options.loadSettings?.(settings) ?? settings,
			...(options.updateSettings
				? {
						updateSettings: async (mutator: (current: UserSettings) => UserSettings) => {
							settings = await options.updateSettings!(mutator, settings);
							return settings;
						},
					}
				: {}),
			saveSettings: async (next) => {
				await options.saveSettings?.(next);
				settings = next;
			},
			onChanged: async (snapshot) => {
				changed.count++;
				await options.onChanged?.(snapshot);
			},
		});
	return { management: restart(), changed, root, settings: () => settings, restart };
}

async function writeMarketplace(
	root: string,
	options: {
		readonly marketplace?: string;
		readonly plugin?: string;
		readonly version?: string;
		readonly description?: string;
	} = {},
): Promise<string> {
	const marketplace = options.marketplace ?? "team-market";
	const plugin = options.plugin ?? "review-tools";
	const packageRoot = join(root, ".agents", "plugins", "packages", plugin);
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "plugin.json"),
		JSON.stringify({
			$schema: AGENT_PLUGIN_SCHEMA,
			name: plugin,
			version: options.version ?? "1.0.0",
			description: options.description ?? "Review changes safely",
		}),
	);
	await writeFile(
		join(root, ".agents", "plugins", "marketplace.json"),
		JSON.stringify({ name: marketplace, plugins: [{ name: plugin, source: `./packages/${plugin}` }] }),
	);
	return packageRoot;
}

async function writeRemoteMarketplace(
	root: string,
	options: {
		readonly sha?: string;
		readonly path?: string | null;
		readonly ref?: string;
		readonly source?: "url" | "git-subdir";
	},
): Promise<void> {
	await mkdir(join(root, ".agents", "plugins"), { recursive: true });
	await writeFile(
		join(root, ".agents", "plugins", "marketplace.json"),
		JSON.stringify({
			name: "remote-market",
			plugins: [
				{
					name: "review-tools",
					source: {
						source: options.source ?? "git-subdir",
						url: "https://example.test/review-tools.git",
						...(options.path === null
							? {}
							: { path: options.path === undefined ? "packages/review-tools" : options.path }),
						...(options.ref ? { ref: options.ref } : {}),
						...(options.sha ? { sha: options.sha } : {}),
					},
				},
			],
		}),
	);
}

async function writePluginPackage(root: string, version: string, name = "review-tools"): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "plugin.json"),
		JSON.stringify({
			$schema: AGENT_PLUGIN_SCHEMA,
			name,
			version,
			description: `Review tools ${version}`,
		}),
	);
}

async function writeRemotePluginPackage(
	root: string,
	options: { readonly version?: string; readonly description?: string } = {},
): Promise<void> {
	await writePluginPackage(root, options.version ?? "1.0.0");
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await writeFile(
		join(root, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Review remotely\n---\n\nReview remotely.\n",
	);
	await writeFile(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: AGENT_PLUGIN_MCP_SCHEMA,
			mcpServers: { docs: { type: "streamable-http", url: "https://docs.example.test/mcp" } },
		}),
	);
	if (options.description !== undefined) {
		await writeFile(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "review-tools",
				version: options.version ?? "1.0.0",
				description: options.description,
			}),
		);
	}
}

function processResult(stdout = "", exitCode = 0, stderr = ""): ProcessRunResult {
	return { exitCode, signal: null, stdout, stderr, timedOut: false, truncated: false };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("operation did not settle")), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const hostEnvironment = Object.freeze(
	Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
);

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<ProcessRunResult> {
	const result = await createNodeProcessRunner({ platform: process.platform }).run({
		executable: "git",
		args,
		cwd,
		environment: hostEnvironment,
		signal: new AbortController().signal,
		timeoutMs: 10_000,
		maxOutputBytes: 1024 * 1024,
		maxOutputLines: 10_000,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr || `git exited ${String(result.exitCode)}`);
	return result;
}

class FakeGitRunner implements ProcessRunner {
	readonly requests: ProcessRunRequest[] = [];
	readonly #checkouts: { readonly fixture: string; readonly revision: string }[];
	readonly #revisions = new Map<string, string>();

	constructor(checkouts: readonly { readonly fixture: string; readonly revision: string }[]) {
		this.#checkouts = [...checkouts];
	}

	async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
		this.requests.push(request);
		if (request.executable !== "git") return processResult("", 127, "unexpected executable");
		if (request.args[0] === "clone") {
			const checkout = this.#checkouts.shift();
			const destination = request.args.at(-1);
			if (!checkout || !destination) return processResult("", 1, "missing checkout fixture");
			await cp(checkout.fixture, destination, { recursive: true });
			this.#revisions.set(destination, checkout.revision);
			return processResult();
		}
		const checkoutRoot = request.args[0] === "-C" ? request.args[1] : undefined;
		if (request.args[2] === "rev-parse" && checkoutRoot) {
			const revision = this.#revisions.get(checkoutRoot);
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

describe("Coding Agent Plugin management", () => {
	it("adds a local Marketplace and projects its Plugin as immutable available state", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const { management, changed } = await createManagementFixture();

		const snapshot = await management.marketplaceAdd({ source: "local", root: sourceRoot });

		expect(snapshot).toMatchObject({
			version: 1,
			plugins: [
				{
					pluginId: "review-tools@team-market",
					name: "review-tools",
					marketplace: "team-market",
					state: "available",
					available: true,
					installed: false,
					enabled: false,
					updateAvailable: false,
					invalid: false,
					availableVersion: "1.0.0",
					description: "Review changes safely",
				},
			],
			diagnostics: [],
		});
		expect(snapshot.revision).toMatch(/^plugins:[a-f0-9]{64}$/u);
		expect(changed.count).toBe(1);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.plugins)).toBe(true);
		expect(Object.isFrozen(snapshot.plugins[0])).toBe(true);
	});

	it("routes an explicit refresh through the sole runtime change notification", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const { management, changed } = await createManagementFixture();
		const added = await management.marketplaceAdd({ source: "local", root: sourceRoot });

		const refreshed = await management.refresh();

		expect(refreshed).toEqual(added);
		expect(changed.count).toBe(2);
	});

	it("installs a local Plugin enabled by default and persists its stable PluginId", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const { management, settings, changed } = await createManagementFixture();
		await management.marketplaceAdd({ source: "local", root: sourceRoot });

		const snapshot = await management.install("review-tools@team-market");

		expect(snapshot.plugins).toEqual([
			expect.objectContaining({
				pluginId: "review-tools@team-market",
				state: "enabled",
				available: true,
				installed: true,
				enabled: true,
				installedVersion: "1.0.0",
			}),
		]);
		expect(settings().plugins).toEqual({ "review-tools@team-market": { enabled: true } });
		expect(changed.count).toBe(2);
	});

	it("uses the atomic settings update seam for managed install, lifecycle, and removal writes", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const updateSettings = vi.fn(async (mutator: (settings: UserSettings) => UserSettings, current: UserSettings) =>
			mutator(current),
		);
		const fixture = await createManagementFixture({
			updateSettings,
			saveSettings: async () => {
				throw new Error("legacy settings save must not handle Plugin RMW");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });

		await fixture.management.install("review-tools@team-market");
		await fixture.management.disable("review-tools@team-market");
		await fixture.management.enable("review-tools@team-market");
		await fixture.management.remove("review-tools@team-market");

		expect(updateSettings).toHaveBeenCalledTimes(4);
		expect(fixture.settings().plugins).toEqual({});
	});

	it("rejects reinstalling a managed Plugin without changing its disabled durable state", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		await fixture.management.install("review-tools@team-market");
		const before = await fixture.management.disable("review-tools@team-market");

		await expect(fixture.management.install("review-tools@team-market")).rejects.toMatchObject({
			name: "CodingPluginAlreadyInstalledError",
			code: "plugin_already_installed",
			committed: false,
			pluginId: "review-tools@team-market",
			message:
				'Plugin is already installed: review-tools@team-market. Use "plugin upgrade review-tools@team-market" to update it or "plugin enable review-tools@team-market" to enable it.',
		});

		expect(await fixture.management.snapshot()).toEqual(before);
		expect(await fixture.restart().snapshot()).toEqual(before);
		expect(fixture.settings().plugins).toEqual({ "review-tools@team-market": { enabled: false } });
		expect(fixture.changed.count).toBe(3);
	});

	it("persists disablement across restart, re-enables, and removes only the selected installation", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		await fixture.management.install("review-tools@team-market");

		const disabled = await fixture.management.disable("review-tools@team-market");
		const restarted = await fixture.restart().snapshot();
		const enabled = await fixture.restart().enable("review-tools@team-market");
		const removed = await fixture.restart().remove("review-tools@team-market");

		expect(disabled.plugins[0]).toMatchObject({ state: "installed", installed: true, enabled: false });
		expect(restarted.plugins[0]).toMatchObject({ state: "installed", installed: true, enabled: false });
		expect(enabled.plugins[0]).toMatchObject({ state: "enabled", installed: true, enabled: true });
		expect(removed.plugins[0]).toMatchObject({ state: "available", installed: false, enabled: false });
		expect(fixture.settings().plugins).toEqual({});
	});

	it("detects and installs a local update without changing enablement", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot, { version: "1.0.0" });
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		await fixture.management.install("review-tools@team-market");
		await fixture.management.disable("review-tools@team-market");
		await writeMarketplace(sourceRoot, { version: "2.0.0", description: "Review version two" });

		const available = await fixture.management.snapshot();
		const upgraded = await fixture.management.upgrade("review-tools@team-market");

		expect(available.plugins[0]).toMatchObject({
			state: "update-available",
			installedVersion: "1.0.0",
			availableVersion: "2.0.0",
			updateAvailable: true,
			enabled: false,
		});
		expect(upgraded.plugins[0]).toMatchObject({
			state: "installed",
			installedVersion: "2.0.0",
			availableVersion: "2.0.0",
			updateAvailable: false,
			enabled: false,
			description: "Review version two",
		});
		expect(fixture.settings().plugins).toEqual({ "review-tools@team-market": { enabled: false } });
	});

	it("detects a same-version local source-path update while retaining selected revision details", async () => {
		const sourceRoot = await temporaryDirectory();
		const marketplaceRoot = join(sourceRoot, ".agents", "plugins");
		const firstRoot = join(marketplaceRoot, "packages", "review-v1");
		const secondRoot = join(marketplaceRoot, "packages", "review-v2");
		await writePluginPackage(firstRoot, "1.0.0");
		await writePluginPackage(secondRoot, "1.0.0");
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({ name: "team-market", plugins: [{ name: "review-tools", source: "./packages/review-v1" }] }),
		);
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		const installed = await fixture.management.install("review-tools@team-market");
		const selectedRevision = installed.plugins[0]!.selectedRevision;
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({ name: "team-market", plugins: [{ name: "review-tools", source: "./packages/review-v2" }] }),
		);

		const update = await fixture.management.snapshot();

		expect(update.plugins[0]).toMatchObject({
			state: "update-available",
			updateAvailable: true,
			installedVersion: "1.0.0",
			availableVersion: "1.0.0",
			selectedRevision,
			source: { source: "local", path: "./packages/review-v1", root: expect.stringContaining("review-v1") },
		});
	});

	it("detects same-version package content changes at the same local source path", async () => {
		const sourceRoot = await temporaryDirectory();
		const packageRoot = await writeMarketplace(sourceRoot, {
			version: "1.0.0",
			description: "First package content",
		});
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		const installed = await fixture.management.install("review-tools@team-market");
		const selectedDigest = installed.plugins[0]!.selectedDigest;
		await writeFile(
			join(packageRoot, "plugin.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_SCHEMA,
				name: "review-tools",
				version: "1.0.0",
				description: "Second package content",
			}),
		);

		const update = await fixture.management.snapshot();
		const upgraded = await fixture.management.upgrade("review-tools@team-market");

		expect(update.plugins[0]).toMatchObject({
			state: "update-available",
			updateAvailable: true,
			installedVersion: "1.0.0",
			availableVersion: "1.0.0",
			selectedDigest,
			availableDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(update.plugins[0]!.availableDigest).not.toBe(selectedDigest);
		expect(upgraded.plugins[0]).toMatchObject({
			state: "enabled",
			updateAvailable: false,
			description: "Second package content",
			selectedDigest: update.plugins[0]!.availableDigest,
			availableDigest: update.plugins[0]!.availableDigest,
		});
	});

	it("detects an executable-only local package update as a new exact revision", async () => {
		const sourceRoot = await temporaryDirectory();
		const packageRoot = await writeMarketplace(sourceRoot, { version: "1.0.0" });
		await mkdir(join(packageRoot, "bin"));
		await writeFile(join(packageRoot, "bin", "server"), "#!/bin/sh\nexit 0\n");
		await chmod(join(packageRoot, "bin", "server"), 0o644);
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		const installed = await fixture.management.install("review-tools@team-market");
		const selectedDigest = installed.plugins[0]!.selectedDigest;
		await chmod(join(packageRoot, "bin", "server"), 0o755);

		const update = await fixture.management.snapshot();

		expect(update.plugins[0]).toMatchObject({
			state: "update-available",
			updateAvailable: true,
			selectedDigest,
			availableDigest: expect.not.stringMatching(selectedDigest!),
		});
	});

	it("keeps a valid selected installation operable when a later Marketplace package is malformed", async () => {
		const sourceRoot = await temporaryDirectory();
		const packageRoot = await writeMarketplace(sourceRoot, {
			version: "1.0.0",
			description: "Selected description",
		});
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		const installed = await fixture.management.install("review-tools@team-market");
		await writeFile(join(packageRoot, "plugin.json"), JSON.stringify({ name: "review-tools" }));

		const snapshot = await fixture.management.snapshot();

		expect(snapshot.plugins[0]).toMatchObject({
			state: "enabled",
			installed: true,
			enabled: true,
			invalid: false,
			description: "Selected description",
			selectedRevision: installed.plugins[0]!.selectedRevision,
		});
		expect(snapshot.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ pluginId: "review-tools@team-market", severity: "warning" }),
			]),
		);
	});

	it("normalizes owner/repository Marketplace sources and manages their staged revisions", async () => {
		const first = await temporaryDirectory();
		const second = await temporaryDirectory();
		await writeMarketplace(first, { marketplace: "remote-market", version: "1.0.0" });
		await writeMarketplace(second, { marketplace: "remote-market", version: "2.0.0" });
		const git = new FakeGitRunner([
			{ fixture: first, revision: "1".repeat(40) },
			{ fixture: second, revision: "2".repeat(40) },
		]);
		const { management } = await createManagementFixture({ processRunner: git });

		const added = await management.marketplaceAdd({
			source: "openai/agent-plugins@release/v1",
			sparse: [".agents/plugins"],
		});
		const listed = await management.marketplaceList();
		const upgraded = await management.marketplaceUpgrade("remote-market");
		const removed = await management.marketplaceRemove("remote-market");

		expect(added.marketplaces[0]).toMatchObject({ name: "remote-market", revision: "1".repeat(40) });
		expect(listed).toEqual(added);
		expect(upgraded.marketplaces[0]).toMatchObject({ name: "remote-market", revision: "2".repeat(40) });
		expect(removed.marketplaces).toEqual([]);
		expect(git.requests[0]).toMatchObject({
			executable: "git",
			args: [
				"clone",
				"--no-checkout",
				"--filter=blob:none",
				"--",
				"https://github.com/openai/agent-plugins.git",
				expect.any(String),
			],
		});
		expect(git.requests).toContainEqual(
			expect.objectContaining({ args: expect.arrayContaining(["checkout", "--detach", "release/v1", "--"]) }),
		);
	});

	it("reports Marketplace removal as committed when runtime notification fails", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let failNotification = false;
		const fixture = await createManagementFixture({
			onChanged: async () => {
				if (failNotification) throw new Error("removed Marketplace publication unavailable");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		failNotification = true;

		const failure = await fixture.management.marketplaceRemove("team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				marketplaces: [],
				plugins: [],
			},
		});
		failNotification = false;
		await expect(fixture.restart().snapshot()).resolves.toMatchObject({ marketplaces: [], plugins: [] });
	});

	it("publishes a bounded committed Marketplace removal when its durable projection is unavailable", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const fixtureRoot = await temporaryDirectory();
		let failWhenRemoved = true;
		const fixture = await createManagementFixture({
			root: fixtureRoot,
			loadSettings: async (current) => {
				const serialized = await readFile(join(fixtureRoot, "marketplaces", "marketplaces.v1.json"), "utf8").catch(
					() => undefined,
				);
				if (!serialized) return current;
				const state = JSON.parse(serialized) as { readonly marketplaces: readonly unknown[] };
				if (failWhenRemoved && state.marketplaces.length === 0) {
					throw new Error("removed Marketplace projection unavailable");
				}
				return current;
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });

		const failure = await fixture.management.marketplaceRemove("team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				marketplaces: [],
				plugins: [],
				diagnostics: [
					expect.objectContaining({
						code: "plugin-post-commit-projection-failed",
						marketplace: "team-market",
					}),
				],
			},
		});
		expect((failure as CodingPluginChangeNotificationError).committedSnapshot.diagnostics).toHaveLength(1);
		failWhenRemoved = false;
		await expect(fixture.restart().snapshot()).resolves.toMatchObject({ marketplaces: [], plugins: [] });
	});

	it("reports a Git Marketplace add as committed when post-commit metadata cleanup fails", async () => {
		const source = await temporaryDirectory();
		await writeMarketplace(source, { marketplace: "remote-market" });
		const revision = "3".repeat(40);
		const base = createNodeFileSystem();
		let failMetadataCleanup = true;
		let published: CodingPluginManagementSnapshot | undefined;
		const fixture = await createManagementFixture({
			fileSystem: {
				...base,
				lstat: async (path) => {
					if (failMetadataCleanup && path.endsWith(`${sep}.git`)) {
						throw new Error("Marketplace metadata cleanup unavailable");
					}
					return base.lstat(path);
				},
			},
			processRunner: new FakeGitRunner([{ fixture: source, revision }]),
			onChanged: (snapshot) => {
				published = snapshot;
			},
		});

		const failure = await fixture.management
			.marketplaceAdd({ source: "git", url: "https://example.test/marketplace.git" })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				marketplaces: [{ name: "remote-market", revision }],
			},
		});
		expect(fixture.changed.count).toBe(1);
		expect(published).toEqual((failure as CodingPluginChangeNotificationError).committedSnapshot);
		failMetadataCleanup = false;
		const restarted = await fixture.restart().snapshot();
		expect(restarted.marketplaces).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "remote-market", revision })]),
		);
	});

	it("publishes the committed prefix when the second bulk Marketplace upgrade fails", async () => {
		const alphaFirst = await temporaryDirectory();
		const alphaSecond = await temporaryDirectory();
		const betaFirst = await temporaryDirectory();
		await writeMarketplace(alphaFirst, { marketplace: "alpha-market", version: "1.0.0" });
		await writeMarketplace(alphaSecond, { marketplace: "alpha-market", version: "2.0.0" });
		await writeMarketplace(betaFirst, { marketplace: "beta-market", version: "1.0.0" });
		const alphaFirstRevision = "4".repeat(40);
		const alphaSecondRevision = "5".repeat(40);
		const betaFirstRevision = "6".repeat(40);
		let published: CodingPluginManagementSnapshot | undefined;
		const fixture = await createManagementFixture({
			processRunner: new FakeGitRunner([
				{ fixture: alphaFirst, revision: alphaFirstRevision },
				{ fixture: betaFirst, revision: betaFirstRevision },
				{ fixture: alphaSecond, revision: alphaSecondRevision },
			]),
			onChanged: (snapshot) => {
				published = snapshot;
			},
		});
		await fixture.management.marketplaceAdd({ source: "git", url: "https://example.test/alpha.git" });
		await fixture.management.marketplaceAdd({ source: "git", url: "https://example.test/beta.git" });

		const failure = await fixture.management.marketplaceUpgrade().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				marketplaces: [
					{ name: "alpha-market", revision: alphaSecondRevision },
					{ name: "beta-market", revision: betaFirstRevision },
				],
			},
		});
		expect(fixture.changed.count).toBe(3);
		expect(published).toEqual((failure as CodingPluginChangeNotificationError).committedSnapshot);
		const restarted = await fixture.restart().snapshot();
		expect(restarted.marketplaces).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "alpha-market", revision: alphaSecondRevision }),
				expect.objectContaining({ name: "beta-market", revision: betaFirstRevision }),
			]),
		);
	});

	it("installs and upgrades a remote git-subdir at the declared ref and SHA, then cleans staging", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const firstRepository = await temporaryDirectory();
		const secondRepository = await temporaryDirectory();
		const firstSha = "a".repeat(40);
		const secondSha = "b".repeat(40);
		await writePluginPackage(join(firstRepository, "packages", "review-tools"), "1.0.0");
		await writePluginPackage(join(secondRepository, "packages", "review-tools"), "2.0.0");
		await writeRemoteMarketplace(marketplaceRoot, { sha: firstSha, ref: "release/v1" });
		const git = new FakeGitRunner([
			{ fixture: firstRepository, revision: firstSha },
			{ fixture: firstRepository, revision: firstSha },
			{ fixture: secondRepository, revision: secondSha },
			{ fixture: secondRepository, revision: secondSha },
		]);
		const fixture = await createManagementFixture({ processRunner: git });
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });

		const installed = await fixture.management.install("review-tools@remote-market");
		await writeRemoteMarketplace(marketplaceRoot, { sha: secondSha, ref: "release/v2" });
		const available = await fixture.management.snapshot();
		const upgraded = await fixture.management.upgrade("review-tools@remote-market");

		expect(installed.plugins[0]).toMatchObject({ state: "enabled", installedVersion: "1.0.0" });
		expect(available.plugins[0]).toMatchObject({ state: "update-available", updateAvailable: true });
		expect(upgraded.plugins[0]).toMatchObject({ state: "enabled", installedVersion: "2.0.0" });
		expect(git.requests.filter(({ args }) => args[0] === "clone")).toHaveLength(4);
		expect(git.requests).toContainEqual(
			expect.objectContaining({ args: expect.arrayContaining(["checkout", "--detach", firstSha, "--"]) }),
		);
		expect(git.requests).toContainEqual(
			expect.objectContaining({ args: expect.arrayContaining(["checkout", "--detach", secondSha, "--"]) }),
		);
		await expect(
			import("node:fs/promises").then(({ readdir }) => readdir(join(fixture.root, "plugin-staging"))),
		).resolves.toEqual([]);
	});

	it.each([
		{ label: "URL-only", source: "url" as const, path: null },
		{ label: "ref-only", source: "git-subdir" as const, path: "packages/review-tools", ref: "release/v1" },
	])("persists the observed exact Git revision for a $label Plugin across restart", async (source) => {
		const marketplaceRoot = await temporaryDirectory();
		const repository = await temporaryDirectory();
		const revision = "f".repeat(40);
		const packageRoot = source.path === null ? repository : join(repository, source.path);
		await writePluginPackage(packageRoot, "1.0.0");
		await writeRemoteMarketplace(marketplaceRoot, source);
		const fixture = await createManagementFixture({
			processRunner: new FakeGitRunner([
				{ fixture: repository, revision },
				{ fixture: repository, revision },
			]),
		});
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });

		const installed = await fixture.management.install("review-tools@remote-market");
		const restarted = await fixture.restart().snapshot();

		for (const snapshot of [installed, restarted]) {
			expect(snapshot.plugins[0]).toMatchObject({
				state: "enabled",
				updateAvailable: false,
				source: { source: source.source, sha: revision },
			});
		}
	});

	it("materializes remote metadata and contributions before install, then reuses it after restart", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const repository = await temporaryDirectory();
		const revision = "7".repeat(40);
		await writeRemotePluginPackage(join(repository, "packages", "review-tools"), {
			version: "3.2.1",
			description: "Remote review catalog",
		});
		await writeRemoteMarketplace(marketplaceRoot, { ref: "main" });
		const git = new FakeGitRunner([{ fixture: repository, revision }]);
		const fixture = await createManagementFixture({ processRunner: git });

		const added = await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		const browsed = await fixture.management.snapshot();
		const restarted = await fixture.restart().snapshot();

		for (const snapshot of [added, browsed, restarted]) {
			expect(snapshot.plugins[0]).toMatchObject({
				pluginId: "review-tools@remote-market",
				state: "available",
				available: true,
				installed: false,
				invalid: false,
				availableVersion: "3.2.1",
				availableDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				availableRevision: revision,
				description: "Remote review catalog",
				source: { source: "git-subdir", ref: "main", sha: revision },
				contributions: {
					skills: ["review-tools:review"],
					mcpServers: ["review-tools:docs"],
				},
			});
		}
		expect(git.requests.filter(({ args }) => args[0] === "clone")).toHaveLength(1);
		await fixture.management.marketplaceRemove("remote-market");
		expect(JSON.parse(await readFile(join(fixture.root, "remote-packages.v1.json"), "utf8")).entries).toEqual([]);
	});

	it("merges a concurrently committed remote catalog entry instead of deleting it from a stale projection", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = await temporaryDirectory();
		const repository = await temporaryDirectory();
		const revision = "7".repeat(40);
		await writeRemotePluginPackage(join(repository, "packages", "review-tools"));
		await writeRemoteMarketplace(marketplaceRoot, { ref: "main" });
		const git = new FakeGitRunner([{ fixture: repository, revision }]);
		let injected = false;
		const processRunner: ProcessRunner = {
			run: async (request) => {
				if (!injected) {
					injected = true;
					await writeFile(
						join(root, "remote-packages.v1.json"),
						`${JSON.stringify({
							version: 1,
							entries: [
								{
									pluginId: "beta-tools@other-market",
									declaredSource: { source: "url", url: "https://example.test/beta-tools.git" },
									resolvedSource: {
										source: "url",
										url: "https://example.test/beta-tools.git",
										sha: "8".repeat(40),
									},
									digest: "9".repeat(64),
									manifest: { name: "beta-tools", version: "1.0.0" },
									skillNames: [],
									mcpServerNames: [],
								},
							],
						})}\n`,
					);
				}
				return git.run(request);
			},
		};
		const fixture = await createManagementFixture({ root, processRunner });

		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });

		const persisted = JSON.parse(await readFile(join(root, "remote-packages.v1.json"), "utf8"));
		expect(persisted.entries.map(({ pluginId }: { readonly pluginId: string }) => pluginId)).toEqual([
			"beta-tools@other-market",
			"review-tools@remote-market",
		]);
	});

	it("detects a moving remote ref by exact HEAD and content digest, then revalidates the upgrade", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const firstRepository = await temporaryDirectory();
		const secondRepository = await temporaryDirectory();
		const firstRevision = "8".repeat(40);
		const secondRevision = "9".repeat(40);
		await writeRemotePluginPackage(join(firstRepository, "packages", "review-tools"), {
			description: "Moving ref version one",
		});
		await writeRemotePluginPackage(join(secondRepository, "packages", "review-tools"), {
			description: "Moving ref version two",
		});
		await writeRemoteMarketplace(marketplaceRoot, { ref: "main" });
		const git = new FakeGitRunner([
			{ fixture: firstRepository, revision: firstRevision },
			{ fixture: firstRepository, revision: firstRevision },
			{ fixture: secondRepository, revision: secondRevision },
			{ fixture: secondRepository, revision: secondRevision },
		]);
		const fixture = await createManagementFixture({ processRunner: git });
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		const installed = await fixture.management.install("review-tools@remote-market");

		const update = await fixture.management.refresh();
		const upgraded = await fixture.management.upgrade("review-tools@remote-market");
		const restarted = await fixture.restart().snapshot();

		expect(installed.plugins[0]).toMatchObject({
			state: "enabled",
			updateAvailable: false,
			source: { sha: firstRevision },
		});
		expect(update.plugins[0]).toMatchObject({
			state: "update-available",
			updateAvailable: true,
			availableRevision: secondRevision,
			source: { sha: firstRevision },
		});
		expect(update.plugins[0]!.availableDigest).not.toBe(update.plugins[0]!.selectedDigest);
		for (const snapshot of [upgraded, restarted]) {
			expect(snapshot.plugins[0]).toMatchObject({
				state: "enabled",
				updateAvailable: false,
				availableRevision: secondRevision,
				source: { sha: secondRevision },
				description: "Moving ref version two",
			});
			expect(snapshot.plugins[0]!.availableDigest).toBe(snapshot.plugins[0]!.selectedDigest);
		}
		expect(git.requests.filter(({ args }) => args[0] === "clone")).toHaveLength(4);
		expect(git.requests).toContainEqual(
			expect.objectContaining({ args: expect.arrayContaining(["checkout", "--detach", firstRevision, "--"]) }),
		);
	});

	it("retains the last valid remote projection and installation when a moving-ref refresh is invalid", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const validRepository = await temporaryDirectory();
		const invalidRepository = await temporaryDirectory();
		const validRevision = "a".repeat(40);
		await writeRemotePluginPackage(join(validRepository, "packages", "review-tools"));
		await mkdir(join(invalidRepository, "packages", "review-tools"), { recursive: true });
		await writeFile(
			join(invalidRepository, "packages", "review-tools", "plugin.json"),
			JSON.stringify({ name: "review-tools" }),
		);
		await writeRemoteMarketplace(marketplaceRoot, { ref: "main" });
		const git = new FakeGitRunner([
			{ fixture: validRepository, revision: validRevision },
			{ fixture: validRepository, revision: validRevision },
			{ fixture: invalidRepository, revision: "b".repeat(40) },
		]);
		const fixture = await createManagementFixture({ processRunner: git });
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		const installed = await fixture.management.install("review-tools@remote-market");

		const failedRefresh = await fixture.management.refresh();
		const restarted = await fixture.restart().snapshot();

		for (const snapshot of [failedRefresh, restarted]) {
			expect(snapshot.plugins[0]).toMatchObject({
				state: "enabled",
				invalid: false,
				updateAvailable: false,
				availableRevision: validRevision,
				selectedDigest: installed.plugins[0]!.selectedDigest,
			});
		}
		expect(failedRefresh.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-remote-refresh-failed",
				pluginId: "review-tools@remote-market",
				severity: "warning",
			}),
		);
	});

	it("rejects a remote selection whose revalidated package differs from the advertised digest", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const advertisedRepository = await temporaryDirectory();
		const changedRepository = await temporaryDirectory();
		const revision = "6".repeat(40);
		await writeRemotePluginPackage(join(advertisedRepository, "packages", "review-tools"), {
			description: "Advertised package",
		});
		await writeRemotePluginPackage(join(changedRepository, "packages", "review-tools"), {
			description: "Changed package under the same revision",
		});
		await writeRemoteMarketplace(marketplaceRoot, { ref: "main" });
		const fixture = await createManagementFixture({
			processRunner: new FakeGitRunner([
				{ fixture: advertisedRepository, revision },
				{ fixture: changedRepository, revision },
			]),
		});
		const advertised = await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });

		await expect(fixture.management.install("review-tools@remote-market")).rejects.toThrow(
			/selected catalog digest/u,
		);

		const retained = await fixture.management.snapshot();
		expect(retained.plugins[0]).toMatchObject({
			state: "available",
			installed: false,
			invalid: false,
			availableDigest: advertised.plugins[0]!.availableDigest,
			availableRevision: revision,
			description: "Advertised package",
		});
		expect(fixture.settings()).toEqual({});
	});

	it("reports a refresh callback failure as post-commit with the immutable committed snapshot", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let failNotification = false;
		const fixture = await createManagementFixture({
			onChanged: async () => {
				if (failNotification) throw new Error("runtime refresh unavailable");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		failNotification = true;

		const failure = await fixture.management.install("review-tools@team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			cause: expect.objectContaining({ message: "runtime refresh unavailable" }),
			committedSnapshot: {
				version: 1,
				plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state: "enabled" })],
			},
		});
		expect(Object.isFrozen((failure as CodingPluginChangeNotificationError).committedSnapshot)).toBe(true);
		expect((await fixture.restart().snapshot()).plugins[0]).toMatchObject({ state: "enabled", installed: true });
		failNotification = false;
		const recovered = await fixture.restart().enable("review-tools@team-market");
		expect(recovered.plugins[0]).toMatchObject({ state: "enabled" });
		expect(fixture.changed.count).toBe(3);
	});

	it("reports a committed managed lifecycle when durable projection fails and notifies with a bounded fallback", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let projectionUnavailable = false;
		const published: CodingPluginManagementSnapshot[] = [];
		const fixture = await createManagementFixture({
			loadSettings: async (current) => {
				if (projectionUnavailable) throw new Error("durable projection unavailable");
				return current;
			},
			saveSettings: async () => {
				projectionUnavailable = true;
			},
			onChanged: (snapshot) => {
				published.push(snapshot);
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });

		const failure = await fixture.management.install("review-tools@team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				version: 1,
				revision: expect.stringMatching(/^plugins:/u),
				plugins: [
					expect.objectContaining({
						pluginId: "review-tools@team-market",
						state: "enabled",
						installed: true,
						enabled: true,
					}),
				],
			},
		});
		expect((failure as CodingPluginChangeNotificationError).committedSnapshot.diagnostics.length).toBeLessThanOrEqual(
			512,
		);
		expect(published.at(-1)).toBe((failure as CodingPluginChangeNotificationError).committedSnapshot);
		expect(fixture.settings().plugins).toEqual({ "review-tools@team-market": { enabled: true } });

		projectionUnavailable = false;
		await expect(fixture.restart().snapshot()).resolves.toMatchObject({
			plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state: "enabled" })],
		});
	});

	it.each([
		["install", "enabled"],
		["upgrade", "enabled"],
		["enable", "enabled"],
		["disable", "installed"],
		["remove", "available"],
	] as const)("classifies a %s notification failure after its durable lifecycle commit", async (operation, state) => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let failNotification = false;
		const fixture = await createManagementFixture({
			onChanged: async () => {
				if (failNotification) throw new Error(`${operation} runtime notification unavailable`);
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		if (operation !== "install") await fixture.management.install("review-tools@team-market");
		if (operation === "enable") await fixture.management.disable("review-tools@team-market");
		if (operation === "upgrade") await writeMarketplace(sourceRoot, { version: "2.0.0" });
		failNotification = true;
		const mutation =
			operation === "install"
				? fixture.management.install("review-tools@team-market")
				: operation === "upgrade"
					? fixture.management.upgrade("review-tools@team-market")
					: operation === "enable"
						? fixture.management.enable("review-tools@team-market")
						: operation === "disable"
							? fixture.management.disable("review-tools@team-market")
							: fixture.management.remove("review-tools@team-market");

		const failure = await mutation.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_change_notification_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state })],
			},
		});
		failNotification = false;
		await expect(fixture.restart().snapshot()).resolves.toMatchObject({
			plugins: [expect.objectContaining({ pluginId: "review-tools@team-market", state })],
		});
	});

	it("isolates an invalid catalog entry while retaining healthy available Plugins", async () => {
		const sourceRoot = await temporaryDirectory();
		const marketplaceRoot = join(sourceRoot, ".agents", "plugins");
		await writePluginPackage(join(marketplaceRoot, "packages", "healthy-tools"), "1.0.0", "healthy-tools");
		await mkdir(join(marketplaceRoot, "packages", "broken-tools"), { recursive: true });
		await writeFile(
			join(marketplaceRoot, "packages", "broken-tools", "plugin.json"),
			JSON.stringify({ name: "broken-tools", version: "1.0.0" }),
		);
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "broken-tools", source: "./packages/broken-tools" },
					{ name: "healthy-tools", source: "./packages/healthy-tools" },
				],
			}),
		);
		const { management } = await createManagementFixture();

		const snapshot = await management.marketplaceAdd({ source: "local", root: sourceRoot });

		expect(snapshot.plugins).toEqual([
			expect.objectContaining({
				pluginId: "broken-tools@team-market",
				state: "invalid",
				invalid: true,
				available: false,
			}),
			expect.objectContaining({
				pluginId: "healthy-tools@team-market",
				state: "available",
				invalid: false,
				available: true,
			}),
		]);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-package-invalid",
				pluginId: "broken-tools@team-market",
			}),
		);
	});

	it("projects a symlink-swapped managed installation as invalid without reading the external package", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const outsideRoot = await temporaryDirectory();
		await writePluginPackage(outsideRoot, "9.9.9", "review-tools");
		await writeFile(
			join(outsideRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { escaped: { command: "outside-plugin-process" } },
			}),
		);
		const base = createNodeFileSystem();
		let selectedRoot: string | undefined;
		let forbiddenPackageProbes = 0;
		const forbidden = (path: string): boolean =>
			path === outsideRoot ||
			path.startsWith(`${outsideRoot}${sep}`) ||
			(path !== undefined &&
				selectedRoot !== undefined &&
				(path === selectedRoot || path.startsWith(`${selectedRoot}${sep}`)));
		const rejectProbe = (path: string): never => {
			forbiddenPackageProbes++;
			throw new Error(`External managed package was probed: ${path}`);
		};
		const fileSystem = {
			...base,
			realpath: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.realpath(path)),
			stat: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.stat(path)),
			readDirectory: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.readDirectory(path)),
			readFile: async (path: string) => (forbidden(path) ? rejectProbe(path) : base.readFile(path)),
		};
		const fixture = await createManagementFixture({ fileSystem });
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		const installed = await fixture.management.install("review-tools@team-market");
		selectedRoot = installed.plugins[0]!.selectedRoot!;
		await rm(selectedRoot, { recursive: true, force: true });
		await symlink(outsideRoot, selectedRoot, "dir");

		const snapshot = await fixture.management.snapshot();

		expect(forbiddenPackageProbes).toBe(0);
		expect(snapshot.plugins[0]).toMatchObject({
			pluginId: "review-tools@team-market",
			installed: true,
			available: true,
			state: "invalid",
			invalid: true,
			contributions: { skills: [], mcpServers: [] },
		});
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({
				pluginId: "review-tools@team-market",
				code: "plugin-installation-root-invalid",
			}),
		);
	});

	it("rejects an ambiguous bare selector and accepts the exact stable PluginId", async () => {
		const alpha = await temporaryDirectory();
		const beta = await temporaryDirectory();
		await writeMarketplace(alpha, { marketplace: "alpha-market" });
		await writeMarketplace(beta, { marketplace: "beta-market" });
		const { management } = await createManagementFixture();
		await management.marketplaceAdd({ source: "local", root: beta });
		await management.marketplaceAdd({ source: "local", root: alpha });

		await expect(management.install("review-tools")).rejects.toThrow(
			'Plugin selector "review-tools" is ambiguous: review-tools@alpha-market, review-tools@beta-market',
		);
		const installed = await management.install("review-tools@beta-market");

		expect(installed.plugins).toEqual([
			expect.objectContaining({ pluginId: "review-tools@alpha-market", state: "available" }),
			expect.objectContaining({ pluginId: "review-tools@beta-market", state: "enabled" }),
		]);
	});

	it("rolls back a new installation when atomic settings persistence fails", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let failSave = false;
		const fixture = await createManagementFixture({
			initialSettings: { ui: { motion: "reduced" } },
			saveSettings: async () => {
				if (failSave) throw new Error("settings rename failed");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		failSave = true;

		await expect(fixture.management.install("review-tools@team-market")).rejects.toThrow("settings rename failed");

		expect((await fixture.management.snapshot()).plugins[0]).toMatchObject({
			state: "available",
			installed: false,
			enabled: false,
		});
		expect(fixture.settings()).toEqual({ ui: { motion: "reduced" } });
		expect(fixture.changed.count).toBe(1);
	});

	it("reports the durable installation when settings persistence and installation rollback both fail", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const base = createNodeFileSystem();
		let installationStateWrites = 0;
		let failSettingsSave = false;
		const fixture = await createManagementFixture({
			fileSystem: {
				...base,
				rename: async (source, destination) => {
					if (destination.endsWith(`${sep}installations.v1.json`) && ++installationStateWrites === 2) {
						throw new Error("installation rollback unavailable");
					}
					return base.rename(source, destination);
				},
			},
			saveSettings: async () => {
				if (failSettingsSave) throw new Error("settings persistence unavailable");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		failSettingsSave = true;

		const failure = await fixture.management.install("review-tools@team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				diagnostics: [
					expect.objectContaining({
						code: "plugin-rollback-failed",
						pluginId: "review-tools@team-market",
					}),
				],
				plugins: [
					expect.objectContaining({
						pluginId: "review-tools@team-market",
						state: "enabled",
						installed: true,
						enabled: true,
					}),
				],
			},
		});
		expect(fixture.settings()).toEqual({});
		expect(fixture.changed.count).toBe(2);
		failSettingsSave = false;
		const restarted = await fixture.restart().snapshot();
		expect(restarted.plugins[0]!.selectedRevision).toBe(
			(failure as CodingPluginChangeNotificationError).committedSnapshot.plugins[0]!.selectedRevision,
		);
		expect(restarted.plugins[0]).toMatchObject({ state: "enabled", installed: true, enabled: true });
	});

	it("reports a bounded partial snapshot when failed rollback state cannot be reread", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const base = createNodeFileSystem();
		let installationStateWrites = 0;
		let installationStateUnreadable = false;
		let failSettingsSave = false;
		const fixture = await createManagementFixture({
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (installationStateUnreadable && path.endsWith(`${sep}installations.v1.json`)) {
						throw new Error("installation state unreadable");
					}
					return base.readFile(path);
				},
				rename: async (source, destination) => {
					if (destination.endsWith(`${sep}installations.v1.json`) && ++installationStateWrites === 2) {
						installationStateUnreadable = true;
						throw new Error("installation rollback unavailable");
					}
					return base.rename(source, destination);
				},
			},
			saveSettings: async () => {
				if (failSettingsSave) throw new Error("settings persistence unavailable");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		failSettingsSave = true;

		const failure = await fixture.management.install("review-tools@team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				plugins: [
					expect.objectContaining({
						pluginId: "review-tools@team-market",
						state: "available",
						installed: false,
					}),
				],
				diagnostics: [
					expect.objectContaining({
						code: "plugin-post-commit-projection-failed",
						pluginId: "review-tools@team-market",
					}),
					expect.objectContaining({
						code: "plugin-rollback-failed",
						pluginId: "review-tools@team-market",
					}),
				],
			},
		});
		expect((failure as CodingPluginChangeNotificationError).committedSnapshot.plugins).toHaveLength(1);
		expect((failure as CodingPluginChangeNotificationError).committedSnapshot.diagnostics.length).toBeLessThanOrEqual(
			512,
		);
		installationStateUnreadable = false;
		failSettingsSave = false;
		await expect(fixture.restart().snapshot()).resolves.toMatchObject({
			plugins: [expect.objectContaining({ state: "enabled", installed: true })],
		});
	});

	it("reports the selected upgrade when remote catalog persistence and installation rollback both fail", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const firstRepository = await temporaryDirectory();
		const secondRepository = await temporaryDirectory();
		const firstSha = "7".repeat(40);
		const secondSha = "8".repeat(40);
		await writeRemotePluginPackage(join(firstRepository, "packages", "review-tools"), { version: "1.0.0" });
		await writeRemotePluginPackage(join(secondRepository, "packages", "review-tools"), { version: "2.0.0" });
		await writeRemoteMarketplace(marketplaceRoot, { sha: firstSha, ref: "release/v1" });
		const base = createNodeFileSystem();
		let injectUpgradeFailures = false;
		let installationStateWrites = 0;
		const fixture = await createManagementFixture({
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (
						injectUpgradeFailures &&
						installationStateWrites > 0 &&
						path.endsWith(`${sep}remote-packages.v1.json`)
					) {
						throw new Error("remote catalog persistence unavailable");
					}
					return base.readFile(path);
				},
				rename: async (source, destination) => {
					if (injectUpgradeFailures && destination.endsWith(`${sep}installations.v1.json`)) {
						installationStateWrites++;
						if (installationStateWrites === 2) throw new Error("installation rollback unavailable");
					}
					return base.rename(source, destination);
				},
			},
			processRunner: new FakeGitRunner([
				{ fixture: firstRepository, revision: firstSha },
				{ fixture: firstRepository, revision: firstSha },
				{ fixture: secondRepository, revision: secondSha },
				{ fixture: secondRepository, revision: secondSha },
			]),
		});
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		await fixture.management.install("review-tools@remote-market");
		await writeRemoteMarketplace(marketplaceRoot, { sha: secondSha, ref: "release/v2" });
		injectUpgradeFailures = true;

		const failure = await fixture.management.upgrade("review-tools@remote-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				diagnostics: expect.arrayContaining([
					expect.objectContaining({
						code: "plugin-rollback-failed",
						pluginId: "review-tools@remote-market",
					}),
				]),
				plugins: [
					expect.objectContaining({
						pluginId: "review-tools@remote-market",
						state: "enabled",
						installed: true,
						installedVersion: "2.0.0",
						enabled: true,
					}),
				],
			},
		});
		expect(fixture.changed.count).toBe(3);
		injectUpgradeFailures = false;
		const restarted = await fixture.restart().snapshot();
		expect(restarted.plugins[0]!.selectedRevision).toBe(
			(failure as CodingPluginChangeNotificationError).committedSnapshot.plugins[0]!.selectedRevision,
		);
		expect(restarted.plugins[0]).toMatchObject({ state: "enabled", installedVersion: "2.0.0", enabled: true });
	});

	it("reports the durable removal state when installation removal and settings rollback both fail", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		const base = createNodeFileSystem();
		let failInstallationRemoval = false;
		let failSettingsRollback = false;
		const fixture = await createManagementFixture({
			fileSystem: {
				...base,
				rename: async (source, destination) => {
					if (failInstallationRemoval && destination.endsWith(`${sep}installations.v1.json`)) {
						throw new Error("installation selection unavailable");
					}
					return base.rename(source, destination);
				},
			},
			saveSettings: async (next) => {
				if (failSettingsRollback && next.plugins?.["review-tools@team-market"] !== undefined) {
					throw new Error("settings rollback unavailable");
				}
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		await fixture.management.install("review-tools@team-market");
		await fixture.management.disable("review-tools@team-market");
		failInstallationRemoval = true;
		failSettingsRollback = true;

		const failure = await fixture.management.remove("review-tools@team-market").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(CodingPluginChangeNotificationError);
		expect(failure).toMatchObject({
			committed: true,
			code: "plugin_post_commit_failed",
			committedSnapshot: {
				revision: expect.stringMatching(/^plugins:/u),
				diagnostics: [
					expect.objectContaining({
						code: "plugin-rollback-failed",
						pluginId: "review-tools@team-market",
					}),
				],
				plugins: [
					expect.objectContaining({
						pluginId: "review-tools@team-market",
						state: "enabled",
						installed: true,
						enabled: true,
					}),
				],
			},
		});
		expect(fixture.settings().plugins).toEqual({});
		expect(fixture.changed.count).toBe(4);
		failInstallationRemoval = false;
		failSettingsRollback = false;
		const restarted = await fixture.restart().snapshot();
		expect(restarted.plugins[0]!.selectedRevision).toBe(
			(failure as CodingPluginChangeNotificationError).committedSnapshot.plugins[0]!.selectedRevision,
		);
		expect(restarted.plugins[0]).toMatchObject({ state: "enabled", installed: true, enabled: true });
	});

	it("leaves enablement unchanged when its settings adapter rejects the atomic save", async () => {
		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let failSave = false;
		const fixture = await createManagementFixture({
			saveSettings: async () => {
				if (failSave) throw new Error("settings unavailable");
			},
		});
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });
		await fixture.management.install("review-tools@team-market");
		failSave = true;

		await expect(fixture.management.disable("review-tools@team-market")).rejects.toThrow("settings unavailable");

		expect((await fixture.management.snapshot()).plugins[0]).toMatchObject({ state: "enabled", enabled: true });
		expect(fixture.settings().plugins).toEqual({ "review-tools@team-market": { enabled: true } });
		expect(fixture.changed.count).toBe(2);
	});

	it("settles a failed remote upgrade without replacing the old installation or settings", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const firstRepository = await temporaryDirectory();
		const invalidRepository = await temporaryDirectory();
		const firstSha = "c".repeat(40);
		const declaredSecondSha = "d".repeat(40);
		await writePluginPackage(join(firstRepository, "packages", "review-tools"), "1.0.0");
		await writePluginPackage(join(invalidRepository, "packages", "review-tools"), "2.0.0");
		await writeRemoteMarketplace(marketplaceRoot, { sha: firstSha, ref: "release/v1" });
		const git = new FakeGitRunner([
			{ fixture: firstRepository, revision: firstSha },
			{ fixture: firstRepository, revision: firstSha },
			{ fixture: invalidRepository, revision: "e".repeat(40) },
		]);
		const fixture = await createManagementFixture({ processRunner: git });
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		const installed = await fixture.management.install("review-tools@remote-market");
		const selectedRoot = installed.plugins[0]!.selectedRoot;
		await writeRemoteMarketplace(marketplaceRoot, { sha: declaredSecondSha, ref: "release/v2" });

		await expect(within(fixture.management.upgrade("review-tools@remote-market"))).rejects.toThrow(
			/does not match declared SHA/u,
		);

		expect((await fixture.management.snapshot()).plugins[0]).toMatchObject({
			state: "update-available",
			installedVersion: "1.0.0",
			selectedRoot,
			enabled: true,
		});
		expect(fixture.settings().plugins).toEqual({ "review-tools@remote-market": { enabled: true } });
		expect(fixture.changed.count).toBe(2);
		await expect(
			import("node:fs/promises").then(({ readdir }) => readdir(join(fixture.root, "plugin-staging"))),
		).resolves.toEqual([]);
	});

	it("cleans a failed remote checkout without probing a case-folded reserved subtree", async () => {
		const marketplaceRoot = await temporaryDirectory();
		const catalogRepository = await temporaryDirectory();
		const failingRepository = await temporaryDirectory();
		const declaredSha = "c".repeat(40);
		await writePluginPackage(join(catalogRepository, "packages", "review-tools"), "1.0.0");
		await writePluginPackage(join(failingRepository, "packages", "review-tools"), "1.0.0");
		await mkdir(join(failingRepository, ".CODEX-PLUGIN"));
		await writeFile(join(failingRepository, ".CODEX-PLUGIN", "plugin.json"), "must not be probed\n");
		await writeRemoteMarketplace(marketplaceRoot, { sha: declaredSha });
		const git = new FakeGitRunner([
			{ fixture: catalogRepository, revision: declaredSha },
			{ fixture: failingRepository, revision: "d".repeat(40) },
		]);
		const base = createNodeFileSystem();
		let reservedProbes = 0;
		const isReservedPath = (path: string): boolean =>
			path.split(sep).some((component) => component.toLowerCase() === ".codex-plugin");
		const rejectReservedProbe = (path: string): void => {
			if (!isReservedPath(path)) return;
			reservedProbes++;
			throw new Error(`reserved staged subtree was probed: ${path}`);
		};
		const fixture = await createManagementFixture({
			processRunner: git,
			fileSystem: {
				...base,
				realpath: async (path) => {
					rejectReservedProbe(path);
					return base.realpath(path);
				},
				stat: async (path) => {
					rejectReservedProbe(path);
					return base.stat(path);
				},
				lstat: async (path) => {
					rejectReservedProbe(path);
					return base.lstat(path);
				},
				readFile: async (path) => {
					rejectReservedProbe(path);
					return base.readFile(path);
				},
				readDirectory: async (path) => {
					rejectReservedProbe(path);
					return base.readDirectory(path);
				},
			},
		});

		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		expect(await readdir(join(fixture.root, "plugin-staging"))).toEqual([]);

		await expect(fixture.management.install("review-tools@remote-market")).rejects.toThrow(
			/does not match declared SHA/u,
		);

		expect(reservedProbes).toBe(0);
		await expect(readdir(join(fixture.root, "plugin-staging"))).resolves.toEqual([]);
	});

	it("uses real Git sparse checkout to materialize portable content without the legacy subtree", async () => {
		const repository = await temporaryDirectory();
		const packageRoot = repository;
		await mkdir(join(packageRoot, "skills", "review"), { recursive: true });
		await mkdir(join(packageRoot, ".codex-plugin"), { recursive: true });
		await writeFile(
			join(packageRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", version: "1.0.0" }),
		);
		await writeFile(
			join(packageRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\n\nReview changes.\n",
		);
		await writeFile(
			join(packageRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);
		await writeFile(join(packageRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ poisoned: true }));
		await runFixtureGit(repository, ["init", "--initial-branch=main"]);
		await runFixtureGit(repository, ["config", "user.email", "fixture@example.test"]);
		await runFixtureGit(repository, ["config", "user.name", "Fixture"]);
		await runFixtureGit(repository, ["add", "--all"]);
		await runFixtureGit(repository, ["commit", "-m", "fixture"]);
		const revision = (await runFixtureGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
		const marketplaceRoot = await temporaryDirectory();
		await writeRemoteMarketplace(marketplaceRoot, { sha: revision, path: null, source: "url" });
		const nodeRunner = createNodeProcessRunner({ platform: process.platform });
		let checkoutRoot: string | undefined;
		let checkoutEntries: readonly string[] | undefined;
		const actualGit: ProcessRunner = {
			run: async (request) => {
				let forwarded = request;
				if (request.args[0] === "clone") {
					const args = [...request.args];
					const separator = args.indexOf("--");
					if (separator < 0 || !args.at(-1)) throw new Error("unsafe clone request");
					args[separator + 1] = pathToFileURL(repository).toString();
					checkoutRoot = args.at(-1);
					forwarded = { ...request, args };
				}
				const result = await nodeRunner.run({ ...forwarded, environment: hostEnvironment });
				if (request.args[2] === "checkout" && result.exitCode === 0 && checkoutRoot) {
					checkoutEntries = (await readdir(checkoutRoot)).sort();
				}
				return result;
			},
		};
		const fixture = await createManagementFixture({ processRunner: actualGit });
		await fixture.management.marketplaceAdd({ source: "local", root: marketplaceRoot });

		const installed = await fixture.management.install("review-tools@remote-market");

		expect(checkoutEntries).toEqual([".git", "mcp.json", "plugin.json", "skills"]);
		expect(installed.plugins[0]).toMatchObject({ state: "enabled", installedVersion: "1.0.0" });
		expect((await readdir(installed.plugins[0]!.selectedRoot!)).sort()).toEqual([
			"mcp.json",
			"plugin.json",
			"skills",
		]);
	});

	it("rejects npm, option injection, reserved package paths, and canonical path escapes before installation", async () => {
		let unexpectedRuns = 0;
		const guardedRunner: ProcessRunner = {
			run: async () => {
				unexpectedRuns++;
				return processResult("", 1, "must not run");
			},
		};
		const guarded = await createManagementFixture({ processRunner: guardedRunner });
		for (const input of [
			{ source: "npm:legacy-marketplace" },
			{ source: "https://example.test/team.git", ref: "--upload-pack=malicious" },
			{ source: "https://example.test/team.git", sparse: ["../outside"] },
		]) {
			await expect(guarded.management.marketplaceAdd(input)).rejects.toThrow();
		}
		for (const sparse of [["packages/.CODEX-PLUGIN/plugin.json"], ["packages\\.CoDeX-PlUgIn\\plugin.json"]]) {
			await expect(
				guarded.management.marketplaceAdd({ source: "https://example.test/team.git", sparse }),
			).rejects.toThrow('Plugin Marketplace sparse paths must not select ".codex-plugin" content');
		}
		const reservedMarketplace = await temporaryDirectory();
		await writeRemoteMarketplace(reservedMarketplace, { sha: "a".repeat(40), path: ".CoDeX-PlUgIn" });
		await guarded.management.marketplaceAdd({ source: "local", root: reservedMarketplace });
		await expect(guarded.management.install("review-tools@remote-market")).rejects.toThrow(
			/Plugin is not available|Plugin package path is invalid/u,
		);
		expect(unexpectedRuns).toBe(0);

		const escapingMarketplace = await temporaryDirectory();
		const escapingRepository = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writePluginPackage(join(outside, "review-tools"), "1.0.0");
		await symlink(outside, join(escapingRepository, "packages"));
		await writeRemoteMarketplace(escapingMarketplace, { sha: "b".repeat(40) });
		const escapingGit = new FakeGitRunner([
			{ fixture: escapingRepository, revision: "b".repeat(40) },
			{ fixture: escapingRepository, revision: "b".repeat(40) },
		]);
		const escaping = await createManagementFixture({ processRunner: escapingGit });
		await escaping.management.marketplaceAdd({ source: "local", root: escapingMarketplace });

		await expect(escaping.management.install("review-tools@remote-market")).rejects.toThrow(
			/resolves outside its checkout/u,
		);
		expect((await escaping.management.snapshot()).plugins[0]).toMatchObject({ installed: false });
	});

	it("rejects lexical and canonical reserved Marketplace roots before probing their contents", async () => {
		const base = createNodeFileSystem();
		const lexicalRoot = join(await temporaryDirectory(), ".CODEX-PLUGIN", "marketplace");
		let lexicalRealpaths = 0;
		const lexical = await createManagementFixture({
			fileSystem: {
				...base,
				realpath: async (path) => {
					if (path.toLowerCase().includes(`${sep}.codex-plugin${sep}`)) lexicalRealpaths++;
					return base.realpath(path);
				},
			},
		});

		await expect(lexical.management.marketplaceAdd({ source: "local", root: lexicalRoot })).rejects.toThrow(
			/reserved \.codex-plugin path/u,
		);
		expect(lexicalRealpaths).toBe(0);

		const sourceRoot = await temporaryDirectory();
		await writeMarketplace(sourceRoot);
		let canonicalContentProbes = 0;
		const canonical = await createManagementFixture({
			fileSystem: {
				...base,
				realpath: async (path) =>
					path === sourceRoot ? join(sourceRoot, ".CoDeX-PlUgIn", "marketplace") : base.realpath(path),
				lstat: async (path) => {
					if (path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`)) canonicalContentProbes++;
					return base.lstat(path);
				},
				readDirectory: async (path) => {
					if (path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`)) canonicalContentProbes++;
					return base.readDirectory(path);
				},
				readFile: async (path) => {
					if (path === sourceRoot || path.startsWith(`${sourceRoot}${sep}`)) canonicalContentProbes++;
					return base.readFile(path);
				},
			},
		});

		await expect(canonical.management.marketplaceAdd({ source: "local", root: sourceRoot })).rejects.toThrow(
			/reserved \.codex-plugin path/u,
		);
		expect(canonicalContentProbes).toBe(0);
	});

	it("serializes concurrent mutations and returns one deterministic immutable projection", async () => {
		const sourceRoot = await temporaryDirectory();
		const marketplaceRoot = join(sourceRoot, ".agents", "plugins");
		await writePluginPackage(join(marketplaceRoot, "packages", "alpha-tools"), "1.0.0", "alpha-tools");
		await writePluginPackage(join(marketplaceRoot, "packages", "beta-tools"), "1.0.0", "beta-tools");
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "beta-tools", source: "./packages/beta-tools" },
					{ name: "alpha-tools", source: "./packages/alpha-tools" },
				],
			}),
		);
		const fixture = await createManagementFixture();
		await fixture.management.marketplaceAdd({ source: "local", root: sourceRoot });

		await Promise.all([
			fixture.management.install("beta-tools@team-market"),
			fixture.management.install("alpha-tools@team-market"),
		]);
		const first = await fixture.management.snapshot();
		const second = await fixture.restart().list();

		expect(first.plugins.map(({ pluginId, state }) => [pluginId, state])).toEqual([
			["alpha-tools@team-market", "enabled"],
			["beta-tools@team-market", "enabled"],
		]);
		expect(fixture.settings().plugins).toEqual({
			"alpha-tools@team-market": { enabled: true },
			"beta-tools@team-market": { enabled: true },
		});
		expect(second).toEqual(first);
		expect(Object.isFrozen(first.diagnostics)).toBe(true);

		const removed = await fixture.management.remove("alpha-tools@team-market");
		expect(removed.plugins.map(({ pluginId, state }) => [pluginId, state])).toEqual([
			["alpha-tools@team-market", "available"],
			["beta-tools@team-market", "enabled"],
		]);
		expect(fixture.settings().plugins).toEqual({ "beta-tools@team-market": { enabled: true } });
	});

	it("resolves an existing relative Marketplace path before treating owner/repository syntax as Git", async () => {
		const base = await temporaryDirectory();
		const sourceRoot = join(base, "team", "market");
		await writeMarketplace(sourceRoot);
		const { management } = await createManagementFixture({ marketplaceBaseDirectory: base });

		const snapshot = await management.marketplaceAdd({ source: "team/market", sparse: [] });

		expect(snapshot.marketplaces[0]).toMatchObject({
			name: "team-market",
			source: { source: "local" },
			status: "available",
		});
	});

	it("protects a real Git Marketplace checkout from legacy package subtrees", async () => {
		const repository = await temporaryDirectory();
		await writeMarketplace(repository, { marketplace: "git-market" });
		const legacyRoot = join(repository, ".agents", "plugins", "packages", "review-tools", ".CoDeX-PlUgIn");
		await mkdir(legacyRoot, { recursive: true });
		await writeFile(join(legacyRoot, "plugin.json"), JSON.stringify({ poisoned: true }));
		await runFixtureGit(repository, ["init", "--initial-branch=main"]);
		await runFixtureGit(repository, ["config", "user.email", "fixture@example.test"]);
		await runFixtureGit(repository, ["config", "user.name", "Fixture"]);
		await runFixtureGit(repository, ["add", "--all"]);
		await runFixtureGit(repository, ["commit", "-m", "marketplace fixture"]);
		const nodeRunner = createNodeProcessRunner({ platform: process.platform });
		const actualGit: ProcessRunner = {
			run: async (request) => {
				if (request.args[0] !== "clone") {
					return nodeRunner.run({ ...request, environment: hostEnvironment });
				}
				const args = [...request.args];
				const separator = args.indexOf("--");
				if (separator < 0) throw new Error("unsafe clone request");
				args[separator + 1] = pathToFileURL(repository).toString();
				return nodeRunner.run({ ...request, args, environment: hostEnvironment });
			},
		};
		const { management } = await createManagementFixture({ processRunner: actualGit });

		const snapshot = await management.marketplaceAdd({ source: "openai/portable-marketplace" });
		const entries = await readdir(
			join(snapshot.marketplaces[0]!.root, ".agents", "plugins", "packages", "review-tools"),
		);

		expect(entries.sort()).toEqual(["plugin.json"]);
		expect(await readdir(snapshot.marketplaces[0]!.root)).not.toContain(".git");
		expect(snapshot.plugins[0]).toMatchObject({ pluginId: "review-tools@git-market", state: "available" });
	});
});
