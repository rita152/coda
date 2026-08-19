import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillFileSystem } from "@coda/skills";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGIN_MCP_SCHEMA, AGENT_PLUGIN_SCHEMA, createPlugins } from "../src/index.ts";
import { nodePluginFileSystem } from "./helpers.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix = "coda-plugins-snapshot-"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function pluginRoot(name = "snapshot"): Promise<string> {
	const root = await temporaryDirectory();
	await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name }));
	return root;
}

async function writeSkill(root: string, name: string): Promise<void> {
	await mkdir(join(root, "skills", name), { recursive: true });
	await writeFile(
		join(root, "skills", name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} snapshot fixture\nmetadata:\n  fixture: immutable\n---\n\nRun it.\n`,
	);
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const nested of Object.values(value)) expectDeeplyFrozen(nested, seen);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Agent Plugin snapshots", () => {
	it("deep-freezes loaded and materialized portable values", async () => {
		const root = await pluginRoot();
		await writeSkill(root, "review");
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					local: { type: "stdio", command: "node", args: ["server.mjs"], env: { MODE: "test" } },
					remote: {
						type: "streamable-http",
						url: "https://example.test/mcp",
						headers: { "X-Fixture": "immutable" },
					},
					broken: { type: "stdio", command: "node", unknown: true },
				},
			}),
		);
		const snapshot = await createPlugins({ fileSystem: nodePluginFileSystem() }).load({ root, origin: "test" });
		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");

		expectDeeplyFrozen(snapshot);
		const dataDirectory = await temporaryDirectory("coda-plugins-data-");
		const materialized = await snapshot.materializeMcp({ dataDirectory, platform: "linux" });
		expectDeeplyFrozen(materialized);
	});

	it("orders Skills, MCP Servers, and per-entry diagnostics with binary comparison", async () => {
		const root = await pluginRoot("ordering");
		await writeSkill(root, "zeta");
		await writeSkill(root, "alpha");
		await writeFile(
			join(root, "mcp.json"),
			JSON.stringify({
				$schema: AGENT_PLUGIN_MCP_SCHEMA,
				mcpServers: {
					"ä-server": { type: "stdio", command: "node" },
					"á-invalid": { type: "stdio", command: "../node" },
					"z-server": { type: "stdio", command: "node" },
					"B-invalid": { type: "stdio", command: "/node" },
					"A-server": { type: "stdio", command: "node" },
				},
			}),
		);
		const base = nodePluginFileSystem();
		const reverseDirectoryFileSystem: SkillFileSystem = {
			...base,
			readDirectory: async (path) => [...(await base.readDirectory(path))].reverse(),
		};

		const snapshot = await createPlugins({ fileSystem: reverseDirectoryFileSystem }).load({ root, origin: "test" });

		if (snapshot.status !== "loaded") throw new Error("expected a loaded plugin");
		expect(snapshot.skills.candidates.map(({ metadata }) => metadata.name)).toEqual(["alpha", "zeta"]);
		expect(snapshot.mcpServers.map(({ name }) => name)).toEqual(["A-server", "z-server", "ä-server"]);
		expect(
			snapshot.diagnostics.filter(({ code }) => code === "mcp-server-invalid").map(({ message }) => message),
		).toEqual([expect.stringContaining('"B-invalid"'), expect.stringContaining('"á-invalid"')]);
	});

	it("propagates cancellation instead of converting it into a diagnostic snapshot", async () => {
		const root = await pluginRoot("cancel");
		const controller = new AbortController();
		const reason = new Error("stop plugin load");
		const base = nodePluginFileSystem();
		const abortingFileSystem: SkillFileSystem = {
			...base,
			readFile: async (path) => {
				const bytes = await base.readFile(path);
				if (path.endsWith("plugin.json")) controller.abort(reason);
				return bytes;
			},
		};

		await expect(
			createPlugins({ fileSystem: abortingFileSystem }).load({ root, origin: "test", signal: controller.signal }),
		).rejects.toBe(reason);
	});

	it("enforces configured byte limits after reading even when metadata under-reports size", async () => {
		const manifestRoot = await temporaryDirectory();
		const manifestSource = JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "manifest-limit" });
		await writeFile(join(manifestRoot, "plugin.json"), manifestSource);
		const base = nodePluginFileSystem();
		const underReportingFileSystem: SkillFileSystem = {
			...base,
			stat: async (path) => ({ ...(await base.stat(path)), size: 0 }),
		};

		const rejected = await createPlugins({
			fileSystem: underReportingFileSystem,
			limits: { maxManifestBytes: manifestSource.length - 1 },
		}).load({ root: manifestRoot, origin: "test" });
		expect(rejected).toMatchObject({
			status: "rejected",
			diagnostics: [{ code: "plugin-manifest-invalid", severity: "error" }],
		});

		const mcpRoot = await pluginRoot("mcp-limit");
		const mcpSource = JSON.stringify({
			$schema: AGENT_PLUGIN_MCP_SCHEMA,
			mcpServers: { local: { type: "stdio", command: "node" } },
		});
		await writeFile(join(mcpRoot, "mcp.json"), mcpSource);
		const loaded = await createPlugins({
			fileSystem: underReportingFileSystem,
			limits: { maxMcpConfigurationBytes: mcpSource.length - 1 },
		}).load({ root: mcpRoot, origin: "test" });
		if (loaded.status !== "loaded") throw new Error("expected an isolated MCP limit failure");
		expect(loaded.mcpServers).toEqual([]);
		expect(loaded.diagnostics).toContainEqual(
			expect.objectContaining({ code: "mcp-component-invalid", phase: "mcp", severity: "warning" }),
		);

		expect(() => createPlugins({ fileSystem: base, limits: { maxManifestBytes: 0 } })).toThrow(
			"maxManifestBytes must be a positive safe integer",
		);
	});
});
