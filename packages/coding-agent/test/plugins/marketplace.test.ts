import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { AGENT_PLUGIN_SCHEMA } from "@coda/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { loadCodingPluginMarketplace } from "../../src/plugins/marketplace.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-plugin-marketplace-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin Marketplace", () => {
	it("rejects a Marketplace manifest larger than 1 MiB before reading it", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(join(marketplaceRoot, "marketplace.json"), " ".repeat(1024 * 1024 + 1));
		const marketplacePath = await realpath(join(marketplaceRoot, "marketplace.json"));
		const base = createNodeFileSystem();
		let manifestReads = 0;

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (path === marketplacePath) manifestReads++;
					return base.readFile(path);
				},
			},
		});

		expect(marketplace.status).toBe("rejected");
		expect(marketplace.entries).toEqual([]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-manifest-too-large",
				message: expect.stringContaining("1 MiB"),
			}),
		);
		expect(manifestReads).toBe(0);
	});

	it("rejects a Marketplace manifest when the bytes read exceed a lying stat size", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		const marketplacePath = join(marketplaceRoot, "marketplace.json");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(marketplacePath, "{}");
		const canonicalMarketplacePath = await realpath(marketplacePath);
		const base = createNodeFileSystem();
		let manifestReads = 0;

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: {
				...base,
				stat: async (path) => {
					const status = await base.stat(path);
					return path === canonicalMarketplacePath ? { ...status, size: 2 } : status;
				},
				readFile: async (path) => {
					if (path !== canonicalMarketplacePath) return base.readFile(path);
					manifestReads++;
					return new Uint8Array(1024 * 1024 + 1);
				},
			},
		});

		expect(marketplace.status).toBe("rejected");
		expect(marketplace.entries).toEqual([]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-manifest-too-large",
				message: expect.stringContaining("1048577 bytes"),
			}),
		);
		expect(manifestReads).toBe(1);
	});

	it("rejects more than 1024 Marketplace entries before probing any Plugin package", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "bounded-market",
				plugins: [
					{ name: "local-tools", source: "./packages/local-tools" },
					...Array.from({ length: 1024 }, (_, index) => ({
						name: `remote-${index}`,
						source: { source: "url", url: `https://example.test/remote-${index}.git` },
					})),
				],
			}),
		);
		const base = createNodeFileSystem();
		let packageProbes = 0;
		const rejectPackageProbe = (path: string): never => {
			packageProbes++;
			throw new Error(`Plugin package was probed: ${path}`);
		};

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: {
				...base,
				realpath: async (path) =>
					path.includes(`${sep}packages${sep}`) ? rejectPackageProbe(path) : base.realpath(path),
				stat: async (path) => (path.includes(`${sep}packages${sep}`) ? rejectPackageProbe(path) : base.stat(path)),
				readFile: async (path) =>
					path.includes(`${sep}packages${sep}`) ? rejectPackageProbe(path) : base.readFile(path),
			},
		});

		expect(marketplace.status).toBe("rejected");
		expect(marketplace.entries).toEqual([]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-entry-limit-exceeded",
				message: expect.stringMatching(/1025 entries.*limit is 1024/u),
			}),
		);
		expect(packageProbes).toBe(0);
	});

	it("loads exactly 1024 Marketplace entries", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "bounded-market",
				plugins: Array.from({ length: 1024 }, (_, index) => ({
					name: `remote-${index}`,
					source: { source: "url", url: `https://example.test/remote-${index}.git` },
				})),
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({ root, fileSystem: createNodeFileSystem() });

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries).toHaveLength(1024);
		expect(marketplace.diagnostics).toEqual([]);
	});

	it.each(["lexical", "canonical-alias"] as const)(
		"rejects a %s configured root below .codex-plugin without probing its subtree",
		async (kind) => {
			const parent = await temporaryDirectory();
			const reservedRoot = join(parent, ".codex-plugin", "nested-marketplace");
			await mkdir(join(reservedRoot, ".agents", "plugins"), { recursive: true });
			await writeFile(
				join(reservedRoot, ".agents", "plugins", "marketplace.json"),
				JSON.stringify({ name: "must-not-load", plugins: [] }),
			);
			const configuredRoot = kind === "lexical" ? reservedRoot : join(parent, "portable-looking");
			if (kind === "canonical-alias") await symlink(reservedRoot, configuredRoot, "dir");
			const base = createNodeFileSystem();
			let forbiddenProbes = 0;
			const forbidden = (path: string): boolean =>
				path === reservedRoot ||
				path.startsWith(`${reservedRoot}${sep}`) ||
				path.startsWith(`${configuredRoot}${sep}`) ||
				(kind === "lexical" && path === configuredRoot);
			const rejectForbidden = (path: string): never => {
				forbiddenProbes++;
				throw new Error(`reserved Marketplace subtree was probed: ${path}`);
			};

			const marketplace = await loadCodingPluginMarketplace({
				root: configuredRoot,
				fileSystem: {
					...base,
					realpath: async (path) =>
						kind === "canonical-alias" && path === configuredRoot
							? base.realpath(path)
							: forbidden(path)
								? rejectForbidden(path)
								: base.realpath(path),
					stat: async (path) => (forbidden(path) ? rejectForbidden(path) : base.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectForbidden(path) : base.lstat(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectForbidden(path) : base.readDirectory(path)),
					readFile: async (path) => (forbidden(path) ? rejectForbidden(path) : base.readFile(path)),
				},
			});

			expect(marketplace.status).toBe("rejected");
			expect(forbiddenProbes).toBe(0);
		},
	);

	it("loads a contained local Agent Plugin under a stable marketplace identity", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		const pluginRoot = join(marketplaceRoot, "packages", "review-tools");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools", version: "1.2.3" }),
		);
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team_market",
				plugins: [{ name: "review-tools", source: "./packages/review-tools" }],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace).toEqual({
			status: "loaded",
			name: "team_market",
			root: await realpath(marketplaceRoot),
			entries: [
				{
					pluginId: "review-tools@team_market",
					name: "review-tools",
					marketplace: "team_market",
					source: {
						source: "local",
						path: "./packages/review-tools",
						root: await realpath(pluginRoot),
					},
				},
			],
			diagnostics: [],
		});
		expect(Object.isFrozen(marketplace)).toBe(true);
		expect(Object.isFrozen(marketplace.entries)).toBe(true);
		expect(Object.isFrozen(marketplace.entries[0]?.source)).toBe(true);
	});

	it("does not probe a Codex-only manifest while loading a sibling local source object", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		const legacyRoot = join(marketplaceRoot, "packages", "legacy-tools");
		const pluginRoot = join(marketplaceRoot, "packages", "review-tools");
		await mkdir(join(legacyRoot, ".codex-plugin"), { recursive: true });
		await writeFile(join(legacyRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "legacy-tools" }));
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "review-tools" }),
		);
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "legacy-tools", source: { source: "local", path: "./packages/legacy-tools" } },
					{ name: "review-tools", source: { source: "local", path: "./packages/review-tools" } },
				],
			}),
		);

		const baseFileSystem = createNodeFileSystem();
		let legacyAccesses = 0;
		const rejectLegacyAccess = (path: string): void => {
			if (!path.includes(`${sep}.codex-plugin${sep}`)) return;
			legacyAccesses++;
			throw new Error("legacy Codex manifests must not be probed");
		};
		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: {
				...baseFileSystem,
				realpath: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.realpath(path);
				},
				stat: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.stat(path);
				},
				readFile: async (path) => {
					rejectLegacyAccess(path);
					return baseFileSystem.readFile(path);
				},
			},
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries).toEqual([
			{
				pluginId: "review-tools@team-market",
				name: "review-tools",
				marketplace: "team-market",
				source: {
					source: "local",
					path: "./packages/review-tools",
					root: await realpath(pluginRoot),
				},
			},
		]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-package-invalid",
				entryIndex: 0,
				pluginId: "legacy-tools@team-market",
			}),
		);
		expect(legacyAccesses).toBe(0);
	});

	it.each(["lexical", "canonical-alias"] as const)(
		"skips a %s local source below .codex-plugin without probing the package",
		async (kind) => {
			const root = await temporaryDirectory();
			const marketplaceRoot = join(root, ".agents", "plugins");
			const reservedRoot = join(marketplaceRoot, "packages", ".codex-plugin", "nested");
			await mkdir(reservedRoot, { recursive: true });
			await writeFile(
				join(reservedRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "reserved-tools" }),
			);
			const alias = join(marketplaceRoot, "packages", "portable-looking");
			if (kind === "canonical-alias") await symlink(reservedRoot, alias, "dir");
			await writeFile(
				join(marketplaceRoot, "marketplace.json"),
				JSON.stringify({
					name: "team-market",
					plugins: [
						{
							name: "reserved-tools",
							source: kind === "lexical" ? "./packages/.codex-plugin/nested" : "./packages/portable-looking",
						},
					],
				}),
			);
			const canonicalReservedRoot = await realpath(reservedRoot);
			const base = createNodeFileSystem();
			let packageProbes = 0;
			const forbidden = (path: string): boolean =>
				path === canonicalReservedRoot ||
				path.startsWith(`${canonicalReservedRoot}${sep}`) ||
				path.includes(`${sep}.codex-plugin${sep}`);
			const rejectReserved = (path: string): never => {
				packageProbes++;
				throw new Error(`reserved local package was probed: ${path}`);
			};

			const marketplace = await loadCodingPluginMarketplace({
				root,
				fileSystem: {
					...base,
					realpath: async (path) =>
						kind === "canonical-alias" && path === alias
							? base.realpath(path)
							: forbidden(path)
								? rejectReserved(path)
								: base.realpath(path),
					stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
					lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
					readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
				},
			});

			expect(marketplace.status).toBe("loaded");
			expect(marketplace.entries).toEqual([]);
			expect(marketplace.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "plugin-marketplace-package-invalid",
					pluginId: "reserved-tools@team-market",
				}),
			);
			expect(packageProbes).toBe(0);
		},
	);

	it("normalizes safe Git and Git subdirectory sources without cloning them", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "remote-market",
				plugins: [
					{
						name: "docs-tools",
						source: {
							source: "url",
							url: "HTTPS://GitHub.COM/openai/docs-tools.git",
							ref: "refs/tags/v1.0.0",
							sha: "A".repeat(40),
						},
					},
					{
						name: "review-tools",
						source: {
							source: "git-subdir",
							url: "https://github.com/acme/plugins.git",
							path: "./plugins/review-tools",
							ref: "main",
						},
					},
				],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries).toEqual([
			{
				pluginId: "docs-tools@remote-market",
				name: "docs-tools",
				marketplace: "remote-market",
				source: {
					source: "url",
					url: "https://github.com/openai/docs-tools.git",
					ref: "refs/tags/v1.0.0",
					sha: "a".repeat(40),
				},
			},
			{
				pluginId: "review-tools@remote-market",
				name: "review-tools",
				marketplace: "remote-market",
				source: {
					source: "git-subdir",
					url: "https://github.com/acme/plugins.git",
					path: "plugins/review-tools",
					ref: "main",
				},
			},
		]);
		expect(marketplace.diagnostics).toEqual([]);
	});

	it("rejects unsafe Git selectors and unsupported npm sources without losing a safe sibling", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "remote-market",
				plugins: [
					{ name: "npm-tools", source: { source: "npm", package: "@acme/tools" } },
					{ name: "file-tools", source: { source: "url", url: "file:///tmp/tools.git" } },
					{
						name: "escape-tools",
						source: {
							source: "git-subdir",
							url: "https://github.com/acme/plugins.git",
							path: "../../outside",
						},
					},
					{
						name: "option-tools",
						source: { source: "url", url: "https://github.com/acme/options.git", ref: "-c core.fsmonitor=1" },
					},
					{
						name: "query-tools",
						source: { source: "url", url: "https://github.com/acme/query.git?depth=1" },
					},
					{
						name: "sha-tools",
						source: { source: "url", url: "https://github.com/acme/sha.git", sha: "deadbeef" },
					},
					{ name: "safe-tools", source: { source: "url", url: "https://github.com/acme/safe.git" } },
				],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries.map(({ pluginId }) => pluginId)).toEqual(["safe-tools@remote-market"]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-source-unsupported",
				pluginId: "npm-tools@remote-market",
			}),
		);
		expect(
			marketplace.diagnostics.filter(({ code }) => code === "plugin-marketplace-git-source-invalid"),
		).toHaveLength(5);
	});

	it("keeps the first valid source when a Marketplace repeats one PluginId", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "review-tools", source: { source: "url", url: "https://example.test/first.git" } },
					{ name: "review-tools", source: { source: "url", url: "https://example.test/second.git" } },
				],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries).toEqual([
			{
				pluginId: "review-tools@team-market",
				name: "review-tools",
				marketplace: "team-market",
				source: { source: "url", url: "https://example.test/first.git" },
			},
		]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-duplicate-id",
				entryIndex: 1,
				pluginId: "review-tools@team-market",
			}),
		);
	});

	it("isolates lexical and symlink escapes from the Marketplace root", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		const outsideRoot = join(root, "outside-tools");
		const safeRoot = join(marketplaceRoot, "packages", "safe-tools");
		await mkdir(outsideRoot, { recursive: true });
		await writeFile(
			join(outsideRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "symlink-tools" }),
		);
		await mkdir(join(marketplaceRoot, "packages"), { recursive: true });
		await symlink(outsideRoot, join(marketplaceRoot, "packages", "symlink-tools"));
		await mkdir(safeRoot, { recursive: true });
		await writeFile(
			join(safeRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "safe-tools" }),
		);
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "lexical-tools", source: "./../outside-tools" },
					{ name: "symlink-tools", source: "./packages/symlink-tools" },
					{ name: "safe-tools", source: "./packages/safe-tools" },
				],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries.map(({ pluginId }) => pluginId)).toEqual(["safe-tools@team-market"]);
		expect(
			marketplace.diagnostics.filter(({ code }) => code === "plugin-marketplace-local-source-outside-root"),
		).toHaveLength(2);
	});

	it("rejects a decoy manifest outside the fixed Marketplace location", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(join(root, "marketplace.json"), JSON.stringify({ name: "decoy-market", plugins: [] }));

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace).toEqual({
			status: "rejected",
			root: await realpath(marketplaceRoot),
			entries: [],
			diagnostics: [
				expect.objectContaining({
					code: "plugin-marketplace-manifest-unreadable",
					path: join(marketplaceRoot, "marketplace.json"),
				}),
			],
		});
		expect("name" in marketplace).toBe(false);
		expect(Object.isFrozen(marketplace.entries)).toBe(true);
	});

	it("rejects an invalid Marketplace name before exposing entries", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		await mkdir(marketplaceRoot, { recursive: true });
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({ name: "invalid.market", plugins: [] }),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("rejected");
		expect(marketplace.entries).toEqual([]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-marketplace-manifest-invalid" }),
		);
	});

	it.each(["workspace-local", "user-local"])(
		"reserves the %s identity for direct Agent Plugin installations",
		async (name) => {
			const root = await temporaryDirectory();
			const marketplaceRoot = join(root, ".agents", "plugins");
			await mkdir(marketplaceRoot, { recursive: true });
			await writeFile(join(marketplaceRoot, "marketplace.json"), JSON.stringify({ name, plugins: [] }));

			const marketplace = await loadCodingPluginMarketplace({
				root,
				fileSystem: createNodeFileSystem(),
			});

			expect(marketplace.status).toBe("rejected");
			expect(marketplace.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "plugin-marketplace-name-reserved",
					message: expect.stringContaining(name),
				}),
			);
		},
	);

	it("isolates an entry whose declared name does not match its Agent Plugin manifest", async () => {
		const root = await temporaryDirectory();
		const marketplaceRoot = join(root, ".agents", "plugins");
		const mismatchedRoot = join(marketplaceRoot, "packages", "mismatched");
		const safeRoot = join(marketplaceRoot, "packages", "safe-tools");
		await mkdir(mismatchedRoot, { recursive: true });
		await writeFile(
			join(mismatchedRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "actual-tools" }),
		);
		await mkdir(safeRoot, { recursive: true });
		await writeFile(
			join(safeRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "safe-tools" }),
		);
		await writeFile(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({
				name: "team-market",
				plugins: [
					{ name: "claimed-tools", source: "./packages/mismatched" },
					{ name: "InvalidName", source: { source: "url", url: "https://example.test/invalid.git" } },
					{ name: "safe-tools", source: "./packages/safe-tools" },
				],
			}),
		);

		const marketplace = await loadCodingPluginMarketplace({
			root,
			fileSystem: createNodeFileSystem(),
		});

		expect(marketplace.status).toBe("loaded");
		expect(marketplace.entries.map(({ pluginId }) => pluginId)).toEqual(["safe-tools@team-market"]);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-marketplace-package-invalid",
				pluginId: "claimed-tools@team-market",
			}),
		);
		expect(marketplace.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-marketplace-entry-invalid", entryIndex: 1 }),
		);
	});
});
