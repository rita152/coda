import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, IdGenerator, ToolExecutionContext } from "@coda/agent";
import { createModels } from "@coda/ai";
import type { McpConnection, McpConnector, McpServerDefinition } from "@coda/mcp";
import { createRunCapabilityHost, type RunToolContribution } from "@coda/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createApplicationSettingsState,
	loadProjectSkills,
	openProjectServices,
	type ProjectPluginSource,
	type ProjectServices,
} from "../../src/app/project-runtime.ts";
import { createWorkspaceSessionResources } from "../../src/app/workspace-session.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createWorkspace } from "../../src/host/workspace.ts";
import { createMcpCapabilitySource } from "../../src/mcp/run-capability.ts";
import { createCodingPluginInstallationStore } from "../../src/plugins/installation-store.ts";
import { createCodingPluginsManager, materializeCodingPluginMcpDefinitions } from "../../src/plugins/inventory.ts";
import { createPluginsCapabilitySource } from "../../src/plugins/run-capability.ts";
import type { CodingPluginsSnapshot } from "../../src/plugins/types.ts";
import { createSkillsCapabilitySource } from "../../src/skills/run-capability.ts";
import { createNodeSkillWatcherFactory } from "../../src/skills/watcher.ts";
import { testTimeRuntime } from "../time-runtime.ts";

const temporaryDirectories: string[] = [];
const runModel = Object.freeze({
	id: "model",
	name: "Model",
	api: "test",
	provider: "provider",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text" as const],
	contextWindow: 128_000,
	maxTokens: 16_000,
});
const emptyPlugins: CodingPluginsSnapshot = Object.freeze({
	installations: Object.freeze([]),
	plugins: Object.freeze([]),
	snapshots: Object.freeze([]),
	skills: Object.freeze([]),
	mcpSources: Object.freeze([]),
	diagnostics: Object.freeze([]),
});

class ProjectRuntimeTestIds implements IdGenerator {
	#next = 0;

	generate(): string {
		return `project-runtime-${++this.#next}`;
	}
}

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function distinctEmptyPlugins(): CodingPluginsSnapshot {
	return Object.freeze({
		installations: Object.freeze([]),
		plugins: Object.freeze([]),
		snapshots: Object.freeze([]),
		skills: Object.freeze([]),
		mcpSources: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
}

function projectCapabilityHost(acquireProjectBundle: ProjectServices["acquireRunCapabilityBundle"]) {
	return createRunCapabilityHost({
		model: {
			acquire: () => ({
				model: runModel,
				revision: "model:1",
				stream: () => {
					throw new Error("not used");
				},
				complete: async () => {
					throw new Error("not used");
				},
				dispose: () => undefined,
			}),
		},
		contributors: [
			createSkillsCapabilitySource({ acquireProjectBundle }),
			createPluginsCapabilitySource({ acquireProjectBundle }),
			createMcpCapabilitySource({ acquireProjectBundle }),
		],
		now: () => 0,
		platform: "linux",
		interactionMode: "evaluation",
	});
}

function acquireProjectCapabilities(host: ReturnType<typeof projectCapabilityHost>) {
	return host.acquire({
		selection: { model: runModel, reasoning: "off", authSnapshot: { auth: {} } },
		placement: { placementId: "main", root: "/workspace", baseIdentity: "base", kind: "memory" },
		mode: "write",
		baseTools: Object.freeze([]),
		bindTools: (tools: readonly RunToolContribution[]): readonly AgentTool[] => tools.map(({ tool }) => tool),
		signal: new AbortController().signal,
	});
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Project MCP reload", () => {
	it("publishes an automatic degraded-to-ready reconnect to the next UI snapshot and Run without changing an active lease", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-auto-reconnect-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-auto-reconnect-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(100);
		const definition: McpServerDefinition = {
			id: "opaque-plugin-server",
			semanticName: "portable-tools:docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://docs.example.test/mcp" },
		};
		let connectionAttempts = 0;
		const connector: McpConnector = {
			connect: async () => {
				connectionAttempts++;
				if (connectionAttempts === 1) throw new Error("initial connection failed");
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{
							name: "search",
							description: "Search portable documentation",
							inputSchema: { type: "object", properties: {} },
						},
					],
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		let scheduledReconnect: (() => void | Promise<void>) | undefined;
		const scheduler = {
			schedule: (_delayMs: number, run: () => void | Promise<void>) => {
				scheduledReconnect = run;
				return {
					cancel: () => {
						if (scheduledReconnect === run) scheduledReconnect = undefined;
					},
				};
			},
		};
		const skills = await loadProjectSkills({
			workspace: workspace.root,
			homeDirectory,
			fileSystem,
		});
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock, scheduler },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [definition] },
			agentPluginServerIds: [definition.id],
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		const active = await services.acquireRunCapabilityBundle(new AbortController().signal);
		try {
			expect(active.mcp.servers).toEqual([expect.objectContaining({ id: definition.id, status: "degraded" })]);
			expect(scheduledReconnect).toBeTypeOf("function");
			void scheduledReconnect!();
			await vi.waitFor(() => expect(services.mcpRegistry!.snapshot().servers[0]?.status).toBe("ready"));
			await vi.waitFor(() => expect(services.capabilityCatalogSnapshot().mcp.servers[0]?.status).toBe("ready"));

			expect((await services.mcpCommand.snapshot()).host.servers[0]?.status).toBe("ready");
			expect(
				services.commandRegistry.findExact("portable-tools:docs", {
					location: "token_boundary",
					trigger: "$",
				}),
			).toHaveLength(1);
			expect(active.mcp.servers[0]?.status).toBe("degraded");
			expect(active.mcp.tools).toEqual([]);

			const next = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(next.mcp.servers[0]?.status).toBe("ready");
				expect(next.mcp.tools).toEqual([
					expect.objectContaining({ serverId: definition.id, serverSemanticName: "portable-tools:docs" }),
				]);
			} finally {
				await next.dispose();
			}
		} finally {
			await active.dispose();
			services.closeUi();
			await resources.close();
		}
	});

	it("publishes a ready Server connection loss as degraded before its scheduled reconnect without changing an active lease", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-connection-loss-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-connection-loss-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(110);
		const definition: McpServerDefinition = {
			id: "opaque-plugin-server",
			semanticName: "portable-tools:docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://docs.example.test/mcp" },
		};
		let closeActiveConnection: ((error?: Error) => void) | undefined;
		const connector: McpConnector = {
			connect: async (_server, context) => {
				closeActiveConnection = context?.onClose;
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{
							name: "search",
							description: "Search portable documentation",
							inputSchema: { type: "object", properties: {} },
						},
					],
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		let scheduledReconnect: (() => void | Promise<void>) | undefined;
		const scheduler = {
			schedule: (_delayMs: number, run: () => void | Promise<void>) => {
				scheduledReconnect = run;
				return {
					cancel: () => {
						if (scheduledReconnect === run) scheduledReconnect = undefined;
					},
				};
			},
		};
		const skills = await loadProjectSkills({
			workspace: workspace.root,
			homeDirectory,
			fileSystem,
		});
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock, scheduler },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [definition] },
			agentPluginServerIds: [definition.id],
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		const active = await services.acquireRunCapabilityBundle(new AbortController().signal);
		try {
			expect(active.mcp.servers[0]?.status).toBe("ready");
			expect(active.mcp.tools).toHaveLength(1);
			expect(closeActiveConnection).toBeTypeOf("function");
			closeActiveConnection!(new Error("connection lost"));

			await vi.waitFor(() => expect(services.capabilityCatalogSnapshot().mcp.servers[0]?.status).toBe("degraded"));
			expect((await services.mcpCommand.snapshot()).host.servers[0]).toEqual(
				expect.objectContaining({ status: "degraded", error: "connection lost" }),
			);
			expect(
				services.commandRegistry.findExact("portable-tools:docs", {
					location: "token_boundary",
					trigger: "$",
				}),
			).toEqual([]);
			expect(scheduledReconnect).toBeTypeOf("function");
			expect(active.mcp.servers[0]?.status).toBe("ready");
			expect(active.mcp.tools).toHaveLength(1);

			const next = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(next.mcp.servers[0]?.status).toBe("degraded");
				expect(next.mcp.tools).toEqual([]);
			} finally {
				await next.dispose();
			}
		} finally {
			await active.dispose();
			services.closeUi();
			await resources.close();
		}
	});

	it("orders automatic reconnect publication behind a concurrent full Project refresh", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-reconnect-refresh-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-reconnect-refresh-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(120);
		const initialDefinition: McpServerDefinition = {
			id: "initial-plugin-server",
			semanticName: "initial-tools:docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://initial.example.test/mcp" },
		};
		const refreshedDefinition: McpServerDefinition = {
			id: "refreshed-plugin-server",
			semanticName: "refreshed-tools:docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://refreshed.example.test/mcp" },
		};
		const initialPlugins = distinctEmptyPlugins();
		const refreshedPlugins = distinctEmptyPlugins();
		let inventory = initialPlugins;
		const refreshEntered = deferred();
		const refreshRelease = deferred();
		const plugins: ProjectPluginSource = {
			watchRoots: [],
			inventory: () => inventory,
			skillSnapshots: () => [],
			refresh: async () => {
				refreshEntered.resolve();
				await refreshRelease.promise;
				inventory = refreshedPlugins;
				return inventory;
			},
			mcpDefinitions: async () => ({
				definitions: [refreshedDefinition],
				agentPluginServerIds: [refreshedDefinition.id],
			}),
		};
		let initialConnectionAttempts = 0;
		const connector: McpConnector = {
			connect: async (server) => {
				if (server.id === initialDefinition.id && initialConnectionAttempts++ === 0) {
					throw new Error("initial connection failed");
				}
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{
							name: "inspect",
							description: `Inspect through ${server.semanticName ?? server.id}`,
							inputSchema: { type: "object", properties: {} },
						},
					],
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		let scheduledReconnect: (() => void | Promise<void>) | undefined;
		const scheduler = {
			schedule: (_delayMs: number, run: () => void | Promise<void>) => {
				scheduledReconnect = run;
				return {
					cancel: () => {
						if (scheduledReconnect === run) scheduledReconnect = undefined;
					},
				};
			},
		};
		const skills = await loadProjectSkills({
			workspace: workspace.root,
			homeDirectory,
			fileSystem,
			plugins,
		});
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock, scheduler },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [initialDefinition] },
			agentPluginServerIds: [initialDefinition.id],
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		const initialCatalog = services.capabilityCatalogSnapshot();
		const registryEvents: Array<{
			readonly eventServerId: string | undefined;
			readonly eventStatus: string | undefined;
			readonly published: ReturnType<typeof services.capabilityCatalogSnapshot>;
		}> = [];
		const detach = services.mcpRegistry!.onDidChange((snapshot) => {
			registryEvents.push({
				eventServerId: snapshot.servers[0]?.id,
				eventStatus: snapshot.servers[0]?.status,
				published: services.capabilityCatalogSnapshot(),
			});
		});
		let refresh: Promise<void> | undefined;
		try {
			refresh = services.refreshProject();
			await refreshEntered.promise;
			expect(scheduledReconnect).toBeTypeOf("function");
			void scheduledReconnect!();
			await vi.waitFor(() =>
				expect(services.mcpRegistry!.snapshot().servers[0]).toEqual(
					expect.objectContaining({ id: initialDefinition.id, status: "ready" }),
				),
			);

			expect(services.capabilityCatalogSnapshot()).toBe(initialCatalog);
			expect(initialCatalog.plugins).toBe(initialPlugins);
			expect(initialCatalog.mcp.servers[0]?.status).toBe("degraded");
			refreshRelease.resolve();
			await refresh;
			await new Promise<void>((resolve) => setImmediate(resolve));

			const automaticReconnectEvent = registryEvents.find(
				({ eventServerId, eventStatus }) => eventServerId === initialDefinition.id && eventStatus === "ready",
			);
			expect(automaticReconnectEvent?.published).toBe(initialCatalog);
			const fullReloadEvent = registryEvents.find(
				({ eventServerId, eventStatus }) => eventServerId === refreshedDefinition.id && eventStatus === "ready",
			);
			expect(fullReloadEvent?.published).toBe(initialCatalog);

			const finalCatalog = services.capabilityCatalogSnapshot();
			expect(finalCatalog.plugins).toBe(refreshedPlugins);
			expect(finalCatalog.skills).not.toBe(initialCatalog.skills);
			expect(finalCatalog.agentPluginServerIds).toEqual([refreshedDefinition.id]);
			expect(finalCatalog.mcp.servers).toEqual([
				expect.objectContaining({ id: refreshedDefinition.id, status: "ready" }),
			]);
			expect(
				services.commandRegistry.findExact("refreshed-tools:docs", {
					location: "token_boundary",
					trigger: "$",
				}),
			).toHaveLength(1);
			expect(
				services.commandRegistry.findExact("initial-tools:docs", {
					location: "token_boundary",
					trigger: "$",
				}),
			).toEqual([]);
		} finally {
			refreshRelease.resolve();
			await Promise.allSettled(refresh ? [refresh] : []);
			detach();
			services.closeUi();
			await resources.close();
		}
	});

	it.each(["plugin", "skills", "mcp"] as const)(
		"holds Run capture behind the complete %s-stage Project refresh",
		async (blockedStage) => {
			const workspaceRoot = await temporaryDirectory(`coda-project-runtime-${blockedStage}-workspace-`);
			const homeDirectory = await temporaryDirectory(`coda-project-runtime-${blockedStage}-home-`);
			const fileSystem = createNodeFileSystem();
			const workspace = await createWorkspace(workspaceRoot, fileSystem);
			await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
			const runtime = testTimeRuntime(125);
			const stageEntered = deferred();
			const stageRelease = deferred();
			const initialPlugins = distinctEmptyPlugins();
			const refreshedPlugins = distinctEmptyPlugins();
			let inventory = initialPlugins;
			let refreshing = false;
			const definition = (id: string): McpServerDefinition => ({
				id,
				protocol: "auto",
				transport: { kind: "http", url: `https://${id}.example.test/mcp` },
			});
			const plugins: ProjectPluginSource = {
				watchRoots: [],
				inventory: () => inventory,
				skillSnapshots: async () => {
					if (refreshing && blockedStage === "skills") {
						stageEntered.resolve();
						await stageRelease.promise;
					}
					return [];
				},
				refresh: async () => {
					refreshing = true;
					inventory = refreshedPlugins;
					if (blockedStage === "plugin") {
						stageEntered.resolve();
						await stageRelease.promise;
					}
					return inventory;
				},
				mcpDefinitions: async () => ({
					definitions: [definition("refreshed")],
					agentPluginServerIds: ["refreshed"],
				}),
			};
			const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
			const connector: McpConnector = {
				connect: async (server) => {
					if (server.id === "refreshed" && blockedStage === "mcp") {
						stageEntered.resolve();
						await stageRelease.promise;
					}
					return {
						info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
						listTools: async () => [
							{ name: "inspect", description: server.id, inputSchema: { type: "object", properties: {} } },
						],
						callTool: async () => ({ isError: false, content: [] }),
						close: async () => undefined,
					};
				},
			};
			const resources = createWorkspaceSessionResources();
			const services = await openProjectServices({
				options: {
					models: createModels({ runtime }),
					settings: { load: async () => ({}), save: async () => undefined },
					fileSystem,
					io: { stderr: { isTTY: false, write: async () => undefined } },
					mcpConnector: connector,
					runtime: { homeDirectory, environment: {}, clock: runtime.clock },
				},
				settings: createApplicationSettingsState({}),
				workspace,
				mcpConfiguration: { definitions: [definition("initial")] },
				agentPluginServerIds: ["initial"],
				skills,
				interactive: false,
				diagnostics: async () => undefined,
				resources,
				hooks: {
					snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
				},
			});
			const initialSkills = skills.snapshot;
			let captureSettled = false;
			try {
				expect(services.capabilityCatalogSnapshot().agentPluginServerIds).toEqual(["initial"]);
				expect(Object.isFrozen(services.capabilityCatalogSnapshot().agentPluginServerIds)).toBe(true);
				const refresh = services.mcpCommand.reload();
				await stageEntered.promise;
				const capture = Promise.resolve(services.acquireRunCapabilityBundle(new AbortController().signal)).then(
					(bundle) => {
						captureSettled = true;
						return bundle;
					},
				);
				await Promise.resolve();
				expect(captureSettled).toBe(false);

				stageRelease.resolve();
				await refresh;
				const bundle = await capture;
				expect(bundle.plugins).toBe(refreshedPlugins);
				expect(bundle.skills).not.toBe(initialSkills);
				expect(bundle.mcp.servers.map(({ id }) => id)).toEqual(["refreshed"]);
				expect(services.capabilityCatalogSnapshot().agentPluginServerIds).toEqual(["refreshed"]);
				await bundle.dispose();
			} finally {
				stageRelease.resolve();
				services.closeUi();
				await resources.close();
			}
		},
	);

	it("blocks Run acquisition on externally committed Plugin state until a full refresh succeeds", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-dirty-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-dirty-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const initialPlugins = distinctEmptyPlugins();
		const refreshedPlugins = distinctEmptyPlugins();
		let rejectRefresh = true;
		let refreshes = 0;
		const plugins: ProjectPluginSource = {
			watchRoots: [],
			inventory: () => initialPlugins,
			skillSnapshots: () => [],
			refresh: async () => {
				refreshes++;
				if (rejectRefresh) throw new Error("committed Plugin state is temporarily unreadable");
				return refreshedPlugins;
			},
			mcpDefinitions: async () => ({ definitions: [], agentPluginServerIds: [] }),
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const runtime = testTimeRuntime(150);
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
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
		try {
			services.markProjectDirty();
			await expect(services.refreshProject()).rejects.toThrow("temporarily unreadable");
			await expect(services.acquireRunCapabilityBundle(new AbortController().signal)).rejects.toThrow(
				"temporarily unreadable",
			);
			expect(refreshes).toBe(2);

			rejectRefresh = false;
			const recovered = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(recovered.plugins).toBe(refreshedPlugins);
				expect(refreshes).toBe(3);
			} finally {
				await recovered.dispose();
			}
		} finally {
			services.closeUi();
			await resources.close();
		}
	});

	it("rolls back a failed full reload and retires the old MCP Process only after its active Run lease", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-rollback-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-rollback-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(175);
		const initialPlugins = distinctEmptyPlugins();
		const refreshedPlugins = distinctEmptyPlugins();
		let inventory = initialPlugins;
		let rejectReload = true;
		const definition = (id: string): McpServerDefinition => ({
			id,
			protocol: "auto",
			transport: { kind: "http", url: `https://${id}.example.test/mcp` },
		});
		const plugins: ProjectPluginSource = {
			watchRoots: [],
			inventory: () => inventory,
			skillSnapshots: () => [],
			refresh: async () => {
				inventory = refreshedPlugins;
				return inventory;
			},
			mcpDefinitions: async () => {
				const id = rejectReload ? "INVALID ID" : "refreshed";
				return { definitions: [definition(id)], agentPluginServerIds: [id] };
			},
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const closeCounts = new Map<string, number>();
		const connector: McpConnector = {
			connect: async (server) => ({
				info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
				listTools: async () => [
					{ name: "inspect", description: server.id, inputSchema: { type: "object", properties: {} } },
				],
				callTool: async () => ({ isError: false, content: [{ type: "text", text: server.id }] }),
				close: async () => {
					closeCounts.set(server.id, (closeCounts.get(server.id) ?? 0) + 1);
				},
			}),
		};
		const diagnostics: string[] = [];
		const settingsState = createApplicationSettingsState({ plugins: { "fixture@user-local": { enabled: true } } });
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: {
					load: async () => ({ plugins: { "fixture@user-local": { enabled: false } } }),
					save: async () => undefined,
				},
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: settingsState,
			workspace,
			mcpConfiguration: { definitions: [definition("initial")] },
			agentPluginServerIds: ["initial"],
			skills,
			interactive: false,
			diagnostics: async ({ code }) => {
				diagnostics.push(code);
			},
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});

		const active = await services.acquireRunCapabilityBundle(new AbortController().signal);
		const initialSkills = active.skills;
		try {
			await expect(services.mcpCommand.reload()).rejects.toThrow("Invalid MCP Server id");
			const afterFailure = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(afterFailure.revision).toBe(active.revision);
				expect(afterFailure.plugins).toBe(initialPlugins);
				expect(afterFailure.skills).toBe(initialSkills);
				expect(services.capabilityCatalogSnapshot().skills).toBe(initialSkills);
				expect(afterFailure.mcp.servers.map(({ id }) => id)).toEqual(["initial"]);
				expect(settingsState.current.plugins?.["fixture@user-local"]?.enabled).toBe(true);
				expect(diagnostics).toContain("project-capabilities.refresh-failed");
			} finally {
				await afterFailure.dispose();
			}

			rejectReload = false;
			await services.mcpCommand.reload();
			const next = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(next.revision).not.toBe(active.revision);
				expect(next.plugins).toBe(refreshedPlugins);
				expect(next.skills).not.toBe(initialSkills);
				expect(next.mcp.servers.map(({ id }) => id)).toEqual(["refreshed"]);
				expect(closeCounts.get("initial") ?? 0).toBe(0);
				await expect(
					active.mcp.callTool({
						toolId: "mcp:initial:inspect",
						arguments: {},
					}),
				).resolves.toMatchObject({ content: [{ type: "text", text: "initial" }] });
			} finally {
				await next.dispose();
			}
		} finally {
			await active.dispose();
			expect(closeCounts.get("initial")).toBe(1);
			services.closeUi();
			await resources.close();
		}
	});

	it("switches Plugin prompt, Skill, MCP, and Process together on in-process disable and re-enable", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-enablement-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-enablement-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const pluginRoot = join(homeDirectory, ".agents", "plugins", "portable-tools");
		await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
		await writeFile(
			join(pluginRoot, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "portable-tools",
			}),
		);
		await writeFile(
			join(pluginRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review through the portable Plugin\n---\n\nReview the project.\n",
		);
		await writeFile(
			join(pluginRoot, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { docs: { type: "streamable-http", url: "https://docs.example.test/mcp" } },
			}),
		);
		const manager = createCodingPluginsManager({
			workspace: workspace.root,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
		});
		let inventory = await manager.refresh();
		const plugins: ProjectPluginSource = Object.freeze({
			watchRoots: Object.freeze([]),
			inventory: () => inventory,
			skillSnapshots: () => inventory.skills,
			refresh: async (settings: Parameters<ProjectPluginSource["refresh"]>[0]) => {
				inventory = await manager.refresh({ enablement: settings.plugins ?? {} });
				return inventory;
			},
			mcpDefinitions: async ({ reservedServerIds }: Parameters<ProjectPluginSource["mcpDefinitions"]>[0]) => {
				const materialized = await materializeCodingPluginMcpDefinitions({
					sources: inventory.mcpSources,
					baseEnvironment: {},
					platform: "linux",
					reservedServerIds,
				});
				return Object.freeze({
					definitions: materialized.definitions,
					agentPluginServerIds: Object.freeze(materialized.entries.map(({ definition }) => definition.id)),
				});
			},
		});
		const skills = await loadProjectSkills({
			workspace: workspace.root,
			homeDirectory,
			fileSystem,
			plugins,
		});
		const initialMcp = await plugins.mcpDefinitions({ settings: {}, reservedServerIds: [] });
		let latestSettings = {};
		let connectionGeneration = 0;
		const closed: number[] = [];
		const calls: number[] = [];
		const connector: McpConnector = {
			connect: async () => {
				const generation = ++connectionGeneration;
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{
							name: "inspect",
							description: "Inspect with the portable Plugin",
							inputSchema: { type: "object", properties: {} },
						},
					],
					callTool: async () => {
						calls.push(generation);
						return { isError: false, content: [{ type: "text", text: `generation:${generation}` }] };
					},
					close: async () => {
						closed.push(generation);
					},
				};
			},
		};
		const runtime = testTimeRuntime(225);
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => latestSettings, save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: initialMcp.definitions },
			agentPluginServerIds: initialMcp.agentPluginServerIds,
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		const host = projectCapabilityHost(services.acquireRunCapabilityBundle);
		const enabled = await acquireProjectCapabilities(host);
		try {
			expect(enabled.prompt.text).toContain("<plugins_instructions>");
			expect(enabled.prompt.text).toContain("portable-tools:review");
			expect(enabled.tools.map(({ name }) => name)).toContain("mcp__plugin_portable-tools_docs__inspect");
			expect(connectionGeneration).toBe(1);

			latestSettings = { plugins: { "portable-tools@user-local": { enabled: false } } };
			await services.refreshProject();
			const disabled = await acquireProjectCapabilities(host);
			try {
				expect(disabled.prompt.text).not.toContain("<plugins_instructions>");
				expect(disabled.prompt.text).not.toContain("portable-tools:review");
				expect(disabled.tools.map(({ name }) => name)).not.toContain("mcp__plugin_portable-tools_docs__inspect");
				expect(connectionGeneration).toBe(1);
				expect(closed).toEqual([]);
			} finally {
				await disabled.dispose();
			}

			latestSettings = {};
			await services.mcpCommand.reload();
			const reenabled = await acquireProjectCapabilities(host);
			try {
				expect(reenabled.prompt.text).toContain("<plugins_instructions>");
				expect(reenabled.prompt.text).toContain("portable-tools:review");
				expect(reenabled.tools.map(({ name }) => name)).toContain("mcp__plugin_portable-tools_docs__inspect");
				expect(connectionGeneration).toBe(2);
				const retainedTool = enabled.tools.find(({ name }) => name === "mcp__plugin_portable-tools_docs__inspect");
				await expect(
					retainedTool!.execute({}, {
						signal: new AbortController().signal,
						runId: "run:old",
						turnId: "turn:old",
						invocationId: "invocation:old",
						resultMessageId: "message:old",
						providerToolCallId: "provider:old",
					} as ToolExecutionContext),
				).resolves.toMatchObject({ observation: { status: "ok" } });
				expect(calls).toEqual([1]);
			} finally {
				await reenabled.dispose();
			}
		} finally {
			await enabled.dispose();
			expect(closed).toEqual([1]);
			services.closeUi();
			await resources.close();
		}
	});

	it("keeps a removed managed Plugin Skill usable by its active Run and collects it after release", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-retained-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-retained-home-");
		const sourceRoot = join(await temporaryDirectory("coda-project-runtime-retained-source-"), "retained-tools");
		await mkdir(join(sourceRoot, "skills", "review"), { recursive: true });
		await writeFile(
			join(sourceRoot, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "retained-tools",
				version: "1.0.0",
			}),
		);
		await writeFile(
			join(sourceRoot, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review through a retained Plugin\n---\n\nRetained instructions.\n",
		);
		const baseFileSystem = createNodeFileSystem();
		let selectedRoot = "";
		let selectedRootCleanupCount = 0;
		const fileSystem = {
			...baseFileSystem,
			removeDirectory: async (path: string) => {
				if (path === selectedRoot) selectedRootCleanupCount++;
				await baseFileSystem.removeDirectory(path);
			},
		};
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const installationStore = createCodingPluginInstallationStore({
			root: join(homeDirectory, ".coda", "plugins", "installations"),
			fileSystem,
			idGenerator: new ProjectRuntimeTestIds(),
		});
		const installed = await installationStore.install({
			entry: {
				pluginId: "retained-tools@team-market",
				name: "retained-tools",
				marketplace: "team-market",
				source: { source: "local", path: "./retained-tools", root: sourceRoot },
			},
			packageRoot: sourceRoot,
		});
		selectedRoot = installed.selectedRoot;
		const manager = createCodingPluginsManager({
			workspace: workspace.root,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
			managedInstallations: [installed],
			verifyManagedInstallation: (record, options) => installationStore.verify(record, options),
		});
		let inventory = await manager.refresh();
		const managedRoots = (snapshot: CodingPluginsSnapshot): readonly string[] =>
			Object.freeze(
				snapshot.installations
					.filter(({ source }) => source !== "workspace-local" && source !== "user-local")
					.map(({ origin }) => origin.root),
			);
		const plugins: ProjectPluginSource = Object.freeze({
			watchRoots: Object.freeze([]),
			inventory: () => inventory,
			skillSnapshots: () => inventory.skills,
			refresh: async () => {
				inventory = await manager.refresh({
					managedInstallations: (await installationStore.list()).installations,
				});
				return inventory;
			},
			retainRunRevisions: (snapshot: CodingPluginsSnapshot, signal?: AbortSignal) =>
				installationStore.retainRevisions(managedRoots(snapshot), { signal }),
			collectRetiredRevisions: (signal?: AbortSignal) => installationStore.collectRetiredRevisions({ signal }),
			mcpDefinitions: async () => ({ definitions: [], agentPluginServerIds: [] }),
		});
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const runtime = testTimeRuntime(240);
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
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
		const host = projectCapabilityHost(services.acquireRunCapabilityBundle);
		const active = await acquireProjectCapabilities(host);
		try {
			expect(active.prompt.text).toContain("retained-tools:review");
			await installationStore.remove(installed.pluginId);
			await services.refreshProject();

			expect((await fileSystem.lstat(installed.selectedRoot)).kind).toBe("directory");
			const later = await acquireProjectCapabilities(host);
			try {
				expect(later.prompt.text).not.toContain("retained-tools:review");
				expect(later.tools.map(({ name }) => name)).not.toContain("skill");
				const skill = active.tools.find(({ name }) => name === "skill");
				await expect(
					skill!.execute({ skill: "retained-tools:review" }, {
						signal: new AbortController().signal,
						runId: "run:retained",
						turnId: "turn:retained",
						invocationId: "invocation:retained",
						resultMessageId: "message:retained",
						providerToolCallId: "provider:retained",
					} as ToolExecutionContext),
				).resolves.toMatchObject({ content: expect.stringContaining("Retained instructions") });
			} finally {
				await later.dispose();
			}
		} finally {
			await active.dispose();
		}
		await expect(fileSystem.lstat(installed.selectedRoot)).rejects.toMatchObject({ code: "ENOENT" });
		expect(selectedRootCleanupCount).toBe(1);
		services.closeUi();
		await resources.close();
	});

	it.each(["workspace", "user"] as const)(
		"freezes a direct %s Plugin Skill for an active Run before its directory is deleted",
		async (scope) => {
			const workspaceRoot = await temporaryDirectory(`coda-project-runtime-direct-${scope}-workspace-`);
			const homeDirectory = await temporaryDirectory(`coda-project-runtime-direct-${scope}-home-`);
			const fileSystem = createNodeFileSystem();
			const workspace = await createWorkspace(workspaceRoot, fileSystem);
			await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
			const pluginRoot = join(
				scope === "workspace" ? workspace.root : homeDirectory,
				".agents",
				"plugins",
				"direct-tools",
			);
			await mkdir(join(pluginRoot, "skills", "review"), { recursive: true });
			await writeFile(
				join(pluginRoot, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "direct-tools",
				}),
			);
			await writeFile(
				join(pluginRoot, "skills", "review", "SKILL.md"),
				"---\nname: review\ndescription: Direct review workflow\n---\n\nFrozen direct instructions.\n",
			);
			const manager = createCodingPluginsManager({
				workspace: workspace.root,
				userHome: homeDirectory,
				dataRoot: join(homeDirectory, ".coda", "plugin-data"),
				fileSystem,
			});
			let inventory = await manager.refresh();
			const plugins: ProjectPluginSource = Object.freeze({
				watchRoots: Object.freeze([]),
				inventory: () => inventory,
				skillSnapshots: () => inventory.skills,
				refresh: async (settings: Parameters<ProjectPluginSource["refresh"]>[0]) => {
					inventory = await manager.refresh({ enablement: settings.plugins ?? {} });
					return inventory;
				},
				mcpDefinitions: async () => ({ definitions: [], agentPluginServerIds: [] }),
			});
			const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
			const runtime = testTimeRuntime(scope === "workspace" ? 245 : 246);
			const resources = createWorkspaceSessionResources();
			const services = await openProjectServices({
				options: {
					models: createModels({ runtime }),
					settings: { load: async () => ({}), save: async () => undefined },
					fileSystem,
					io: { stderr: { isTTY: false, write: async () => undefined } },
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
			const host = projectCapabilityHost(services.acquireRunCapabilityBundle);
			const active = await acquireProjectCapabilities(host);
			try {
				await rm(pluginRoot, { recursive: true, force: true });
				const skill = active.tools.find(({ name }) => name === "skill");
				await expect(
					skill!.execute({ skill: "direct-tools:review" }, {
						signal: new AbortController().signal,
						runId: `run:direct-${scope}`,
						turnId: `turn:direct-${scope}`,
						invocationId: `invocation:direct-${scope}`,
						resultMessageId: `message:direct-${scope}`,
						providerToolCallId: `provider:direct-${scope}`,
					} as ToolExecutionContext),
				).resolves.toMatchObject({ content: expect.stringContaining("Frozen direct instructions") });
				await services.refreshProject();
				const later = await acquireProjectCapabilities(host);
				try {
					expect(later.prompt.text).not.toContain("direct-tools:review");
				} finally {
					await later.dispose();
				}
			} finally {
				await active.dispose();
				services.closeUi();
				await resources.close();
			}
		},
	);

	it("serializes a tools-changed MCP refresh and Project refresh into distinct Run bundles", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-tools-changed-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-tools-changed-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(275);
		const initialPlugins = distinctEmptyPlugins();
		const refreshedPlugins = distinctEmptyPlugins();
		let inventory = initialPlugins;
		const definition: McpServerDefinition = {
			id: "docs",
			protocol: "auto",
			transport: { kind: "http", url: "https://docs.example.test/mcp" },
		};
		const plugins: ProjectPluginSource = {
			watchRoots: [],
			inventory: () => inventory,
			skillSnapshots: () => [],
			refresh: async () => {
				inventory = refreshedPlugins;
				return inventory;
			},
			mcpDefinitions: async () => ({ definitions: [definition], agentPluginServerIds: ["docs"] }),
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const refreshEntered = deferred();
		const releaseRefresh = deferred();
		let toolName = "first";
		let blockToolRefresh = false;
		let notifyToolsChanged: (() => void) | undefined;
		const connector: McpConnector = {
			connect: async (_server, context) => {
				notifyToolsChanged = context?.onToolsChanged;
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => {
						if (blockToolRefresh) {
							refreshEntered.resolve();
							await releaseRefresh.promise;
							blockToolRefresh = false;
						}
						return [{ name: toolName, description: toolName, inputSchema: { type: "object", properties: {} } }];
					},
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [definition] },
			agentPluginServerIds: ["docs"],
			skills,
			interactive: false,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		try {
			toolName = "second";
			blockToolRefresh = true;
			notifyToolsChanged!();
			const capture = Promise.resolve(services.acquireRunCapabilityBundle(new AbortController().signal));
			await refreshEntered.promise;
			let fullRefreshSettled = false;
			const fullRefresh = services.skillsCommand.refresh().then((snapshot) => {
				fullRefreshSettled = true;
				return snapshot;
			});
			await Promise.resolve();
			expect(fullRefreshSettled).toBe(false);

			releaseRefresh.resolve();
			const toolsChangedBundle = await capture;
			await fullRefresh;
			const fullyRefreshedBundle = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(toolsChangedBundle.plugins).toBe(initialPlugins);
				expect(toolsChangedBundle.mcp.tools.map(({ remoteName }) => remoteName)).toEqual(["second"]);
				expect(fullyRefreshedBundle.plugins).toBe(refreshedPlugins);
				expect(fullyRefreshedBundle.mcp.tools.map(({ remoteName }) => remoteName)).toEqual(["second"]);
				expect(fullyRefreshedBundle.revision).not.toBe(toolsChangedBundle.revision);
			} finally {
				await toolsChangedBundle.dispose();
				await fullyRefreshedBundle.dispose();
			}
		} finally {
			releaseRefresh.resolve();
			services.closeUi();
			await resources.close();
		}
	});

	it("refreshes Plugin Skill and MCP contributions together after a watched package change", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-watch-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-watch-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const runtime = testTimeRuntime(250);
		const definition = (id: string): McpServerDefinition => ({
			id,
			protocol: "auto",
			transport: { kind: "http", url: `https://${id}.example.test/mcp` },
		});
		let pluginRevision = "first";
		let pluginRefreshes = 0;
		const plugins: ProjectPluginSource = {
			watchRoots: [join(workspace.root, ".agents", "plugins")],
			inventory: () => emptyPlugins,
			skillSnapshots: () => [],
			refresh: async () => {
				pluginRefreshes++;
				pluginRevision = "second";
				return emptyPlugins;
			},
			mcpDefinitions: async () => ({
				definitions: [definition(pluginRevision)],
				agentPluginServerIds: [pluginRevision],
			}),
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		let watchedChange: (() => void) | undefined;
		let watchedLocations: readonly string[] = [];
		const connector: McpConnector = {
			connect: async (server) => {
				return {
					info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
					listTools: async () => [
						{ name: "inspect", description: server.id, inputSchema: { type: "object", properties: {} } },
					],
					callTool: async () => ({ isError: false, content: [] }),
					close: async () => undefined,
				};
			},
		};
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				skillWatcher: {
					watch: (locations, onChange) => {
						watchedLocations = locations;
						watchedChange = onChange;
						return {
							reconcile: (nextLocations) => {
								watchedLocations = nextLocations;
							},
							dispose: () => undefined,
						};
					},
				},
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [definition("first")] },
			agentPluginServerIds: ["first"],
			skills,
			interactive: true,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});

		try {
			expect(watchedChange).toBeTypeOf("function");
			expect(watchedLocations).toEqual([
				join(workspace.root, ".agents", "skills"),
				join(homeDirectory, ".agents", "skills"),
				join(homeDirectory, ".codex", "skills"),
				join(workspace.root, ".agents", "plugins"),
			]);
			watchedChange!();
			await expect
				.poll(async () => (await services.mcpCommand.snapshot()).host.servers.map(({ id }) => id), { timeout: 500 })
				.toEqual(["second"]);

			expect(pluginRefreshes).toBeGreaterThan(0);
			const lease = services.mcpRegistry!.acquireTools();
			expect(lease.agentPluginServerIds).toEqual(["second"]);
			await lease.dispose();
			const beforeSkillsRefresh = (await services.mcpCommand.snapshot()).host.revision;
			await services.skillsCommand.refresh();
			expect((await services.mcpCommand.snapshot()).host.revision).toBeGreaterThan(beforeSkillsRefresh);
		} finally {
			services.closeUi();
			await resources.close();
		}
	});

	it("tracks canonical targets of direct Plugin slot symlinks across creation, edits, retarget, and removal", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-symlink-watch-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-symlink-watch-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
		const targetsRoot = join(workspace.root, "plugin-targets");
		const firstTarget = join(targetsRoot, "first");
		const secondTarget = join(targetsRoot, "second");
		const slot = join(workspace.root, ".agents", "plugins", "portable-tools");
		const writeTarget = async (root: string, marker: string, version: string): Promise<void> => {
			await mkdir(join(root, "skills", "review"), { recursive: true });
			await writeFile(
				join(root, "plugin.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
					name: "portable-tools",
					version,
				}),
			);
			await writeFile(
				join(root, "skills", "review", "SKILL.md"),
				`---\nname: review\ndescription: Review ${marker}\n---\n\nSkill body ${marker}.\n`,
			);
			await writeFile(
				join(root, "mcp.json"),
				JSON.stringify({
					$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
					mcpServers: {
						docs: { type: "streamable-http", url: `https://${marker}.example.test/mcp` },
					},
				}),
			);
		};
		await Promise.all([writeTarget(firstTarget, "first", "1.0.0"), writeTarget(secondTarget, "second", "2.0.0")]);

		const manager = createCodingPluginsManager({
			workspace: workspace.root,
			userHome: homeDirectory,
			dataRoot: join(homeDirectory, ".coda", "plugin-data"),
			fileSystem,
		});
		let inventory = await manager.refresh();
		const baseWatchRoots = Object.freeze([
			join(workspace.root, ".agents", "plugins"),
			join(homeDirectory, ".agents", "plugins"),
		]);
		const plugins: ProjectPluginSource = {
			get watchRoots() {
				return Object.freeze([
					...baseWatchRoots,
					...inventory.installations.map(({ origin }) => origin.pluginRoot),
				]);
			},
			inventory: () => inventory,
			skillSnapshots: () => inventory.skills,
			refresh: async (settings) => {
				inventory = await manager.refresh({ enablement: settings.plugins ?? {} });
				return inventory;
			},
			mcpDefinitions: async ({ reservedServerIds }) => {
				const materialized = await materializeCodingPluginMcpDefinitions({
					sources: inventory.mcpSources,
					platform: process.platform,
					reservedServerIds,
				});
				return {
					definitions: materialized.definitions,
					agentPluginServerIds: materialized.definitions.map(({ id }) => id),
				};
			},
		};
		const skills = await loadProjectSkills({ workspace: workspace.root, homeDirectory, fileSystem, plugins });
		const connector: McpConnector = {
			connect: async (server) => ({
				info: { protocolEra: "modern", protocolVersion: "2026-07-28" },
				listTools: async () => [
					{
						name: "inspect",
						description: server.transport.kind === "http" ? server.transport.url : server.id,
						inputSchema: { type: "object", properties: {} },
					},
				],
				callTool: async () => ({ isError: false, content: [] }),
				close: async () => undefined,
			}),
		};
		const runtime = testTimeRuntime(260);
		const resources = createWorkspaceSessionResources();
		const services = await openProjectServices({
			options: {
				models: createModels({ runtime }),
				settings: { load: async () => ({}), save: async () => undefined },
				fileSystem,
				io: { stderr: { isTTY: false, write: async () => undefined } },
				mcpConnector: connector,
				skillWatcher: createNodeSkillWatcherFactory(),
				runtime: { homeDirectory, environment: {}, clock: runtime.clock },
			},
			settings: createApplicationSettingsState({}),
			workspace,
			mcpConfiguration: { definitions: [] },
			skills,
			interactive: true,
			diagnostics: async () => undefined,
			resources,
			hooks: {
				snapshot: () => ({ revision: "hooks:none", paths: [], handlers: [], diagnostics: [], events: [] }),
			},
		});
		let stableSkillId: string | undefined;
		const assertNextRun = async (marker: string, version: string): Promise<void> => {
			await expect
				.poll(
					async () => {
						const bundle = await services.acquireRunCapabilityBundle(new AbortController().signal);
						try {
							const resolved = bundle.skills.resolved.find(
								({ qualifiedName }) => qualifiedName === "portable-tools:review",
							);
							const activation = resolved
								? await bundle.skills.activate(resolved.candidate.id).catch(() => undefined)
								: undefined;
							return {
								body: activation?.contents,
								mcp: bundle.mcp.tools[0]?.description,
								version: bundle.plugins.plugins[0]?.snapshot.manifest.version,
							};
						} finally {
							await bundle.dispose();
						}
					},
					{ timeout: 5_000 },
				)
				.toEqual({
					body: expect.stringContaining(`Skill body ${marker}.`),
					mcp: `https://${marker}.example.test/mcp`,
					version,
				});
			const bundle = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				const currentSkillId = String(
					bundle.skills.resolved.find(({ qualifiedName }) => qualifiedName === "portable-tools:review")!.candidate
						.id,
				);
				if (stableSkillId === undefined) stableSkillId = currentSkillId;
				else expect(currentSkillId).toBe(stableSkillId);
			} finally {
				await bundle.dispose();
			}
		};

		try {
			await mkdir(join(workspace.root, ".agents", "plugins"), { recursive: true });
			await symlink(firstTarget, slot, "dir");
			await assertNextRun("first", "1.0.0");

			await writeTarget(firstTarget, "first-edited", "1.1.0");
			await assertNextRun("first-edited", "1.1.0");

			await rm(slot);
			await symlink(secondTarget, slot, "dir");
			await assertNextRun("second", "2.0.0");

			await writeTarget(secondTarget, "second-edited", "2.1.0");
			await assertNextRun("second-edited", "2.1.0");

			await rm(slot);
			await expect
				.poll(() => services.capabilityCatalogSnapshot().plugins.plugins.length, { timeout: 5_000 })
				.toBe(0);
			const emptyRun = await services.acquireRunCapabilityBundle(new AbortController().signal);
			try {
				expect(emptyRun.skills.resolved).toEqual([]);
				expect(emptyRun.mcp.tools).toEqual([]);
			} finally {
				await emptyRun.dispose();
			}
		} finally {
			services.closeUi();
			await resources.close();
		}
	});

	it("publishes overlapping Plugin reload requests in request order", async () => {
		const workspaceRoot = await temporaryDirectory("coda-project-runtime-workspace-");
		const homeDirectory = await temporaryDirectory("coda-project-runtime-home-");
		const fileSystem = createNodeFileSystem();
		const workspace = await createWorkspace(workspaceRoot, fileSystem);
		await writeFile(join(workspace.root, ".git"), "gitdir: fake\n");
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
			inventory: () => emptyPlugins,
			skillSnapshots: () => [],
			refresh: async () => emptyPlugins,
			mcpDefinitions: async () => {
				const index = preparation++;
				preparations.push(definitions[index]!.id);
				if (index === 0) {
					reportFirstPreparation();
					await firstPreparationGate;
				}
				return {
					definitions: [definitions[index]!],
					agentPluginServerIds: [definitions[index]!.id],
				};
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
