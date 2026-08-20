import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import type {
	CodingPluginInstallationRecord,
	CodingPluginInstallationStore,
} from "../../src/plugins/installation-store.ts";
import { createCodingPluginInstallationStore } from "../../src/plugins/installation-store.ts";
import {
	createCodingPluginsManager,
	discoverCodingPlugins,
	materializeCodingPluginMcpDefinitions,
} from "../../src/plugins/inventory.ts";
import type { CodingPluginId } from "../../src/plugins/types.ts";

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-coding-plugins-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function writePlugin(parent: string, slot: string, name: string): Promise<string> {
	const root = join(parent, ".agents", "plugins", slot);
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name }));
	return root;
}

async function writeManagedPlugin(parent: string, name: string): Promise<string> {
	const root = join(parent, name);
	await mkdir(join(root, "skills", "review"), { recursive: true });
	await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name, version: "1.2.3" }));
	await writeFile(
		join(root, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Review changes\n---\n\nReview changes.\n",
	);
	await writeFile(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
		}),
	);
	return root;
}

function managedInstallation(
	selectedRoot: string,
	name = "managed-tools",
	marketplace = "team-market",
): CodingPluginInstallationRecord {
	return Object.freeze({
		pluginId: `${name}@${marketplace}` as CodingPluginId,
		name,
		marketplace,
		version: "1.2.3",
		digest: "a".repeat(64),
		revision: "b".repeat(64),
		source: Object.freeze({ source: "url" as const, url: "https://example.test/managed-tools.git" }),
		selectedRoot,
	});
}

const acceptManagedInstallation: CodingPluginInstallationStore["verify"] = async (record) =>
	Object.freeze({ status: "verified" as const, record });

function createManagedStore(root: string, fileSystem = createNodeFileSystem()): CodingPluginInstallationStore {
	let nextId = 0;
	return createCodingPluginInstallationStore({
		root,
		fileSystem,
		idGenerator: { generate: () => `inventory-${++nextId}` },
	});
}

async function installManaged(store: CodingPluginInstallationStore, packageRoot: string, name = "managed-tools") {
	return store.install({
		entry: {
			pluginId: `${name}@team-market` as CodingPluginId,
			name,
			marketplace: "team-market",
			source: { source: "local", path: `./${name}`, root: packageRoot },
		},
		packageRoot,
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin inventory", () => {
	it("admits a managed name@marketplace installation into the same Skill and MCP inventory", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const selectedRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
			managedInstallations: [managedInstallation(selectedRoot)],
			verifyManagedInstallation: acceptManagedInstallation,
		});

		expect(inventory.installations).toHaveLength(1);
		expect(inventory.plugins[0]).toMatchObject({
			installationId: "managed-tools@team-market",
			source: "team-market",
			enabled: true,
			origin: {
				scope: "user",
				slot: "managed-tools@team-market",
				pluginName: "managed-tools",
				sourceLabel: "managed-tools@team-market",
			},
		});
		expect(inventory.skills[0]?.candidates[0]?.provenance[0]?.origin).toMatchObject({
			pluginName: "managed-tools",
		});
		expect(inventory.mcpSources).toEqual([
			expect.objectContaining({
				requiresWorkspaceTrust: false,
				servers: [expect.objectContaining({ id: "plugin_managed-tools_docs", name: "docs" })],
			}),
		]);
		expect(inventory.plugins[0]?.dataDirectory).toMatch(/plugin-data/u);
	});

	it.each(["skill", "mcp"] as const)(
		"rejects a still-valid managed %s mutation before it contributes any capability",
		async (component) => {
			const workspace = await temporaryDirectory();
			const userHome = await temporaryDirectory();
			const packageRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");
			const storeRoot = join(await temporaryDirectory(), "installations");
			const installed = await installManaged(createManagedStore(storeRoot), packageRoot);
			if (component === "skill") {
				await writeFile(
					join(installed.selectedRoot, "skills", "review", "SKILL.md"),
					"---\nname: review\ndescription: Mutated but valid review workflow\n---\n\nMutated review.\n",
				);
			} else {
				await writeFile(
					join(installed.selectedRoot, "mcp.json"),
					JSON.stringify({
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: { docs: { type: "streamable-http", url: "https://changed.example.test/mcp" } },
					}),
				);
			}
			const verified = await createManagedStore(storeRoot).listVerified();

			const inventory = await discoverCodingPlugins({
				workspace,
				userHome,
				dataRoot: join(await temporaryDirectory(), "plugin-data"),
				fileSystem: createNodeFileSystem(),
				managedInstallations: verified.installations,
				managedInstallationVerifications: verified.verifications,
			});

			expect(inventory.installations).toEqual([]);
			expect(inventory.plugins).toEqual([]);
			expect(inventory.skills).toEqual([]);
			expect(inventory.mcpSources).toEqual([]);
			expect(inventory.diagnostics).toContainEqual(
				expect.objectContaining({ code: "plugin-installation-digest-mismatch" }),
			);
		},
	);

	it("rejects a managed selected-root symlink before any external package probe or capability admission", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const packageRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");
		const storeRoot = join(await temporaryDirectory(), "installations");
		const installed = await installManaged(createManagedStore(storeRoot), packageRoot);
		const outsideRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");
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
		let forbiddenPackageProbes = 0;
		const forbidden = (path: string): boolean =>
			path === outsideRoot ||
			path.startsWith(`${outsideRoot}${sep}`) ||
			path === installed.selectedRoot ||
			path.startsWith(`${installed.selectedRoot}${sep}`);
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
		const verified = await createManagedStore(storeRoot, fileSystem).listVerified();

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem,
			managedInstallations: verified.installations,
			managedInstallationVerifications: verified.verifications,
		});

		expect(forbiddenPackageProbes).toBe(0);
		expect(inventory.installations).toEqual([]);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.skills).toEqual([]);
		expect(inventory.mcpSources).toEqual([]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-installation-root-invalid" }),
		);
	});

	it("publishes a complete old or new managed revision when verification overlaps an upgrade", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const packageRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");
		const storeRoot = join(await temporaryDirectory(), "installations");
		const base = createNodeFileSystem();
		let blockRoot: string | undefined;
		let releaseVerification!: () => void;
		let reportVerification!: () => void;
		const verificationStarted = new Promise<void>((resolve) => {
			reportVerification = resolve;
		});
		const verificationGate = new Promise<void>((resolve) => {
			releaseVerification = resolve;
		});
		let blocked = false;
		const store = createManagedStore(storeRoot, {
			...base,
			readFile: async (path) => {
				if (!blocked && blockRoot && path.startsWith(`${blockRoot}${sep}`)) {
					blocked = true;
					reportVerification();
					await verificationGate;
				}
				return base.readFile(path);
			},
		});
		const first = await installManaged(store, packageRoot);
		blockRoot = first.selectedRoot;
		await writeFile(
			join(packageRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "managed-tools", version: "2.0.0" }),
		);
		const oldSnapshotPromise = store.listVerified();
		await verificationStarted;
		const upgradedPromise = installManaged(store, packageRoot);
		releaseVerification();
		const oldSnapshot = await oldSnapshotPromise;
		const upgraded = await upgradedPromise;
		const newSnapshot = await store.listVerified();
		const discover = (snapshot: Awaited<ReturnType<CodingPluginInstallationStore["listVerified"]>>) =>
			discoverCodingPlugins({
				workspace,
				userHome,
				dataRoot: join(storeRoot, "plugin-data"),
				fileSystem: base,
				managedInstallations: snapshot.installations,
				managedInstallationVerifications: snapshot.verifications,
			});

		const [oldInventory, newInventory] = await Promise.all([discover(oldSnapshot), discover(newSnapshot)]);
		expect(oldSnapshot.installations[0]?.selectedRoot).toBe(first.selectedRoot);
		expect(newSnapshot.installations[0]?.selectedRoot).toBe(upgraded.selectedRoot);
		expect(oldInventory.plugins).toHaveLength(1);
		expect(newInventory.plugins).toHaveLength(1);
		expect(oldInventory.plugins[0]?.snapshot.manifest.version).toBe("1.2.3");
		expect(newInventory.plugins[0]?.snapshot.manifest.version).toBe("2.0.0");
	});

	it("rejects a managed pseudo-Marketplace identity without shadowing the direct installation", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		await writePlugin(workspace, "direct-tools", "direct-tools");
		const managedRoot = await writeManagedPlugin(await temporaryDirectory(), "direct-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
			managedInstallations: [managedInstallation(managedRoot, "direct-tools", "workspace-local")],
			verifyManagedInstallation: acceptManagedInstallation,
		});

		expect(inventory.installations).toEqual([
			expect.objectContaining({
				installationId: "direct-tools@workspace-local",
				source: "workspace-local",
				origin: expect.objectContaining({ slot: "direct-tools", scope: "workspace" }),
			}),
		]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-installation-identity-reserved" }),
		);
	});

	it("applies persisted enablement to managed installations without falling back by namespace", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const managedRoot = await writeManagedPlugin(await temporaryDirectory(), "shared-tools");
		await writePlugin(userHome, "local-copy", "shared-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
			managedInstallations: [managedInstallation(managedRoot, "shared-tools")],
			verifyManagedInstallation: acceptManagedInstallation,
			enablement: { "shared-tools@user-local": { enabled: false } },
		});

		expect(inventory.installations.map(({ installationId, enabled }) => [installationId, enabled])).toEqual([
			["shared-tools@team-market", true],
			["shared-tools@user-local", false],
		]);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-namespace-collision", pluginName: "shared-tools" }),
		);
	});

	it("rejects a managed cache whose manifest no longer matches its installation identity", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const selectedRoot = await writeManagedPlugin(await temporaryDirectory(), "other-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
			managedInstallations: [managedInstallation(selectedRoot, "managed-tools")],
			verifyManagedInstallation: acceptManagedInstallation,
		});

		expect(inventory.installations).toEqual([]);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.snapshots).toEqual([
			expect.objectContaining({ status: "rejected", requestedRoot: selectedRoot }),
		]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-installation-manifest-mismatch",
				message: expect.stringContaining("managed-tools@team-market"),
			}),
		);
	});

	it("serializes overlapping refreshes so the later scan remains current", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "tools", "old-tools");
		const base = createNodeFileSystem();
		let reads = 0;
		let releaseFirst!: () => void;
		let reportFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			reportFirstStarted = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const manager = createCodingPluginsManager({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: {
				...base,
				readFile: async (path) => {
					const bytes = await base.readFile(path);
					if (path.endsWith("plugin.json")) {
						reads++;
						if (reads === 1) {
							reportFirstStarted();
							await firstGate;
						}
					}
					return bytes;
				},
			},
		});

		const first = manager.refresh();
		await firstStarted;
		await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "new-tools" }));
		const second = manager.refresh();
		expect(reads).toBe(1);
		releaseFirst();

		expect((await first).plugins[0]?.snapshot.manifest.name).toBe("old-tools");
		expect((await second).plugins[0]?.snapshot.manifest.name).toBe("new-tools");
		expect(manager.current?.plugins[0]?.snapshot.manifest.name).toBe("new-tools");
	});

	it("updates and clears managed installations through serialized manager refreshes", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const selectedRoot = await writeManagedPlugin(await temporaryDirectory(), "managed-tools");
		const manager = createCodingPluginsManager({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
			verifyManagedInstallation: acceptManagedInstallation,
		});

		expect((await manager.refresh()).plugins).toEqual([]);
		expect(
			(await manager.refresh({ managedInstallations: [managedInstallation(selectedRoot)] })).plugins[0]
				?.installationId,
		).toBe("managed-tools@team-market");
		expect((await manager.refresh({ managedInstallations: [] })).plugins).toEqual([]);
		expect(manager.current?.plugins).toEqual([]);
	});

	it("retains a direct Plugin's canonical installation identity when its package becomes invalid", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "renamed-slot", "canonical-tools");
		const manager = createCodingPluginsManager({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
		});

		const valid = await manager.refresh();
		expect(valid.installations[0]?.installationId).toBe("canonical-tools@workspace-local");
		await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "canonical-tools" }));

		const invalid = await manager.refresh();
		expect(invalid.snapshots[0]).toMatchObject({
			status: "rejected",
			origin: {
				slot: "renamed-slot",
				installationId: "canonical-tools@workspace-local",
				pluginName: "canonical-tools",
			},
		});
		expect(invalid.diagnostics).toContainEqual(
			expect.objectContaining({
				origin: expect.objectContaining({ installationId: "canonical-tools@workspace-local" }),
			}),
		);
	});

	it("applies disable and cleared enablement updates inside one live manager", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "tools", "portable-tools");
		await mkdir(join(root, "skills", "review"), { recursive: true });
		await writeFile(
			join(root, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\n\nReview changes.\n",
		);
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);
		const manager = createCodingPluginsManager({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
		});

		const enabled = await manager.refresh();
		expect(enabled.plugins).toHaveLength(1);
		expect(enabled.skills).toHaveLength(1);
		expect(enabled.mcpSources).toHaveLength(1);

		const disabled = await manager.refresh({
			enablement: { "portable-tools@workspace-local": { enabled: false } },
		});
		expect(disabled.installations[0]?.enabled).toBe(false);
		expect(disabled.plugins).toEqual([]);
		expect(disabled.skills).toEqual([]);
		expect(disabled.mcpSources).toEqual([]);

		const reenabled = await manager.refresh({ enablement: {} });
		expect(reenabled.installations[0]?.enabled).toBe(true);
		expect(reenabled.plugins).toHaveLength(1);
		expect(reenabled.skills).toHaveLength(1);
		expect(reenabled.mcpSources).toHaveLength(1);
		expect(manager.current).toBe(reenabled);
	});

	it("treats inaccessible optional discovery parents as empty sources", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const nodeFileSystem = createNodeFileSystem();

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: {
				...nodeFileSystem,
				readDirectory: async (path) => {
					if (path.endsWith("/.agents/plugins")) {
						throw Object.assign(new Error("permission denied"), { code: "EACCES" });
					}
					return nodeFileSystem.readDirectory(path);
				},
			},
		});

		expect(inventory.plugins).toEqual([]);
		expect(inventory.diagnostics).toEqual([]);
	});

	it("discovers same-named slots as distinct installations when their manifest namespaces differ", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		await writePlugin(workspace, "same", "workspace-winner");
		await writePlugin(workspace, "zeta", "zeta");
		await writePlugin(userHome, "same", "user-shadowed");
		await writePlugin(userHome, "alpha", "alpha");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(
			inventory.plugins.map(({ slot, origin, snapshot }) => [slot, origin.scope, snapshot.manifest.name]),
		).toEqual([
			["alpha", "user", "alpha"],
			["same", "user", "user-shadowed"],
			["same", "workspace", "workspace-winner"],
			["zeta", "workspace", "zeta"],
		]);
		expect(inventory.installations.map(({ installationId, origin }) => [installationId, origin.scope])).toEqual([
			["alpha@user-local", "user"],
			["user-shadowed@user-local", "user"],
			["workspace-winner@workspace-local", "workspace"],
			["zeta@workspace-local", "workspace"],
		]);
	});

	it("never reads a reserved .codex-plugin directory directly or through a canonical symlink", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		await writePlugin(workspace, ".codex-plugin", "must-not-load-directly");
		const linkedLegacyRoot = join(workspace, "targets", ".codex-plugin");
		await mkdir(linkedLegacyRoot, { recursive: true });
		await writeFile(
			join(linkedLegacyRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load-through-symlink" }),
		);
		const alias = join(workspace, ".agents", "plugins", "legacy-alias");
		await symlink(linkedLegacyRoot, alias);
		const base = createNodeFileSystem();
		const forbiddenSuffix = `${sep}.codex-plugin${sep}plugin.json`;

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (path.endsWith(forbiddenSuffix)) throw new Error(`Legacy manifest was read: ${path}`);
					return base.readFile(path);
				},
			},
		});

		expect(inventory.plugins).toEqual([]);
		expect(inventory.installations).toEqual([]);
	});

	it.each([
		["workspace", ".codex-plugin", "canonical-alias"],
		["user", ".CODEX-PLUGIN", "canonical-alias"],
		["workspace", ".CODEX-PLUGIN", "lexical-parent"],
		["user", ".codex-plugin", "lexical-parent"],
	] as const)(
		"rejects a %s discovery root whose %s component is reserved (%s) before enumerating its contents",
		async (scope, reservedName, kind) => {
			const parent = await temporaryDirectory();
			const ordinaryWorkspace = join(parent, "workspace");
			const ordinaryUserHome = join(parent, "home");
			const selectedBase = scope === "workspace" ? ordinaryWorkspace : ordinaryUserHome;
			const selectedRoot = kind === "lexical-parent" ? join(parent, reservedName, scope) : selectedBase;
			const workspace = scope === "workspace" ? selectedRoot : ordinaryWorkspace;
			const userHome = scope === "user" ? selectedRoot : ordinaryUserHome;
			const discoveryRoot = join(selectedRoot, ".agents", "plugins");
			const reservedRoot = kind === "canonical-alias" ? join(selectedRoot, reservedName) : discoveryRoot;
			await mkdir(join(reservedRoot, "forbidden"), { recursive: true });
			await writeFile(
				join(reservedRoot, "forbidden", "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load" }),
			);
			if (kind === "canonical-alias") {
				await mkdir(dirname(discoveryRoot), { recursive: true });
				await symlink(reservedRoot, discoveryRoot, "dir");
			}
			const ordinarySource = scope === "workspace" ? userHome : workspace;
			await writePlugin(ordinarySource, "ordinary", "ordinary-plugin");
			const base = createNodeFileSystem();
			let forbiddenContentProbes = 0;
			const isForbiddenContent = (path: string): boolean =>
				path === discoveryRoot ||
				path.startsWith(`${discoveryRoot}${sep}`) ||
				path === reservedRoot ||
				path.startsWith(`${reservedRoot}${sep}`);
			const rejectForbiddenContent = (path: string): never => {
				forbiddenContentProbes++;
				throw new Error(`reserved Plugin discovery root content was probed: ${path}`);
			};

			const inventory = await discoverCodingPlugins({
				workspace,
				userHome,
				dataRoot: join(await temporaryDirectory(), "plugin-data"),
				fileSystem: {
					...base,
					stat: async (path) => (isForbiddenContent(path) ? rejectForbiddenContent(path) : base.stat(path)),
					lstat: async (path) => (isForbiddenContent(path) ? rejectForbiddenContent(path) : base.lstat(path)),
					readFile: async (path) =>
						isForbiddenContent(path) ? rejectForbiddenContent(path) : base.readFile(path),
					readDirectory: async (path) =>
						isForbiddenContent(path) ? rejectForbiddenContent(path) : base.readDirectory(path),
				},
			});

			expect(forbiddenContentProbes).toBe(0);
			expect(inventory.plugins.map(({ snapshot }) => snapshot.manifest.name)).toEqual(["ordinary-plugin"]);
			expect(inventory.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "plugin-discovery-root-unsupported",
					phase: "discover",
					path: discoveryRoot,
					severity: "warning",
				}),
			);
		},
	);

	it("never reads a direct Plugin symlink that resolves below a nested .codex-plugin component", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const nestedLegacyRoot = join(workspace, "targets", ".codex-plugin", "nested", "portable-looking");
		await mkdir(nestedLegacyRoot, { recursive: true });
		await writeFile(
			join(nestedLegacyRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-load-through-nested-symlink" }),
		);
		await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
		await symlink(nestedLegacyRoot, join(workspace, ".agents", "plugins", "legacy-nested-alias"));
		const base = createNodeFileSystem();
		let forbiddenReads = 0;

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: {
				...base,
				readFile: async (path) => {
					if (path.includes(`${sep}.codex-plugin${sep}`)) forbiddenReads++;
					return base.readFile(path);
				},
			},
		});

		expect(forbiddenReads).toBe(0);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.installations).toEqual([]);
	});

	it("bounds deterministic installation-slot discovery", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		await writePlugin(workspace, "alpha", "alpha");
		await writePlugin(workspace, "zeta", "zeta");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
			maxPluginSlots: 1,
		});

		expect(inventory.plugins.map(({ slot }) => slot)).toEqual(["alpha"]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-slot-limit-exceeded", severity: "error" }),
		);
	});

	it("exposes portable component snapshots and exact Workspace MCP trust metadata without creating data", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const root = await writePlugin(workspace, "tools", "portable-tools");
		const mcp = JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				docs: { type: "streamable-http", url: "https://example.test/mcp" },
			},
		});
		await writeFile(join(root, "mcp.json"), mcp);
		await mkdir(join(root, "skills", "review"), { recursive: true });
		await writeFile(
			join(root, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\n\nReview the changes.\n",
		);

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.skills).toEqual([inventory.plugins[0]!.snapshot.skills]);
		expect(inventory.skills[0]?.candidates[0]?.provenance[0]?.origin).toMatchObject({
			pluginName: "portable-tools",
			kind: "plugin",
		});
		const configurationPath = inventory.plugins[0]!.snapshot.mcpConfiguration?.path;
		expect(inventory.mcpSources).toEqual([
			expect.objectContaining({
				plugin: inventory.plugins[0],
				path: configurationPath,
				requiresWorkspaceTrust: true,
				trustSource: {
					workspace,
					path: configurationPath,
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
				},
				servers: [
					expect.objectContaining({
						id: "plugin_portable-tools_docs",
						name: "docs",
						type: "streamable-http",
					}),
				],
			}),
		]);
		await expect(lstat(inventory.plugins[0]!.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(Object.isFrozen(inventory.mcpSources[0]?.servers)).toBe(true);
	});

	it("keeps Workspace Plugin identity stable while isolating PLUGIN_DATA by canonical Workspace instance", async () => {
		const firstWorkspace = await temporaryDirectory();
		const secondWorkspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		for (const [workspace, slot, version] of [
			[firstWorkspace, "first-slot", "1.0.0"],
			[secondWorkspace, "moved-slot", "2.0.0"],
		] as const) {
			const root = await writePlugin(workspace, slot, "portable-tools");
			await writeFile(
				join(root, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable-tools", version }),
			);
			await writeFile(
				join(root, "mcp.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
					mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
				}),
			);
		}

		const [first, second] = await Promise.all([
			discoverCodingPlugins({
				workspace: firstWorkspace,
				userHome,
				dataRoot,
				fileSystem: createNodeFileSystem(),
			}),
			discoverCodingPlugins({
				workspace: secondWorkspace,
				userHome,
				dataRoot,
				fileSystem: createNodeFileSystem(),
			}),
		]);

		expect(first.plugins[0]?.dataDirectory).not.toBe(second.plugins[0]?.dataDirectory);
		expect(first.plugins[0]).toMatchObject({
			installationId: "portable-tools@workspace-local",
			source: "workspace-local",
			enabled: true,
		});
		expect(second.plugins[0]?.installationId).toBe(first.plugins[0]?.installationId);
		expect(first.mcpSources[0]?.servers[0]?.id).toBe("plugin_portable-tools_docs");
		expect(second.mcpSources[0]?.servers[0]?.id).toBe("plugin_portable-tools_docs");

		const targets = join(firstWorkspace, "plugin-targets");
		const firstTarget = join(targets, "first");
		const secondTarget = join(targets, "second");
		const initialSlot = join(firstWorkspace, ".agents", "plugins", "first-slot");
		const linkedSlot = join(firstWorkspace, ".agents", "plugins", "linked-slot");
		const movedSlot = join(firstWorkspace, ".agents", "plugins", "moved-slot");
		await mkdir(targets, { recursive: true });
		await rename(initialSlot, firstTarget);
		await symlink(firstTarget, linkedSlot);
		const linked = await discoverCodingPlugins({
			workspace: firstWorkspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		expect(linked.plugins[0]?.dataDirectory).toBe(first.plugins[0]?.dataDirectory);

		await rename(linkedSlot, movedSlot);
		const moved = await discoverCodingPlugins({
			workspace: firstWorkspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		expect(moved.plugins[0]?.dataDirectory).toBe(first.plugins[0]?.dataDirectory);

		await mkdir(secondTarget, { recursive: true });
		await writeFile(
			join(secondTarget, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable-tools", version: "3.0.0" }),
		);
		await writeFile(
			join(secondTarget, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);
		await rm(movedSlot);
		await symlink(secondTarget, movedSlot);
		const retargeted = await discoverCodingPlugins({
			workspace: firstWorkspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		expect(retargeted.plugins[0]?.dataDirectory).toBe(first.plugins[0]?.dataDirectory);

		await writeFile(
			join(secondTarget, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable-tools", version: "4.0.0" }),
		);
		const upgradedInPlace = await discoverCodingPlugins({
			workspace: firstWorkspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		expect(upgradedInPlace.plugins[0]?.dataDirectory).toBe(first.plugins[0]?.dataDirectory);
		expect(upgradedInPlace.plugins[0]).toMatchObject({
			installationId: "portable-tools@workspace-local",
			snapshot: { manifest: { version: "4.0.0" } },
		});
	});

	it("preserves case-sensitive MCP siblings with deterministic collision-resistant host ids", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "portable-tools", "portable-tools");
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					Docs: { type: "streamable-http", url: "https://upper.example.test/mcp" },
					docs: { type: "streamable-http", url: "https://lower.example.test/mcp" },
					docs_95826bd8: { type: "streamable-http", url: "https://adversarial.example.test/mcp" },
				},
			}),
		);

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
		});
		const servers = inventory.mcpSources[0]!.servers;
		const materialized = await materializeCodingPluginMcpDefinitions({
			sources: inventory.mcpSources,
			platform: "darwin",
		});

		expect(servers.map(({ name }) => name)).toEqual(["Docs", "docs", "docs_95826bd8"]);
		expect(new Set(servers.map(({ id }) => id)).size).toBe(3);
		expect(servers.find(({ name }) => name === "docs")?.id).toBe("plugin_portable-tools_docs");
		expect(servers.find(({ name }) => name === "Docs")?.id).toMatch(/^p_[a-f0-9]{62}$/u);
		expect(servers.find(({ name }) => name === "docs_95826bd8")?.id).toBe("plugin_portable-tools_docs_95826bd8");
		expect(materialized.entries.map(({ serverName }) => serverName)).toEqual(["Docs", "docs", "docs_95826bd8"]);
		expect(materialized.definitions.map(({ semanticName }) => semanticName)).toEqual([
			"portable-tools:Docs",
			"portable-tools:docs",
			"portable-tools:docs_95826bd8",
		]);
		expect(materialized.diagnostics).toEqual([]);
	});

	it("assigns direct Plugins an exact location-independent content digest", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const root = await writePlugin(workspace, "content-slot", "content-tools");
		const skillRoot = join(root, "skills", "inspect");
		const sidecar = join(skillRoot, "agents", "openai.yaml");
		const script = join(skillRoot, "scripts", "inspect.sh");
		const asset = join(skillRoot, "assets", "template.txt");
		const workDirectory = join(root, "work");
		await Promise.all([
			mkdir(join(skillRoot, "agents"), { recursive: true }),
			mkdir(join(skillRoot, "scripts"), { recursive: true }),
			mkdir(join(skillRoot, "assets"), { recursive: true }),
			mkdir(workDirectory, { recursive: true }),
		]);
		await writeFile(
			join(skillRoot, "SKILL.md"),
			"---\nname: inspect\ndescription: Inspect content\n---\n\nInspect content.\n",
		);
		await writeFile(sidecar, "policy:\n  allow_implicit_invocation: true\n");
		await writeFile(script, "#!/bin/sh\necho first\n");
		await writeFile(asset, "first template\n");
		await chmod(script, 0o644);
		await chmod(workDirectory, 0o700);
		const discover = () =>
			discoverCodingPlugins({ workspace, userHome, dataRoot, fileSystem: createNodeFileSystem() });

		const initial = await discover();
		const initialDigest = initial.plugins[0]!.contentDigest;
		expect(initialDigest).toMatch(/^[a-f0-9]{64}$/u);

		await writeFile(sidecar, "policy:\n  allow_implicit_invocation: false\n");
		const sidecarChanged = await discover();
		expect(sidecarChanged.plugins[0]!.contentDigest).not.toBe(initialDigest);

		await writeFile(asset, "second template\n");
		const assetChanged = await discover();
		expect(assetChanged.plugins[0]!.contentDigest).not.toBe(sidecarChanged.plugins[0]!.contentDigest);

		await writeFile(script, "#!/bin/sh\necho second\n");
		const scriptChanged = await discover();
		expect(scriptChanged.plugins[0]!.contentDigest).not.toBe(assetChanged.plugins[0]!.contentDigest);

		await chmod(script, 0o700);
		const modeChanged = await discover();
		expect(modeChanged.plugins[0]!.contentDigest).not.toBe(scriptChanged.plugins[0]!.contentDigest);

		await chmod(script, 0o500);
		const filePermissionChanged = await discover();
		expect(filePermissionChanged.plugins[0]!.contentDigest).not.toBe(modeChanged.plugins[0]!.contentDigest);

		await chmod(workDirectory, 0o755);
		const directoryPermissionChanged = await discover();
		expect(directoryPermissionChanged.plugins[0]!.contentDigest).not.toBe(
			filePermissionChanged.plugins[0]!.contentDigest,
		);

		await mkdir(join(root, ".codex-plugin"));
		await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ poisoned: true }));
		const legacyIgnored = await discover();
		expect(legacyIgnored.plugins[0]!.contentDigest).toBe(directoryPermissionChanged.plugins[0]!.contentDigest);

		const movedRoot = join(workspace, ".agents", "plugins", "moved-content-slot");
		await rename(root, movedRoot);
		const moved = await discover();
		expect(moved.plugins[0]!.contentDigest).toBe(directoryPermissionChanged.plugins[0]!.contentDigest);
	});

	it("loads and identifies direct Plugin content through internal file and directory symlinks", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const root = await writePlugin(workspace, "linked-slot", "linked-tools");
		const sharedSkill = join(root, "shared", "review");
		await mkdir(join(sharedSkill, "assets"), { recursive: true });
		await writeFile(
			join(sharedSkill, "SKILL.md"),
			"---\nname: review\ndescription: Review linked content\n---\n\nReview linked content.\n",
		);
		await writeFile(join(root, "shared", "template.txt"), "linked template\n");
		await mkdir(join(root, "skills"), { recursive: true });
		await symlink("../shared/review", join(root, "skills", "review"), "dir");
		await symlink("../../template.txt", join(sharedSkill, "assets", "template.txt"), "file");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.plugins).toHaveLength(1);
		expect(inventory.plugins[0]?.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
		expect(inventory.plugins[0]?.snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["review"]);
		expect(inventory.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "plugin-content-digest-failed" }),
		);
	});

	it("rejects an internal direct Plugin symlink escape without probing its external target", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "escaping-slot", "escaping-tools");
		const outside = join(await temporaryDirectory(), "outside.txt");
		await writeFile(outside, "must not be read\n");
		const alias = join(root, "outside.txt");
		await symlink(outside, alias, "file");
		const canonicalOutside = await realpath(outside);
		const base = createNodeFileSystem();
		let outsideProbes = 0;
		const rejectOutside = (path: string): never => {
			outsideProbes++;
			throw new Error(`external symlink target was probed: ${path}`);
		};
		const forbidden = (path: string): boolean => path === canonicalOutside;

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: {
				...base,
				lstat: async (path) => (forbidden(path) ? rejectOutside(path) : base.lstat(path)),
				stat: async (path) => (forbidden(path) ? rejectOutside(path) : base.stat(path)),
				readDirectory: async (path) => (forbidden(path) ? rejectOutside(path) : base.readDirectory(path)),
				readFile: async (path) => (forbidden(path) ? rejectOutside(path) : base.readFile(path)),
			},
		});

		expect(outsideProbes).toBe(0);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.diagnostics).toContainEqual(expect.objectContaining({ code: "plugin-content-digest-failed" }));
	});

	it("rejects a direct Plugin symbolic-link cycle", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const root = await writePlugin(workspace, "cycle-slot", "cycle-tools");
		await symlink(".", join(root, "cycle"), "dir");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.plugins).toEqual([]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-content-digest-failed", message: expect.stringContaining("cycle") }),
		);
	});

	it.each([".codex-plugin", ".CODEX-PLUGIN"])(
		"never probes a canonical reserved %s target of an internal direct Plugin symlink",
		async (reservedName) => {
			const workspace = await temporaryDirectory();
			const userHome = await temporaryDirectory();
			const root = await writePlugin(workspace, "reserved-link-slot", "reserved-link-tools");
			const reservedRoot = join(root, reservedName);
			await mkdir(reservedRoot);
			await writeFile(join(reservedRoot, "secret.txt"), "must not be read\n");
			const alias = join(root, "portable-looking");
			await symlink(reservedName, alias, "dir");
			const canonicalReservedRoot = await realpath(reservedRoot);
			const base = createNodeFileSystem();
			let reservedProbes = 0;
			const forbidden = (path: string): boolean =>
				path === canonicalReservedRoot || path.startsWith(`${canonicalReservedRoot}${sep}`);
			const rejectReserved = (path: string): never => {
				reservedProbes++;
				throw new Error(`reserved symlink target was probed: ${path}`);
			};

			const inventory = await discoverCodingPlugins({
				workspace,
				userHome,
				dataRoot: join(await temporaryDirectory(), "plugin-data"),
				fileSystem: {
					...base,
					realpath: async (path) => (forbidden(path) ? rejectReserved(path) : base.realpath(path)),
					lstat: async (path) => (forbidden(path) ? rejectReserved(path) : base.lstat(path)),
					stat: async (path) => (forbidden(path) ? rejectReserved(path) : base.stat(path)),
					readDirectory: async (path) => (forbidden(path) ? rejectReserved(path) : base.readDirectory(path)),
					readFile: async (path) => (forbidden(path) ? rejectReserved(path) : base.readFile(path)),
				},
			});

			expect(reservedProbes).toBe(0);
			expect(inventory.plugins).toEqual([]);
			expect(inventory.diagnostics).toContainEqual(
				expect.objectContaining({ code: "plugin-content-digest-failed" }),
			);
		},
	);

	it("keeps Plugin Skill ids stable across roots while preserving content revisions and activation", async () => {
		const firstWorkspace = await temporaryDirectory();
		const secondWorkspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const writeSkillPlugin = async (workspace: string, slot: string, body: string): Promise<void> => {
			const root = await writePlugin(workspace, slot, "portable-tools");
			await mkdir(join(root, "skills", "review"), { recursive: true });
			await writeFile(
				join(root, "skills", "review", "SKILL.md"),
				`---\nname: review\ndescription: Review portably\n---\n\n${body}\n`,
			);
		};
		await Promise.all([
			writeSkillPlugin(firstWorkspace, "first-slot", "First body."),
			writeSkillPlugin(secondWorkspace, "moved-slot", "First body."),
		]);
		const discover = (workspace: string) =>
			discoverCodingPlugins({
				workspace,
				userHome,
				dataRoot: join(workspace, "plugin-data"),
				fileSystem: createNodeFileSystem(),
			});

		const [first, moved] = await Promise.all([discover(firstWorkspace), discover(secondWorkspace)]);
		const firstCandidate = first.plugins[0]!.snapshot.skills.candidates[0]!;
		const movedCandidate = moved.plugins[0]!.snapshot.skills.candidates[0]!;
		expect(movedCandidate.id).toBe(firstCandidate.id);
		expect(String(firstCandidate.id)).toMatch(/^skill:[a-f0-9]{32}$/u);
		expect(movedCandidate.revision).toBe(firstCandidate.revision);

		await writeFile(
			join(secondWorkspace, ".agents", "plugins", "moved-slot", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review portably\n---\n\nChanged body.\n",
		);
		const changed = await discover(secondWorkspace);
		const changedCandidate = changed.plugins[0]!.snapshot.skills.candidates[0]!;
		expect(changedCandidate.id).toBe(firstCandidate.id);
		expect(changedCandidate.revision).not.toBe(firstCandidate.revision);

		const activation = await changed.plugins[0]!.snapshot.skills.activate(changedCandidate.id);
		expect(activation).toMatchObject({
			ok: true,
			activation: {
				candidate: { id: firstCandidate.id, revision: changedCandidate.revision },
				contents: expect.stringContaining("Changed body."),
			},
		});
	});

	it("selects one deterministic installation when slots collide on the manifest namespace", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		await writePlugin(userHome, "alpha-user", "shared-tools");
		await writePlugin(workspace, "zeta-workspace", "shared-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.plugins.map(({ origin, snapshot }) => [origin.scope, snapshot.manifest.name])).toEqual([
			["workspace", "shared-tools"],
		]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-namespace-collision",
				severity: "warning",
				pluginName: "shared-tools",
			}),
		);
	});

	it("selects the lowest deterministic slot when one source repeats an installation identity", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		await writePlugin(workspace, "zeta", "shared-tools");
		await writePlugin(workspace, "alpha", "shared-tools");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.installations.map(({ installationId, slot }) => [installationId, slot])).toEqual([
			["shared-tools@workspace-local", "alpha"],
		]);
		expect(inventory.plugins.map(({ installationId, slot }) => [installationId, slot])).toEqual([
			["shared-tools@workspace-local", "alpha"],
		]);
		expect(inventory.snapshots.filter(({ status }) => status === "loaded")).toHaveLength(2);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-installation-collision",
				installationId: "shared-tools@workspace-local",
				path: expect.stringContaining("alpha"),
			}),
		);
	});

	it("retains a disabled selected installation without falling back to an enabled lower-precedence copy", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const workspacePlugin = await writePlugin(workspace, "zeta-workspace", "shared-tools");
		await writePlugin(userHome, "alpha-user", "shared-tools");
		await writeFile(
			join(workspacePlugin, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { docs: { type: "streamable-http", url: "https://example.test/mcp" } },
			}),
		);

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
			enablement: {
				"shared-tools@workspace-local": { enabled: false },
			},
		});

		expect(
			inventory.installations.map(({ installationId, origin, enabled }) => [installationId, origin.scope, enabled]),
		).toEqual([
			["shared-tools@user-local", "user", true],
			["shared-tools@workspace-local", "workspace", false],
		]);
		expect(inventory.plugins).toEqual([]);
		expect(inventory.skills).toEqual([]);
		expect(inventory.mcpSources).toEqual([]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-disabled",
				installationId: "shared-tools@workspace-local",
			}),
		);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "plugin-namespace-collision", pluginName: "shared-tools" }),
		);
	});

	it("falls back to a valid User Plugin when the same Workspace slot is rejected without recursing", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const workspaceSlot = await writePlugin(workspace, "same", "valid-before-corruption");
		await writeFile(
			join(workspaceSlot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "InvalidName" }),
		);
		await writePlugin(userHome, "same", "user-fallback");
		const nested = join(workspace, ".agents", "plugins", "group", "nested");
		await mkdir(nested, { recursive: true });
		await writeFile(
			join(nested, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "must-not-be-discovered" }),
		);

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(
			inventory.plugins.map(({ origin, snapshot }) => [origin.scope, origin.slot, snapshot.manifest.name]),
		).toEqual([["user", "same", "user-fallback"]]);
		expect(
			inventory.snapshots
				.filter(({ origin }) => origin.slot === "same")
				.map(({ status, origin }) => [origin.scope, status]),
		).toEqual([
			["workspace", "rejected"],
			["user", "loaded"],
		]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "plugin-manifest-invalid",
				origin: expect.objectContaining({ slot: "same" }),
			}),
		);
		expect(Object.isFrozen(inventory)).toBe(true);
	});

	it("rejects a Workspace Plugin root symlink that escapes the Workspace boundary", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const outsidePlugin = await writePlugin(outside, "escaped", "escaped-workspace-plugin");
		await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
		await symlink(outsidePlugin, join(workspace, ".agents", "plugins", "same"));
		await writePlugin(userHome, "same", "contained-user-fallback");

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.plugins.map(({ origin, snapshot }) => [origin.scope, snapshot.manifest.name])).toEqual([
			["user", "contained-user-fallback"],
		]);
		expect(inventory.diagnostics).toContainEqual(
			expect.objectContaining({ code: "workspace-plugin-root-outside-boundary", phase: "discover" }),
		);
	});

	it("loads the pre-resolved Workspace target when a Plugin slot symlink is retargeted", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const inside = join(workspace, "plugin-target");
		await mkdir(inside);
		await writeFile(
			join(inside, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "inside-target" }),
		);
		const outsideHome = await temporaryDirectory();
		const outside = await writePlugin(outsideHome, "outside", "outside-target");
		const slot = join(workspace, ".agents", "plugins", "same");
		await mkdir(dirname(slot), { recursive: true });
		await symlink(inside, slot);
		await writePlugin(userHome, "same", "user-fallback");
		const base = createNodeFileSystem();
		let retargeted = false;

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot: join(await temporaryDirectory(), "plugin-data"),
			fileSystem: {
				...base,
				realpath: async (path) => {
					const canonical = await base.realpath(path);
					if (path === slot && !retargeted) {
						retargeted = true;
						await rm(slot);
						await symlink(outside, slot);
					}
					return canonical;
				},
			},
		});

		expect(inventory.plugins.map(({ origin, snapshot }) => [origin.scope, snapshot.manifest.name])).toEqual([
			["workspace", "inside-target"],
			["user", "user-fallback"],
		]);
		expect(inventory.plugins[0]?.snapshot.root).toBe(await realpath(inside));
		expect(inventory.diagnostics).toEqual([]);
	});
});
