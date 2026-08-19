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
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({
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
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");
		await symlink(outsideDirectory, join(dataDirectory, "escape"));
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({ dataDirectory, platform: "linux" });

		expect(materialized.servers.map(({ name }) => name)).toEqual(["valid"]);
		expect(materialized.diagnostics).toHaveLength(3);
		expect(materialized.diagnostics.map(({ message }) => message)).toEqual([
			expect.stringContaining('"badCommand"'),
			expect.stringContaining('"badDataCwd"'),
			expect.stringContaining('"badRootCwd"'),
		]);
		expect(materialized.diagnostics[0]?.message).toContain("outside the Plugin root");
		expect(materialized.diagnostics[1]?.message).toContain("outside its permitted root");
		expect(materialized.diagnostics[2]?.message).toContain("outside its permitted root");
	});

	it("accepts host-resolvable backslashes and rejects post-expansion escapes per Server", async () => {
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
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		const materialized = await snapshot.materializeMcp({ dataDirectory, platform: "win32" });

		expect(materialized.servers).toEqual([
			expect.objectContaining({
				name: "backslashes",
				transport: expect.objectContaining({ command: await realpath(command), cwd: await realpath(cwd) }),
			}),
		]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining('"escape"'),
			}),
		);
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
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");

		const materialized = await snapshot.materializeMcp({ dataDirectory, platform: "linux" });

		expect(materialized.servers).toEqual([]);
		expect(materialized.diagnostics).toEqual([
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				message: expect.stringContaining("Plugin root changed"),
			}),
		]);
	});

	it("propagates cancellation that occurs during command containment checks", async () => {
		const root = await pluginRoot({ local: { type: "stdio", command: "./runner" } });
		const commandPath = join(root, "runner");
		await writeFile(commandPath, "#!/bin/sh\n");
		const canonicalCommandPath = await realpath(commandPath);
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");
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
			snapshot.materializeMcp({ dataDirectory, platform: "linux", signal: controller.signal }),
		).rejects.toBe(reason);
	});
});
