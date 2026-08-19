import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { discoverCodingPlugins, materializeCodingPluginMcpDefinitions } from "../../src/plugins/inventory.ts";

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_ROOT = "${" + "PLUGIN_ROOT}";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "coda-coding-plugin-mcp-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Coding Agent Plugin MCP translation", () => {
	it("maps materialized stdio and Streamable HTTP Servers onto native protocol definitions", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const pluginRoot = join(workspace, ".agents", "plugins", "tools");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "portable-tools" }),
		);
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					local: { type: "stdio", command: "node", args: [`${PLUGIN_ROOT}/server.mjs`] },
					remote: { type: "streamable-http", url: "https://example.test/mcp" },
				},
			}),
		);
		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		await mkdir(inventory.plugins[0]!.dataDirectory, { recursive: true });
		const canonicalDataDirectory = await realpath(inventory.plugins[0]!.dataDirectory);

		const materialized = await materializeCodingPluginMcpDefinitions({
			sources: inventory.mcpSources,
			platform: process.platform,
		});

		expect(materialized.definitions).toEqual([
			{
				id: inventory.mcpSources[0]!.servers[0]!.id,
				protocol: "auto",
				transport: {
					kind: "stdio",
					command: "node",
					args: [join(inventory.plugins[0]!.snapshot.root, "server.mjs")],
					cwd: inventory.plugins[0]!.snapshot.root,
					environment: {
						PLUGIN_DATA: canonicalDataDirectory,
						PLUGIN_ROOT: inventory.plugins[0]!.snapshot.root,
					},
				},
			},
			{
				id: inventory.mcpSources[0]!.servers[1]!.id,
				protocol: "auto",
				transport: { kind: "http", url: "https://example.test/mcp" },
			},
		]);
		expect(materialized.diagnostics).toEqual([]);
		expect(Object.isFrozen(materialized.definitions)).toBe(true);
	});

	it("isolates a generated Server id collision without suppressing other Plugin Servers", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		const pluginRoot = join(userHome, ".agents", "plugins", "remote-tools");
		await mkdir(pluginRoot, { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "remote-tools" }),
		);
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					alpha: { type: "streamable-http", url: "https://alpha.example.test/mcp" },
					beta: { type: "streamable-http", url: "https://beta.example.test/mcp" },
				},
			}),
		);
		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});
		const collision = inventory.mcpSources[0]!.servers[0]!;

		const materialized = await materializeCodingPluginMcpDefinitions({
			sources: inventory.mcpSources,
			platform: process.platform,
			reservedServerIds: [collision.id],
		});

		expect(materialized.definitions.map(({ id }) => id)).toEqual([inventory.mcpSources[0]!.servers[1]!.id]);
		expect(materialized.diagnostics).toContainEqual({
			code: "plugin-mcp-server-id-collision",
			severity: "warning",
			phase: "mcp",
			message: `Skipped Plugin MCP Server "alpha" because id "${collision.id}" is already in use`,
			pluginRoot: inventory.plugins[0]!.snapshot.root,
			origin: inventory.plugins[0]!.origin,
			serverId: collision.id,
			serverName: "alpha",
		});
	});

	it("isolates an unavailable stdio data directory without hiding HTTP siblings or healthy sources", async () => {
		const workspace = await temporaryDirectory();
		const userHome = await temporaryDirectory();
		const dataRoot = join(await temporaryDirectory(), "plugin-data");
		for (const [slot, server] of [
			[
				"bad",
				{
					local: { type: "stdio", command: "node" },
					remote: { type: "streamable-http", url: "https://bad.example.test/mcp" },
				},
			],
			["good", { remote: { type: "streamable-http", url: "https://example.test/mcp" } }],
		] as const) {
			const pluginRoot = join(userHome, ".agents", "plugins", slot);
			await mkdir(pluginRoot, { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: `${slot}-tools` }),
			);
			await writeFile(
				join(pluginRoot, "mcp.json"),
				JSON.stringify({ $schema: AGENT_PLUGIN_MCP_SCHEMA, mcpServers: server }),
			);
		}
		const inventory = await discoverCodingPlugins({
			workspace,
			userHome,
			dataRoot,
			fileSystem: createNodeFileSystem(),
		});

		const materialized = await materializeCodingPluginMcpDefinitions({
			sources: inventory.mcpSources,
			platform: process.platform,
		});

		expect(materialized.definitions).toEqual([
			{
				id: inventory.mcpSources[0]!.servers[1]!.id,
				protocol: "auto",
				transport: { kind: "http", url: "https://bad.example.test/mcp" },
			},
			{
				id: inventory.mcpSources[1]!.servers[0]!.id,
				protocol: "auto",
				transport: { kind: "http", url: "https://example.test/mcp" },
			},
		]);
		expect(materialized.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "mcp-server-materialization-failed",
				severity: "warning",
				phase: "mcp",
				pluginRoot: inventory.plugins[0]!.snapshot.root,
				origin: inventory.plugins[0]!.origin,
			}),
		);
	});
});
