import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SkillFileSystem } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, createPlugins } from "../src/index.ts";
import { nodePluginFileSystem } from "./helpers.ts";

const temporaryDirectories: string[] = [];
const PLUGIN_ROOT_PLACEHOLDER = "${" + "PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${" + "PLUGIN_DATA}";

async function temporaryDirectory(prefix = "coda-plugins-materialize-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function pluginRoot(mcpServers: Record<string, unknown>): Promise<string> {
	const root = await temporaryDirectory();
	await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "materialize" }));
	await writeFile(join(root, "mcp.json"), JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers }));
	return root;
}

async function pluginData(): Promise<{ readonly dataRoot: string; readonly dataDirectory: string }> {
	const dataRoot = await temporaryDirectory("coda-plugins-data-root-");
	const dataDirectory = join(dataRoot, "materialize");
	await mkdir(dataDirectory);
	return { dataRoot: await realpath(dataRoot), dataDirectory: await realpath(dataDirectory) };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Agent Plugin MCP materialization", () => {
	it("keeps HTTP siblings when a stdio Server has no usable Plugin data directory", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({ platform: "linux" });

		expect(materialized.servers).toEqual([
			expect.objectContaining({
				name: "remote",
				transport: { kind: "http", url: "https://example.test/mcp" },
			}),
		]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining('"local"'),
			}),
		]);
	});

	it("rejects a symlinked Plugin data directory without losing its HTTP sibling", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const dataRoot = await temporaryDirectory("coda-plugins-data-root-");
		const outside = await temporaryDirectory("coda-plugins-data-outside-");
		const dataDirectory = join(dataRoot, "materialize");
		await symlink(outside, dataDirectory);
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
			dataRoot: await realpath(dataRoot),
			dataDirectory,
			platform: "linux",
		});

		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("Plugin dataDirectory must be a real directory"),
			}),
		);
	});

	it("rejects a symlinked client Plugin data root without losing its HTTP sibling", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const aliasParent = await temporaryDirectory("coda-plugins-data-root-alias-");
		const actualDataRoot = await temporaryDirectory("coda-plugins-data-root-outside-");
		const dataDirectory = join(actualDataRoot, "materialize");
		await mkdir(dataDirectory);
		const dataRoot = join(aliasParent, "plugin-data");
		await symlink(actualDataRoot, dataRoot);
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
			dataRoot,
			dataDirectory: await realpath(dataDirectory),
			platform: "linux",
		});

		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("Plugin dataRoot must be a real directory"),
			}),
		);
	});

	it("rejects a canonical Plugin data directory outside the client data root", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const dataRoot = await temporaryDirectory("coda-plugins-data-root-");
		const dataDirectory = await temporaryDirectory("coda-plugins-data-outside-");
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
			dataRoot: await realpath(dataRoot),
			dataDirectory: await realpath(dataDirectory),
			platform: "linux",
		});

		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("outside the Plugin dataRoot"),
			}),
		);
	});

	it("revalidates the Plugin data directory before exposing a stdio transport", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const { dataRoot, dataDirectory } = await pluginData();
		const outside = await temporaryDirectory("coda-plugins-data-race-outside-");
		const displaced = `${dataDirectory}-displaced`;
		let enabled = false;
		let dataDirectoryChecks = 0;
		const base = nodePluginFileSystem();
		const fileSystem: SkillFileSystem = {
			...base,
			lstat: async (path) => {
				if (enabled && path === dataDirectory && ++dataDirectoryChecks === 3) {
					await rename(dataDirectory, displaced);
					await symlink(outside, dataDirectory);
				}
				return base.lstat(path);
			},
		};
		const snapshot = await createPlugins({ fileSystem }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		enabled = true;

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("changed after it was validated"),
			}),
		);
	});

	it("revalidates the load-time Plugin root lease before exposing each stdio transport", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "./runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const commandPath = join(root, "runner");
		await writeFile(commandPath, "original executable\n");
		const canonicalCommandPath = await realpath(commandPath);
		const outside = await temporaryDirectory("coda-plugins-root-race-outside-");
		await writeFile(join(outside, "runner"), "outside executable\n");
		const movedRoot = `${root}-displaced`;
		temporaryDirectories.push(movedRoot);
		let enabled = false;
		let replaced = false;
		const base = nodePluginFileSystem();
		const fileSystem: SkillFileSystem = {
			...base,
			stat: async (path) => {
				const status = await base.stat(path);
				if (enabled && !replaced && path === canonicalCommandPath) {
					replaced = true;
					await rename(root, movedRoot);
					await symlink(outside, root);
				}
				return status;
			},
		};
		const snapshot = await createPlugins({ fileSystem }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const { dataRoot, dataDirectory } = await pluginData();
		enabled = true;

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(replaced).toBe(true);
		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				componentName: "local",
				message: expect.stringContaining("Plugin root changed after it was validated"),
			}),
		]);
	});

	it("revalidates a Plugin-relative executable lease before exposing its stdio transport", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "./runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const commandPath = join(root, "runner");
		const displacedCommand = join(root, "runner-displaced");
		await writeFile(commandPath, "original executable\n");
		const canonicalCommandPath = await realpath(commandPath);
		const outside = await temporaryDirectory("coda-plugins-command-race-outside-");
		const outsideCommand = join(outside, "runner");
		await writeFile(outsideCommand, "outside executable\n");
		let enabled = false;
		let replaced = false;
		const base = nodePluginFileSystem();
		const fileSystem: SkillFileSystem = {
			...base,
			stat: async (path) => {
				const status = await base.stat(path);
				if (enabled && !replaced && path === canonicalCommandPath) {
					replaced = true;
					await rename(commandPath, displacedCommand);
					await symlink(outsideCommand, commandPath);
				}
				return status;
			},
		};
		const snapshot = await createPlugins({ fileSystem }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const { dataRoot, dataDirectory } = await pluginData();
		enabled = true;

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(replaced).toBe(true);
		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				componentName: "local",
				message: expect.stringContaining("command changed after it was validated"),
			}),
		]);
	});

	it("revalidates a configured cwd lease before exposing its stdio transport", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "runner", cwd: "./work" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const cwd = join(root, "work");
		const displacedCwd = join(root, "work-displaced");
		await mkdir(cwd);
		const canonicalCwd = await realpath(cwd);
		const outside = await temporaryDirectory("coda-plugins-cwd-race-outside-");
		let enabled = false;
		let replaced = false;
		const base = nodePluginFileSystem();
		const fileSystem: SkillFileSystem = {
			...base,
			stat: async (path) => {
				const status = await base.stat(path);
				if (enabled && !replaced && path === canonicalCwd) {
					replaced = true;
					await rename(cwd, displacedCwd);
					await symlink(outside, cwd);
				}
				return status;
			},
		};
		const snapshot = await createPlugins({ fileSystem }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const { dataRoot, dataDirectory } = await pluginData();
		enabled = true;

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(replaced).toBe(true);
		expect(materialized.servers.map(({ name }) => name)).toEqual(["remote"]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				componentName: "local",
				message: expect.stringContaining("cwd changed after it was validated"),
			}),
		]);
	});

	it("carries a non-serializable launch guard that revalidates leases after materialization", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "./runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		const command = join(root, "runner");
		const displaced = join(root, "runner-displaced");
		await writeFile(command, "original executable\n");
		const outside = await temporaryDirectory("coda-plugins-launch-guard-outside-");
		const outsideCommand = join(outside, "runner");
		await writeFile(outsideCommand, "outside executable\n");
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const { dataRoot, dataDirectory } = await pluginData();

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers.map(({ name }) => name)).toEqual(["local", "remote"]);
		const transport = materialized.servers[0]?.transport;
		if (!transport || transport.kind !== "stdio" || !transport.beforeLaunch) {
			throw new Error("expected a guarded stdio transport");
		}
		expect(Object.keys(transport)).not.toContain("beforeLaunch");
		expect(JSON.stringify(transport)).not.toContain("beforeLaunch");
		await rename(command, displaced);
		await symlink(outsideCommand, command);

		await expect(transport.beforeLaunch()).rejects.toThrow("command changed after it was validated");
	});

	it("overlays and forces environment names using Windows case-insensitive semantics", async () => {
		const root = await pluginRoot({
			local: {
				type: "stdio",
				command: "runner",
				env: {
					PATH: "configured-path",
					MixedCase: "first",
					mixedcase: "last",
					plugin_root: "configured-spoof",
					plugin_data: "configured-spoof",
				},
			},
		});
		const { dataRoot, dataDirectory } = await pluginData();
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
			dataRoot,
			dataDirectory,
			baseEnvironment: {
				Path: "base-path",
				MIXEDCASE: "base",
				PLUGIN_ROOT: "base-spoof",
				PLUGIN_DATA: "base-spoof",
				OMIT: undefined,
			},
			platform: "win32",
		});

		expect(materialized.diagnostics).toEqual([]);
		expect(materialized.servers[0]?.transport).toMatchObject({
			kind: "stdio",
			environment: {
				PATH: "configured-path",
				mixedcase: "last",
				PLUGIN_ROOT: await realpath(root),
				PLUGIN_DATA: await realpath(dataDirectory),
			},
		});
		const transport = materialized.servers[0]?.transport;
		if (!transport || transport.kind !== "stdio") throw new Error("expected a stdio transport");
		if (!transport.environment) throw new Error("expected a materialized environment");
		expect(Object.keys(transport.environment).sort()).toEqual(["PATH", "PLUGIN_DATA", "PLUGIN_ROOT", "mixedcase"]);
	});

	it("isolates command and cwd symlink escapes at materialization", async () => {
		const outside = await temporaryDirectory("coda-plugins-outside-");
		const outsideFile = join(outside, "runner");
		const outsideDirectory = join(outside, "work");
		await writeFile(outsideFile, "#!/bin/sh\n");
		await mkdir(outsideDirectory);
		const root = await pluginRoot({
			badCommand: { type: "stdio", command: "./bin/runner" },
			badDataCwd: { type: "stdio", command: "runner", cwd: `${PLUGIN_DATA_PLACEHOLDER}/escape` },
			badRootCwd: { type: "stdio", command: "runner", cwd: "./escape" },
			valid: { type: "stdio", command: "runner" },
		});
		await mkdir(join(root, "bin"));
		await symlink(outsideFile, join(root, "bin", "runner"));
		await symlink(outsideDirectory, join(root, "escape"));
		const { dataRoot, dataDirectory } = await pluginData();
		await symlink(outsideDirectory, join(dataDirectory, "escape"));
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers.map(({ name }) => name)).toEqual(["valid"]);
		expect(materialized.diagnostics).toHaveLength(3);
		expect(materialized.diagnostics.map(({ componentName }) => componentName)).toEqual([
			"badCommand",
			"badDataCwd",
			"badRootCwd",
		]);
		expect(materialized.diagnostics.map(({ message }) => message)).toEqual([
			expect.stringContaining('"badCommand"'),
			expect.stringContaining('"badDataCwd"'),
			expect.stringContaining('"badRootCwd"'),
		]);
		expect(materialized.diagnostics[0]?.message).toContain("outside the Plugin root");
		expect(materialized.diagnostics[1]?.message).toContain("outside its permitted root");
		expect(materialized.diagnostics[2]?.message).toContain("outside its permitted root");
	});

	it("accepts host-resolvable backslashes and keeps platform-only failures isolated at materialization", async () => {
		const root = await pluginRoot({
			backslashes: {
				type: "stdio",
				command: "./bin\\server",
				cwd: `${PLUGIN_ROOT_PLACEHOLDER}/work\\nested`,
			},
			escape: { type: "stdio", command: "./../outside-runner" },
			driveRelative: { type: "stdio", command: "C:runner" },
		});
		const command = resolve(root, "./bin\\server");
		const cwd = resolve(root, "work\\nested");
		await mkdir(dirname(command), { recursive: true });
		await mkdir(cwd, { recursive: true });
		await writeFile(command, "#!/bin/sh\n");
		const { dataRoot, dataDirectory } = await pluginData();
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["backslashes", "driveRelative"]);
		expect(snapshot.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-invalid",
				message: expect.stringContaining('"escape"'),
			}),
		);

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "win32" });

		expect(materialized.servers).toEqual([
			expect.objectContaining({
				name: "backslashes",
				transport: expect.objectContaining({ command: await realpath(command), cwd: await realpath(cwd) }),
			}),
		]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining('"driveRelative"'),
			}),
		);
	});

	it("rejects a Plugin root that changes after the immutable Snapshot was loaded", async () => {
		const root = await pluginRoot({ local: { type: "stdio", command: "runner" } });
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const movedRoot = `${root}-moved`;
		temporaryDirectories.push(movedRoot);
		await rename(root, movedRoot);
		const outside = await temporaryDirectory("coda-plugins-outside-");
		await symlink(outside, root);
		const { dataRoot, dataDirectory } = await pluginData();

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers).toEqual([]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("Plugin root changed"),
			}),
		]);
	});

	it("rejects a same-path real-directory Plugin root replacement without losing its HTTP sibling", async () => {
		const root = await pluginRoot({
			local: { type: "stdio", command: "./runner" },
			remote: { type: "streamable-http", url: "https://example.test/mcp" },
		});
		await writeFile(join(root, "runner"), "original executable\n");
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		const movedRoot = `${root}-moved`;
		temporaryDirectories.push(movedRoot);
		await rename(root, movedRoot);
		await mkdir(root);
		await writeFile(join(root, "runner"), "replacement executable\n");
		const { dataRoot, dataDirectory } = await pluginData();

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers).toEqual([
			expect.objectContaining({
				name: "remote",
				transport: { kind: "http", url: "https://example.test/mcp" },
			}),
		]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringMatching(/Plugin root (?:changed|was replaced)/u),
			}),
		]);
	});

	it("retains canonical-path protection when the filesystem cannot expose directory identities", async () => {
		const root = await pluginRoot({ local: { type: "stdio", command: "runner" } });
		const { dataRoot, dataDirectory } = await pluginData();
		const base = nodePluginFileSystem();
		const withoutIdentity = async (status: ReturnType<SkillFileSystem["lstat"]>) => {
			const { device: _device, inode: _inode, ...portable } = await status;
			return portable;
		};
		const snapshot = await createPlugins({
			fileSystem: {
				...base,
				stat: (path) => withoutIdentity(base.stat(path)),
				lstat: (path) => withoutIdentity(base.lstat(path)),
			},
		}).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux" });

		expect(materialized.servers).toEqual([
			expect.objectContaining({
				name: "local",
				transport: expect.objectContaining({ kind: "stdio", command: "runner" }),
			}),
		]);
		expect(materialized.diagnostics).toEqual([]);
		expect(snapshot.manifest).toEqual({ $schema: AGENT_PLUGIN_SCHEMA, name: "materialize" });
		expect(snapshot).not.toHaveProperty("rootIdentity");
	});

	it("propagates cancellation that occurs during command containment checks", async () => {
		const root = await pluginRoot({ local: { type: "stdio", command: "./runner" } });
		const commandPath = join(root, "runner");
		await writeFile(commandPath, "#!/bin/sh\n");
		const canonicalCommandPath = await realpath(commandPath);
		const { dataRoot, dataDirectory } = await pluginData();
		const controller = new AbortController();
		const reason = new Error("stop MCP materialization");
		const base = nodePluginFileSystem();
		const abortingFileSystem: SkillFileSystem = {
			...base,
			realpath: async (path) => {
				const canonical = await base.realpath(path);
				if (path === canonicalCommandPath) controller.abort(reason);
				return canonical;
			},
		};
		const snapshot = await createPlugins({ fileSystem: abortingFileSystem }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		await expect(
			snapshot.materializeMcp({ dataRoot, dataDirectory, platform: "linux", signal: controller.signal }),
		).rejects.toBe(reason);
	});
});
