import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@coda/ai";
import type { McpConnection, McpConnector, McpServerDefinition } from "@coda/mcp";
import { afterEach, describe, expect, it } from "vitest";
import {
	createApplicationSettingsState,
	loadProjectSkills,
	openProjectServices,
	type ProjectPluginSource,
} from "../../src/app/project-runtime.ts";
import { createWorkspaceSessionResources } from "../../src/app/workspace-session.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createWorkspace } from "../../src/host/workspace.ts";
import { testTimeRuntime } from "../time-runtime.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Project MCP reload", () => {
	it("publishes overlapping Plugin reload requests in request order", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		const runtime = testTimeRuntime(500);
		let releaseFirstPreparation!: () => void;
		let reportFirstPreparation!: () => void;
		const firstPreparation = new Promise<void>((resolve) => {
			reportFirstPreparation = resolve;
		});
		const firstPreparationGate = new Promise<void>((resolve) => {
			releaseFirstPreparation = resolve;
		});
		const preparations: string[] = [];
		const definitions: readonly McpServerDefinition[] = [
			{
				id: "first",
				protocol: "auto",
				transport: { kind: "http", url: "https://first.example.test/mcp" },
			},
			{
				id: "second",
				protocol: "auto",
				transport: { kind: "http", url: "https://second.example.test/mcp" },
			},
		];
		let preparation = 0;
		const plugins: ProjectPluginSource = {
			watchRoots: [],
			skillSnapshots: () => [],
			refresh: async () => undefined,
			mcpDefinitions: async () => {
				const index = preparation++;
				preparations.push(definitions[index]!.id);
				if (index === 0) {
					reportFirstPreparation();
					await firstPreparationGate;
				}
				return [definitions[index]!];
			},
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const connectionFor = (definition: McpServerDefinition): McpConnection => ({
			info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
			listTools: async () => [
				{
					name: "inspect",
					description: `Inspect through ${definition.id}`,
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async () => ({ isError: false, content: [] }),
			close: async () => undefined,
		});
		const connector: McpConnector = { connect: async (definition) => connectionFor(definition) };
		let settingsLoads = 0;
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: {
					load: async () => {
						settingsLoads++;
						return {};
					},
					save: async () => undefined,
				},
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [] },
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});

		const reloads: Promise<unknown>[] = [];
		try {
			const first = services.mcpCommand.reload();
			reloads.push(first);
			await firstPreparation;
			const second = services.mcpCommand.reload();
			reloads.push(second);

			await Promise.resolve();
			expect(settingsLoads).toBe(1);
			expect(preparations).toEqual(["first"]);
			expect((await services.mcpCommand.snapshot()).host.servers).toEqual([]);

			releaseFirstPreparation();
			expect((await first).host.servers.map(({ id }) => id)).toEqual(["first"]);
			const final = await second;

			expect(preparations).toEqual(["first", "second"]);
			expect(final.host.servers.map(({ id }) => id)).toEqual(["second"]);
			expect(final.host.tools).toEqual([
				expect.objectContaining({ serverId: "second", name: "mcp__second__inspect" }),
			]);
			expect((await services.mcpCommand.snapshot()).host).toEqual(final.host);
		} finally {
			releaseFirstPreparation();
			await Promise.allSettled(reloads);
			services.closeUi();
			await resources.close();
		}
	});
});
