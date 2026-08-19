import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createCodingPluginsManager, discoverCodingPlugins } from "../../src/plugins/inventory.ts";

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

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin inventory", () => {
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

	it("discovers installed slots deterministically with Workspace precedence", async () => {
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
			["same", "workspace", "workspace-winner"],
			["zeta", "workspace", "zeta"],
		]);
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

		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		expect(inventory.skills).toEqual([inventory.plugins[0]!.snapshot.skills]);
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
						id: expect.stringMatching(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u),
						name: "docs",
						type: "streamable-http",
					}),
				],
			}),
		]);
		await expect(lstat(inventory.plugins[0]!.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(Object.isFrozen(inventory.mcpSources[0]?.servers)).toBe(true);
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
		]);
		expect(inventory.plugins[0]?.snapshot.root).toBe(await realpath(inside));
		expect(inventory.diagnostics).toEqual([]);
	});
});
