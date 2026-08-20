import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { createSdkMcpConnector, type McpConnector } from "@coda/mcp";
import { createSystemScheduler, VirtualTerminal } from "@coda/tui";
import { afterEach, describe, expect, test } from "vitest";
import { FileSettingsStore } from "../../src/app/file-settings-store.ts";
import { createApplicationPluginServices, type PluginsCommand } from "../../src/app/plugin-management.ts";
import type { ApplicationOutput } from "../../src/application.ts";
import { createCodingAgentApplication } from "../../src/application.ts";
import type { CommandFlowMenu, CommandFlowScreen } from "../../src/commands/flow-types.ts";
import type { PluginCommandFlowAction, PluginsCommandFlowSnapshot } from "../../src/commands/plugins-flow.ts";
import type { FileSystem } from "../../src/host/file-system.ts";
import { createNodeFileSystem } from "../../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../../src/host/node-process-runner.ts";
import { createCodingPluginInstallationStore } from "../../src/plugins/installation-store.ts";
import { discoverCodingPlugins, materializeCodingPluginMcpDefinitions } from "../../src/plugins/inventory.ts";
import { type CodingPluginManagement, createCodingPluginManagement } from "../../src/plugins/management.ts";
import { createCodingPluginMarketplaceStore } from "../../src/plugins/marketplace-store.ts";
import { createPluginsCapabilitySource } from "../../src/plugins/run-capability.ts";
import type { CodingPluginId, CodingPluginsSnapshot } from "../../src/plugins/types.ts";
import type { UserSettings } from "../../src/settings/types.ts";
import { CodingSkillsManager } from "../../src/skills/manager.ts";
import { openPluginsCommand } from "../../src/ui/run-interactive.ts";
import { testTimeRuntime } from "../time-runtime.ts";

const OFFICIAL_EXAMPLE_URL = "https://github.com/agentplugins/agent-plugins-example.git";
const OFFICIAL_EXAMPLE_REVISIONS = Object.freeze({
	initial: Object.freeze({
		revision: "8ecba107a5f2b2727d4a9c5c9ba53cc846d8d2bf",
		digests: Object.freeze({
			"plugin.json": "febc5269ac2154f2ca38257e15e126dfb481a5f4558a35bdf126d1ce10aff885",
			"skills/migrate-agent-plugin/SKILL.md": "c5f2ad6011d9a3336b231708cbec6469091f601ca987253b6962323535128ce1",
		}),
	}),
	upgraded: Object.freeze({
		revision: "96eb8c1b473f54d50662b934e1c75dabf927edd9",
		digests: Object.freeze({
			"plugin.json": "febc5269ac2154f2ca38257e15e126dfb481a5f4558a35bdf126d1ce10aff885",
			"skills/migrate-agent-plugin/SKILL.md": "cbcfa4804eaf880593f382f8e873d5c59f57dbb0762e481891c5b1ca1d1db41c",
		}),
	}),
});
const LIVE_MARKETPLACE = "official-example";
const LIVE_PLUGIN_ID = `agent-plugins-example@${LIVE_MARKETPLACE}`;
const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const OPENAI_DOCS_MCP = "https://developers.openai.com/mcp";
const INSTALLED_DIGESTS = Object.freeze({
	initial: "d6ea40261347b56ea2c4eda2e950803b09bc5352f2ce0d29d627b8de3f3d2a6f",
	upgraded: "5cbea0e77cb2a6a58b87988e5c3b563956efb835a764120795ebc93af087f0c1",
});
const REMOTE_INSTALLED_DIGESTS = Object.freeze({
	initial: "b2e043bdf4a19a2d426fe7221bc927b1821aa2cf189f2ecb60f91554858dbc29",
	upgraded: "3f9a6f3e65d88511bda96a0366617ae643e0f4222e9041c9e0cdade1c657346f",
});
const AIUP_REMOTE_URL = "https://github.com/AI-Unified-Process/marketplace.git";
const AIUP_REMOTE_REVISION = "69c475edf8f2eae5fcdb0e54181e4fc00a9ae955";
const AIUP_REMOTE_SUBDIRECTORY = "aiup-core";
const AIUP_MARKETPLACE = "aiup-pinned";
const AIUP_PLUGIN_ID = `aiup-core@${AIUP_MARKETPLACE}`;
const AIUP_CONTEXT7_MCP = "https://mcp.context7.com/mcp";
const AIUP_INSTALLED_DIGEST = "001a1e53e9503edaf9fc8f159f05eed34725273b447297fd0f19afc07c7d7384";
const AIUP_SKILLS = Object.freeze([
	"aiup-core:entity-model",
	"aiup-core:requirements",
	"aiup-core:reverse-engineer",
	"aiup-core:test-case",
	"aiup-core:use-case-diagram",
	"aiup-core:use-case-spec",
]);
const temporaryDirectories: string[] = [];

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}

	take(): string {
		const value = this.value;
		this.value = "";
		return value;
	}
}

class LiveIds implements IdGenerator {
	#next = 0;

	generate(): string {
		return `live-${++this.#next}`;
	}
}

async function temporaryDirectory(label: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `coda-${label}-`));
	temporaryDirectories.push(directory);
	return directory;
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition did not become true");
}

async function within<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Operation did not settle before the live-test deadline")),
			timeoutMs,
		);
		operation.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

type OfficialExamplePath = keyof (typeof OFFICIAL_EXAMPLE_REVISIONS)["initial"]["digests"];
type OfficialExampleRevision = (typeof OFFICIAL_EXAMPLE_REVISIONS)[keyof typeof OFFICIAL_EXAMPLE_REVISIONS];

interface LiveLifecyclePaths {
	readonly workspace: string;
	readonly userHome: string;
	readonly dataRoot: string;
	readonly stateRoot: string;
	readonly settingsHome: string;
}

interface LiveLifecycleRuntime {
	readonly fileSystem: FileSystem;
	readonly settingsStore: FileSettingsStore;
	readonly installationStore: ReturnType<typeof createCodingPluginInstallationStore>;
	readonly management: CodingPluginManagement;
}

interface LiveApplicationFixture {
	readonly application: ReturnType<typeof createCodingAgentApplication>;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly pluginsCommand: PluginsCommand;
	readonly stderr: BufferOutput;
	readonly stdout: BufferOutput;
	readonly terminal: VirtualTerminal;
}

interface LiveApplicationSettingsState {
	current?: UserSettings;
}

interface LiveMcpCallGate {
	readonly connector: McpConnector;
	readonly started: Promise<void>;
	readonly stats: { closeCount: number };
	release(): void;
}

async function download(revision: OfficialExampleRevision, path: OfficialExamplePath): Promise<string> {
	const rawRepository = OFFICIAL_EXAMPLE_URL.replace(
		"https://github.com/",
		"https://raw.githubusercontent.com/",
	).replace(/\.git$/u, "");
	const url = `${rawRepository}/${revision.revision}/${path}`;
	const response = await fetch(url, {
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(`Could not download official Agent Plugin ${revision.revision}/${path}: HTTP ${response.status}`);
	}
	const content = await response.text();
	const digest = createHash("sha256").update(content, "utf8").digest("hex");
	if (digest !== revision.digests[path]) {
		throw new Error(`Official Agent Plugin ${revision.revision}/${path} digest mismatch: ${digest}`);
	}
	return content;
}

async function stageOfficialPackage(
	marketplaceRoot: string,
	directory: string,
	revision: OfficialExampleRevision,
): Promise<string> {
	const pluginRoot = join(marketplaceRoot, ".agents", "plugins", "packages", directory);
	const skillRoot = join(pluginRoot, "skills", "migrate-agent-plugin");
	await mkdir(skillRoot, { recursive: true });
	const [manifest, skill] = await Promise.all([
		download(revision, "plugin.json"),
		download(revision, "skills/migrate-agent-plugin/SKILL.md"),
	]);
	await Promise.all([
		writeFile(join(pluginRoot, "plugin.json"), manifest),
		writeFile(join(skillRoot, "SKILL.md"), skill),
		writeFile(
			join(pluginRoot, "mcp.json"),
			`${JSON.stringify(
				{
					$schema: AGENT_PLUGIN_MCP_SCHEMA,
					mcpServers: {
						"openai-docs": { type: "streamable-http", url: OPENAI_DOCS_MCP },
					},
				},
				undefined,
				2,
			)}\n`,
		),
	]);
	return pluginRoot;
}

async function selectMarketplacePackage(marketplaceRoot: string, directory: string): Promise<void> {
	await writeFile(
		join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
		`${JSON.stringify(
			{
				name: LIVE_MARKETPLACE,
				plugins: [{ name: "agent-plugins-example", source: `./packages/${directory}` }],
			},
			undefined,
			2,
		)}\n`,
	);
}

async function selectRemoteMarketplacePackage(
	marketplaceRoot: string,
	revision: OfficialExampleRevision,
): Promise<void> {
	const metadataRoot = join(marketplaceRoot, ".agents", "plugins");
	await mkdir(metadataRoot, { recursive: true });
	await writeFile(
		join(metadataRoot, "marketplace.json"),
		`${JSON.stringify(
			{
				name: LIVE_MARKETPLACE,
				plugins: [
					{
						name: "agent-plugins-example",
						source: {
							source: "url",
							url: OFFICIAL_EXAMPLE_URL,
							sha: revision.revision,
						},
					},
				],
			},
			undefined,
			2,
		)}\n`,
	);
}

async function selectAiupRemotePackage(marketplaceRoot: string): Promise<void> {
	const metadataRoot = join(marketplaceRoot, ".agents", "plugins");
	await mkdir(metadataRoot, { recursive: true });
	await writeFile(
		join(metadataRoot, "marketplace.json"),
		`${JSON.stringify(
			{
				name: AIUP_MARKETPLACE,
				plugins: [
					{
						name: "aiup-core",
						source: {
							source: "git-subdir",
							url: AIUP_REMOTE_URL,
							path: AIUP_REMOTE_SUBDIRECTORY,
							sha: AIUP_REMOTE_REVISION,
						},
					},
				],
			},
			undefined,
			2,
		)}\n`,
	);
}

function createLiveLifecycleRuntime(
	paths: LiveLifecyclePaths,
	fileSystem: FileSystem = createNodeFileSystem(),
): LiveLifecycleRuntime {
	const ids = new LiveIds();
	const environment = Object.freeze({ PATH: process.env.PATH ?? "/usr/bin:/bin" });
	const processRunner = createNodeProcessRunner({ platform: process.platform });
	const settingsStore = new FileSettingsStore({
		fileSystem,
		homeDirectory: paths.settingsHome,
		idGenerator: ids,
	});
	const marketplaceStore = createCodingPluginMarketplaceStore({
		root: join(paths.stateRoot, "marketplaces"),
		fileSystem,
		processRunner,
		idGenerator: ids,
		environment,
	});
	const installationStore = createCodingPluginInstallationStore({
		root: join(paths.stateRoot, "installations"),
		fileSystem,
		idGenerator: ids,
	});
	const management = createCodingPluginManagement({
		marketplaceStore,
		installationStore,
		fileSystem,
		processRunner,
		idGenerator: ids,
		stagingRoot: join(paths.stateRoot, "staging"),
		environment,
		loadSettings: () => settingsStore.load(),
		saveSettings: (settings) => settingsStore.save(settings),
		onChanged: () => undefined,
	});
	return Object.freeze({ fileSystem, settingsStore, installationStore, management });
}

function createLiveApplication(
	paths: {
		readonly workspace: string;
		readonly homeDirectory: string;
	},
	options: {
		readonly settingsState?: LiveApplicationSettingsState;
		readonly mcpConnector?: McpConnector;
		readonly fileSystem?: FileSystem;
	} = {},
): LiveApplicationFixture {
	const runtime = testTimeRuntime(100);
	const faux = fauxProvider({ runtime });
	const models = createModels({ runtime });
	models.setProvider(faux.provider);
	const settingsState = options.settingsState ?? {};
	settingsState.current ??= Object.freeze({
		defaultModel: Object.freeze({ provider: faux.getModel().provider, id: faux.getModel().id }),
	});
	const settings = {
		load: async () => settingsState.current!,
		save: async (next: UserSettings) => {
			settingsState.current = next;
		},
	};
	const stdout = new BufferOutput();
	const stderr = new BufferOutput();
	const terminal = new VirtualTerminal({ columns: 100, rows: 24 });
	const fileSystem = options.fileSystem ?? createNodeFileSystem();
	const processRunner = createNodeProcessRunner({ platform: process.platform });
	const environment = Object.freeze({
		PATH: process.env.PATH,
		GIT_TERMINAL_PROMPT: "0",
	});
	let id = 0;
	const pluginsCommand = createApplicationPluginServices({
		homeDirectory: paths.homeDirectory,
		cwd: paths.workspace,
		environment,
		fileSystem,
		processRunner,
		idGenerator: new LiveIds(),
		settings,
	}).command;
	const application = createCodingAgentApplication({
		models,
		settings,
		fileSystem,
		processRunner,
		mcpConnector:
			options.mcpConnector ??
			createSdkMcpConnector({ client: { name: "coda-agent-plugins-surfaces", version: "1.0.0" } }),
		terminalFactory: { create: () => terminal },
		io: {
			stdin: { isTTY: true, readAll: async () => "" },
			stdout,
			stderr,
		},
		runtime: {
			cwd: paths.workspace,
			homeDirectory: paths.homeDirectory,
			platform: process.platform,
			environment,
			clock: runtime.clock,
			idGenerator: { generate: (kind) => `${kind}:live-surface-${++id}` },
			scheduler: createSystemScheduler(),
		},
	});
	return Object.freeze({ application, faux, pluginsCommand, stdout, stderr, terminal });
}

function gateMcpCalls(base: McpConnector): LiveMcpCallGate {
	let markStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stats = { closeCount: 0 };
	return {
		started,
		release,
		stats,
		connector: {
			connect: async (definition, context) => {
				const connection = await base.connect(definition, context);
				return {
					info: connection.info,
					listTools: (callContext) => connection.listTools(callContext),
					callTool: async (request, callContext) => {
						markStarted();
						await released;
						return connection.callTool(request, callContext);
					},
					close: async () => {
						stats.closeCount++;
						await connection.close();
					},
				};
			},
		},
	};
}

function distinctSkillBodyLine(content: string, other: string): string {
	const body = content
		.split(/^---[ \t]*$/mu)
		.slice(2)
		.join("---");
	const line = body
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.find((entry) => entry.length >= 12 && !other.includes(entry));
	if (!line) throw new Error("Pinned Skill revisions need a distinct body line for Run evidence");
	return line;
}

function representativeSkillBodyLine(content: string): string {
	const body = content
		.split(/^---[ \t]*$/mu)
		.slice(2)
		.join("---");
	const line = body
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.find((entry) => entry.length >= 12);
	if (!line) throw new Error("Pinned Skill revision needs a representative body line for Run evidence");
	return line;
}

async function discoverLiveInventory(
	paths: LiveLifecyclePaths,
	runtime: LiveLifecycleRuntime,
): Promise<CodingPluginsSnapshot> {
	const [settings, installations] = await Promise.all([
		runtime.settingsStore.load(),
		runtime.installationStore.list(),
	]);
	return discoverCodingPlugins({
		workspace: paths.workspace,
		userHome: paths.userHome,
		dataRoot: paths.dataRoot,
		fileSystem: runtime.fileSystem,
		enablement: settings.plugins,
		managedInstallations: installations.installations,
		verifyManagedInstallation: (record, options) => runtime.installationStore.verify(record, options),
	});
}

async function pluginPromptFragments(inventory: CodingPluginsSnapshot): Promise<readonly string[]> {
	const lease = await createPluginsCapabilitySource({ acquireInventory: () => inventory }).acquire({
		model: undefined as never,
		signal: new AbortController().signal,
	});
	try {
		return lease.promptFragments.map(({ text }) => text);
	} finally {
		await lease.dispose();
	}
}

async function resolvedSkillNames(
	fileSystem: FileSystem,
	inventory: CodingPluginsSnapshot,
): Promise<readonly string[]> {
	const manager = new CodingSkillsManager({
		fileSystem,
		roots: [],
		supplementalSnapshots: () => inventory.skills,
	});
	return (await manager.refresh()).resolved.map(({ qualifiedName }) => qualifiedName);
}

function failOnForeignProtocolProbe(base: FileSystem, probes: string[]): FileSystem {
	const observe = (path: string): void => {
		if (!path.split(sep).includes(".codex-plugin")) return;
		probes.push(path);
		throw new Error(`Foreign Codex Plugin subtree was probed: ${path}`);
	};
	return {
		...base,
		realpath: async (path) => {
			observe(path);
			return base.realpath(path);
		},
		stat: async (path) => {
			observe(path);
			return base.stat(path);
		},
		lstat: async (path) => {
			observe(path);
			return base.lstat(path);
		},
		readFile: async (path) => {
			observe(path);
			return base.readFile(path);
		},
		readDirectory: async (path) => {
			observe(path);
			return base.readDirectory(path);
		},
	};
}

interface InteractivePluginActionResult {
	readonly snapshot: PluginsCommandFlowSnapshot;
	readonly screen: CommandFlowMenu;
}

async function runInteractivePluginAction(
	command: PluginsCommand,
	pluginId: CodingPluginId,
	action: PluginCommandFlowAction,
): Promise<InteractivePluginActionResult> {
	let returnedSnapshot: PluginsCommandFlowSnapshot | undefined;
	const capture = async (operation: Promise<PluginsCommandFlowSnapshot>): Promise<PluginsCommandFlowSnapshot> => {
		const snapshot = await operation;
		returnedSnapshot = snapshot;
		return snapshot;
	};
	const observedCommand: PluginsCommand = Object.freeze({
		snapshot: () => command.snapshot(),
		install: (selected: CodingPluginId) => capture(command.install(selected)),
		enable: (selected: CodingPluginId) => capture(command.enable(selected)),
		disable: (selected: CodingPluginId) => capture(command.disable(selected)),
		upgrade: (selected: CodingPluginId) => capture(command.upgrade(selected)),
		remove: (selected: CodingPluginId) => capture(command.remove(selected)),
		refresh: () => capture(command.refresh()),
	});
	let opened: CommandFlowScreen | undefined;
	await openPluginsCommand(
		{
			open: (screen) => {
				opened = screen;
			},
		},
		pluginId,
		observedCommand,
	);
	const detail = commandFlowMenu(opened);
	const actionItem = detail.items.find(({ id }) => id === action);
	if (!actionItem?.onSelect) {
		throw new Error(`Interactive /plugins action ${action} is unavailable for ${pluginId}`);
	}
	let reopened: CommandFlowScreen | undefined;
	await actionItem.onSelect({
		push: (screen) => {
			reopened = screen;
		},
		replace: (screen) => {
			reopened = screen;
		},
		back: () => undefined,
		close: () => undefined,
	});
	if (!returnedSnapshot) throw new Error(`Interactive /plugins action ${action} returned no Plugin snapshot`);
	return Object.freeze({ snapshot: returnedSnapshot, screen: commandFlowMenu(reopened) });
}

async function openInteractivePluginDetail(
	command: PluginsCommand,
	pluginId: CodingPluginId,
): Promise<CommandFlowMenu> {
	let opened: CommandFlowScreen | undefined;
	await openPluginsCommand(
		{
			open: (screen) => {
				opened = screen;
			},
		},
		pluginId,
		command,
	);
	return commandFlowMenu(opened);
}

function commandFlowMenu(screen: CommandFlowScreen | undefined): CommandFlowMenu {
	if (!screen || !("items" in screen)) throw new Error("Expected /plugins to open a Command Flow menu");
	return screen;
}

async function inspectPluginJson(
	fixture: LiveApplicationFixture,
	pluginId: CodingPluginId,
): Promise<Record<string, unknown>> {
	const exitCode = await fixture.application.run(["plugin", "inspect", pluginId, "--json"]);
	if (exitCode !== 0) {
		throw new Error(`Plugin inspect failed for ${pluginId}: ${fixture.stderr.value || fixture.stdout.value}`);
	}
	return JSON.parse(fixture.stdout.take()) as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe.sequential("live Agent Plugins conformance", () => {
	test("runs the pinned AIUP combined Plugin Skill through anonymous read-only Context7", async () => {
		const workspace = await temporaryDirectory("agent-plugin-aiup-workspace");
		const homeDirectory = await temporaryDirectory("agent-plugin-aiup-home");
		const marketplaceRoot = await temporaryDirectory("agent-plugin-aiup-marketplace");
		await selectAiupRemotePackage(marketplaceRoot);
		const foreignProbes: string[] = [];
		const observedCalls: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[] = [];
		const observedResults: unknown[] = [];
		const sdkConnector = createSdkMcpConnector({
			client: { name: "coda-agent-plugins-aiup-live", version: "1.0.0" },
		});
		const connector: McpConnector = {
			connect: async (definition, context) => {
				expect(definition).toMatchObject({
					id: "plugin_aiup-core_context7",
					transport: { kind: "http", url: AIUP_CONTEXT7_MCP },
				});
				if (definition.transport.kind !== "http") throw new Error("AIUP Context7 must use HTTPS");
				expect(definition.transport.headers).toBeUndefined();
				expect(definition.transport.bearerToken).toBeUndefined();
				const connection = await sdkConnector.connect(definition, context);
				return {
					info: connection.info,
					listTools: (callContext) => connection.listTools(callContext),
					callTool: async (request, callContext) => {
						observedCalls.push(request);
						const result = await connection.callTool(request, callContext);
						observedResults.push(result);
						return result;
					},
					close: () => connection.close(),
				};
			},
		};
		const fixture = createLiveApplication(
			{ workspace, homeDirectory },
			{
				fileSystem: failOnForeignProtocolProbe(createNodeFileSystem(), foreignProbes),
				mcpConnector: connector,
			},
		);

		await expect(
			within(fixture.application.run(["plugin", "marketplace", "add", marketplaceRoot, "--json"]), 180_000),
		).resolves.toBe(0);
		const marketplaceAdded = JSON.parse(fixture.stdout.take());
		expect(marketplaceAdded).toMatchObject({
			schemaVersion: 1,
			type: "plugin_marketplace_operation",
			operation: "add",
			marketplaces: [{ name: AIUP_MARKETPLACE, status: "available" }],
			diagnostics: [],
		});
		await expect(
			within(
				fixture.application.run(["plugin", "list", "--marketplace", AIUP_MARKETPLACE, "--available", "--json"]),
				180_000,
			),
		).resolves.toBe(0);
		const browsed = JSON.parse(fixture.stdout.take());
		expect(browsed).toMatchObject({
			schemaVersion: 1,
			type: "plugin_list",
			installed: [],
			available: [
				{
					pluginId: AIUP_PLUGIN_ID,
					state: "available",
					available: true,
					installed: false,
					availableVersion: "2.5.1",
					availableRevision: AIUP_REMOTE_REVISION,
					availableDigest: AIUP_INSTALLED_DIGEST,
					source: {
						source: "git-subdir",
						url: AIUP_REMOTE_URL,
						path: AIUP_REMOTE_SUBDIRECTORY,
						sha: AIUP_REMOTE_REVISION,
					},
					contributions: {
						skills: AIUP_SKILLS,
						mcpServers: ["aiup-core:context7"],
					},
				},
			],
			diagnostics: [],
		});

		await expect(within(fixture.application.run(["plugin", "add", AIUP_PLUGIN_ID, "--json"]), 180_000)).resolves.toBe(
			0,
		);
		const installed = JSON.parse(fixture.stdout.take());
		expect(installed).toMatchObject({
			schemaVersion: 1,
			type: "plugin_operation",
			operation: "add",
			plugin: {
				pluginId: AIUP_PLUGIN_ID,
				state: "enabled",
				selectedDigest: AIUP_INSTALLED_DIGEST,
				source: {
					source: "git-subdir",
					url: AIUP_REMOTE_URL,
					path: AIUP_REMOTE_SUBDIRECTORY,
					sha: AIUP_REMOTE_REVISION,
				},
			},
		});
		fixture.faux.setResponses([
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("<name>aiup-core:requirements</name>");
				const modelTool = context.tools?.find(({ name }) => name.endsWith("__resolve-library-id"));
				if (!modelTool) {
					throw new Error(
						`Context7 resolve-library-id Tool missing: ${context.tools?.map(({ name }) => name).join(", ")}`,
					);
				}
				expect(modelTool.description).toContain("Agent Plugin MCP Server aiup-core:context7 —");
				return fauxAssistantMessage(
					fauxToolCall(
						modelTool.name,
						{ libraryName: "React", query: "Find the canonical React documentation library" },
						{ id: "aiup-context7-resolve" },
					),
					{ stopReason: "toolUse", timestamp: 100 },
				);
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("aiup-context7-resolve");
				return fauxAssistantMessage("AIUP Context7 Run complete", { timestamp: 101 });
			},
		]);
		const runExitCode = await within(
			fixture.application.run([
				"--print",
				"--no-session",
				"$aiup-core:requirements resolve the React documentation library",
			]),
			120_000,
		);
		if (runExitCode !== 0) {
			throw new Error(`AIUP Prepared Run failed: ${fixture.stderr.value || fixture.stdout.value}`);
		}
		expect(observedCalls).toEqual([
			{
				name: "resolve-library-id",
				arguments: { libraryName: "React", query: "Find the canonical React documentation library" },
			},
		]);
		expect(observedResults).toEqual([
			expect.objectContaining({
				isError: false,
				content: expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringMatching(/\S/u) }),
				]),
			}),
		]);
		expect(fixture.stdout.take()).toBe("AIUP Context7 Run complete\n");
		expect(fixture.stderr.value).toBe("");
		expect(foreignProbes).toEqual([]);
	}, 360_000);

	test("browses, installs, refreshes, and upgrades the pinned official Git source itself", async () => {
		const paths: LiveLifecyclePaths = Object.freeze({
			workspace: await temporaryDirectory("agent-plugin-remote-workspace"),
			userHome: await temporaryDirectory("agent-plugin-remote-user-home"),
			dataRoot: await temporaryDirectory("agent-plugin-remote-data"),
			stateRoot: await temporaryDirectory("agent-plugin-remote-state"),
			settingsHome: await temporaryDirectory("agent-plugin-remote-settings"),
		});
		const marketplaceRoot = await temporaryDirectory("agent-plugin-remote-marketplace");
		await selectRemoteMarketplacePackage(marketplaceRoot, OFFICIAL_EXAMPLE_REVISIONS.initial);
		const runtime = createLiveLifecycleRuntime(paths);

		const browsed = await runtime.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		expect(browsed.plugins[0]).toMatchObject({
			pluginId: LIVE_PLUGIN_ID,
			state: "available",
			available: true,
			installed: false,
			availableVersion: "1.0.0",
			availableRevision: OFFICIAL_EXAMPLE_REVISIONS.initial.revision,
			availableDigest: REMOTE_INSTALLED_DIGESTS.initial,
			source: {
				source: "url",
				url: OFFICIAL_EXAMPLE_URL,
				sha: OFFICIAL_EXAMPLE_REVISIONS.initial.revision,
			},
			contributions: {
				skills: ["agent-plugins-example:migrate-agent-plugin"],
				mcpServers: [],
			},
		});
		expect(browsed.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);

		const installed = await runtime.management.install(LIVE_PLUGIN_ID);
		expect(installed.plugins[0]).toMatchObject({
			state: "enabled",
			selectedDigest: REMOTE_INSTALLED_DIGESTS.initial,
			selectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
			source: { sha: OFFICIAL_EXAMPLE_REVISIONS.initial.revision },
		});
		const initialInstallationRevision = installed.plugins[0]!.selectedRevision;

		await selectRemoteMarketplacePackage(marketplaceRoot, OFFICIAL_EXAMPLE_REVISIONS.upgraded);
		const refreshed = await runtime.management.refresh();
		expect(refreshed.plugins[0]).toMatchObject({
			state: "update-available",
			updateAvailable: true,
			selectedDigest: REMOTE_INSTALLED_DIGESTS.initial,
			availableDigest: REMOTE_INSTALLED_DIGESTS.upgraded,
			availableRevision: OFFICIAL_EXAMPLE_REVISIONS.upgraded.revision,
		});

		const upgraded = await runtime.management.upgrade(LIVE_PLUGIN_ID);
		expect(upgraded.plugins[0]).toMatchObject({
			state: "enabled",
			updateAvailable: false,
			selectedDigest: REMOTE_INSTALLED_DIGESTS.upgraded,
			selectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
			source: { sha: OFFICIAL_EXAMPLE_REVISIONS.upgraded.revision },
		});
		expect(upgraded.plugins[0]!.selectedRevision).not.toBe(initialInstallationRevision);
		const upgradedInstallationRevision = upgraded.plugins[0]!.selectedRevision;
		const restarted = createLiveLifecycleRuntime(paths);
		expect((await restarted.management.snapshot()).plugins[0]).toMatchObject({
			state: "enabled",
			selectedDigest: REMOTE_INSTALLED_DIGESTS.upgraded,
			availableDigest: REMOTE_INSTALLED_DIGESTS.upgraded,
			selectedRevision: upgradedInstallationRevision,
			availableRevision: OFFICIAL_EXAMPLE_REVISIONS.upgraded.revision,
		});
	}, 180_000);

	test("persists the browse-to-remove lifecycle across two pinned official revisions", async () => {
		const paths: LiveLifecyclePaths = Object.freeze({
			workspace: await temporaryDirectory("agent-plugin-workspace"),
			userHome: await temporaryDirectory("agent-plugin-user-home"),
			dataRoot: await temporaryDirectory("agent-plugin-data"),
			stateRoot: await temporaryDirectory("agent-plugin-state"),
			settingsHome: await temporaryDirectory("agent-plugin-settings"),
		});
		const marketplaceRoot = await temporaryDirectory("agent-plugin-marketplace");
		await Promise.all([
			stageOfficialPackage(marketplaceRoot, "initial", OFFICIAL_EXAMPLE_REVISIONS.initial),
			stageOfficialPackage(marketplaceRoot, "upgraded", OFFICIAL_EXAMPLE_REVISIONS.upgraded),
		]);
		await selectMarketplacePackage(marketplaceRoot, "initial");
		const runtime = createLiveLifecycleRuntime(paths);

		const browsed = await runtime.management.marketplaceAdd({ source: "local", root: marketplaceRoot });
		expect(browsed.marketplaces).toEqual([expect.objectContaining({ name: LIVE_MARKETPLACE, status: "available" })]);
		expect(browsed.plugins).toEqual([
			expect.objectContaining({
				pluginId: LIVE_PLUGIN_ID,
				state: "available",
				available: true,
				installed: false,
			}),
		]);
		expect(browsed.diagnostics).toEqual([]);

		const installed = await runtime.management.install(LIVE_PLUGIN_ID);
		expect(installed.plugins).toEqual([
			expect.objectContaining({
				pluginId: LIVE_PLUGIN_ID,
				state: "enabled",
				installed: true,
				enabled: true,
				installedVersion: "1.0.0",
			}),
		]);
		expect((await runtime.settingsStore.load()).plugins?.[LIVE_PLUGIN_ID]).toEqual({ enabled: true });
		const initialInstallation = (await runtime.installationStore.list()).installations[0]!;
		expect(initialInstallation).toMatchObject({
			pluginId: LIVE_PLUGIN_ID,
			digest: INSTALLED_DIGESTS.initial,
			source: { source: "local" },
		});

		const initialInventory = await discoverLiveInventory(paths, runtime);
		expect(initialInventory.plugins).toEqual([
			expect.objectContaining({ installationId: LIVE_PLUGIN_ID, source: LIVE_MARKETPLACE, enabled: true }),
		]);
		expect(initialInventory.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
		expect(await pluginPromptFragments(initialInventory)).toEqual([
			expect.stringContaining("<plugins_instructions>"),
		]);
		expect(await resolvedSkillNames(runtime.fileSystem, initialInventory)).toEqual([
			"agent-plugins-example:migrate-agent-plugin",
		]);
		const initialSkillRevision = String(initialInventory.skills[0]!.candidates[0]!.revision);

		const initialMcp = await materializeCodingPluginMcpDefinitions({
			sources: initialInventory.mcpSources,
			platform: process.platform,
		});
		expect(initialMcp.diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
		expect(initialMcp.definitions).toEqual([
			expect.objectContaining({
				id: "plugin_agent-plugins-example_openai-docs",
				protocol: "auto",
				transport: { kind: "http", url: OPENAI_DOCS_MCP },
			}),
		]);
		const connector = createSdkMcpConnector({
			client: { name: "coda-agent-plugins-lifecycle", version: "1.0.0" },
		});
		const connection = await connector.connect(initialMcp.definitions[0]!);
		try {
			const tools = await connection.listTools({ signal: AbortSignal.timeout(30_000) });
			expect(connection.info.server?.name).toBe("openai-docs-mcp");
			expect(tools.map(({ name }) => name)).toEqual(
				expect.arrayContaining(["search_openai_docs", "fetch_openai_doc", "get_openapi_spec"]),
			);
			const result = await connection.callTool(
				{ name: "search_openai_docs", arguments: { query: "Agent Plugins" } },
				{ signal: AbortSignal.timeout(60_000) },
			);
			expect(result.isError).toBe(false);
			expect(result.content.length).toBeGreaterThan(0);
		} finally {
			await connection.close();
		}

		const disabled = await runtime.management.disable(LIVE_PLUGIN_ID);
		expect(disabled.plugins[0]).toMatchObject({ state: "installed", installed: true, enabled: false });
		const disabledInventory = await discoverLiveInventory(paths, runtime);
		expect(disabledInventory.installations).toEqual([
			expect.objectContaining({ installationId: LIVE_PLUGIN_ID, enabled: false }),
		]);
		expect(disabledInventory.plugins).toEqual([]);
		expect(disabledInventory.skills).toEqual([]);
		expect(disabledInventory.mcpSources).toEqual([]);
		expect(await pluginPromptFragments(disabledInventory)).toEqual([]);
		expect(await resolvedSkillNames(runtime.fileSystem, disabledInventory)).toEqual([]);
		expect(
			(
				await materializeCodingPluginMcpDefinitions({
					sources: disabledInventory.mcpSources,
					platform: process.platform,
				})
			).definitions,
		).toEqual([]);

		const reenabled = await runtime.management.enable(LIVE_PLUGIN_ID);
		expect(reenabled.plugins[0]).toMatchObject({ state: "enabled", installed: true, enabled: true });
		const reenabledInventory = await discoverLiveInventory(paths, runtime);
		expect(await resolvedSkillNames(runtime.fileSystem, reenabledInventory)).toEqual([
			"agent-plugins-example:migrate-agent-plugin",
		]);
		expect(reenabledInventory.mcpSources).toHaveLength(1);

		await selectMarketplacePackage(marketplaceRoot, "upgraded");
		const upgraded = await runtime.management.upgrade(LIVE_PLUGIN_ID);
		expect(upgraded.plugins[0]).toMatchObject({
			pluginId: LIVE_PLUGIN_ID,
			state: "enabled",
			installed: true,
			enabled: true,
		});
		const upgradedInstallation = (await runtime.installationStore.list()).installations[0]!;
		expect(upgradedInstallation).toMatchObject({
			pluginId: LIVE_PLUGIN_ID,
			digest: INSTALLED_DIGESTS.upgraded,
		});
		expect(upgradedInstallation.digest).not.toBe(initialInstallation.digest);
		const upgradedInventory = await discoverLiveInventory(paths, runtime);
		expect(upgradedInventory.plugins[0]?.installationId).toBe(LIVE_PLUGIN_ID);
		expect(String(upgradedInventory.skills[0]!.candidates[0]!.revision)).not.toBe(initialSkillRevision);
		expect(await resolvedSkillNames(runtime.fileSystem, upgradedInventory)).toEqual([
			"agent-plugins-example:migrate-agent-plugin",
		]);
		const restartedInstalled = createLiveLifecycleRuntime(paths);
		const afterInstalledRestart = await restartedInstalled.management.snapshot();
		expect(afterInstalledRestart.plugins[0]).toMatchObject({
			pluginId: LIVE_PLUGIN_ID,
			state: "enabled",
			installed: true,
			enabled: true,
			selectedDigest: INSTALLED_DIGESTS.upgraded,
		});
		expect(
			await resolvedSkillNames(
				restartedInstalled.fileSystem,
				await discoverLiveInventory(paths, restartedInstalled),
			),
		).toEqual(["agent-plugins-example:migrate-agent-plugin"]);

		const removed = await restartedInstalled.management.remove(LIVE_PLUGIN_ID);
		expect(removed.plugins).toEqual([
			expect.objectContaining({ pluginId: LIVE_PLUGIN_ID, state: "available", installed: false }),
		]);
		expect((await runtime.installationStore.list()).installations).toEqual([]);
		expect((await runtime.settingsStore.load()).plugins?.[LIVE_PLUGIN_ID]).toBeUndefined();
		expect((await discoverLiveInventory(paths, runtime)).plugins).toEqual([]);

		const restarted = createLiveLifecycleRuntime(paths);
		const afterRestart = await restarted.management.snapshot();
		expect(afterRestart).toEqual(removed);
		expect(afterRestart.marketplaces).toEqual([
			expect.objectContaining({ name: LIVE_MARKETPLACE, status: "available" }),
		]);
		expect(afterRestart.plugins).toEqual([
			expect.objectContaining({ pluginId: LIVE_PLUGIN_ID, state: "available", installed: false }),
		]);
		expect((await restarted.installationStore.list()).installations).toEqual([]);
		expect((await restarted.settingsStore.load()).plugins?.[LIVE_PLUGIN_ID]).toBeUndefined();
		expect((await discoverLiveInventory(paths, restarted)).plugins).toEqual([]);
	}, 120_000);

	test("keeps a real active Plugin Run on its old Skill and MCP lease across upgrade", async () => {
		const workspace = await temporaryDirectory("agent-plugin-active-workspace");
		const homeDirectory = await temporaryDirectory("agent-plugin-active-home");
		const marketplaceRoot = await temporaryDirectory("agent-plugin-active-marketplace");
		const [initialRoot, upgradedRoot] = await Promise.all([
			stageOfficialPackage(marketplaceRoot, "initial", OFFICIAL_EXAMPLE_REVISIONS.initial),
			stageOfficialPackage(marketplaceRoot, "upgraded", OFFICIAL_EXAMPLE_REVISIONS.upgraded),
		]);
		const [initialSkill, upgradedSkill] = await Promise.all([
			readFile(join(initialRoot, "skills", "migrate-agent-plugin", "SKILL.md"), "utf8"),
			readFile(join(upgradedRoot, "skills", "migrate-agent-plugin", "SKILL.md"), "utf8"),
		]);
		const initialEvidence = distinctSkillBodyLine(initialSkill, upgradedSkill);
		const upgradedEvidence = representativeSkillBodyLine(upgradedSkill);
		await selectMarketplacePackage(marketplaceRoot, "initial");

		const sharedSettings: LiveApplicationSettingsState = {};
		const callGate = gateMcpCalls(
			createSdkMcpConnector({ client: { name: "coda-agent-plugins-active-old", version: "1.0.0" } }),
		);
		const active = createLiveApplication(
			{ workspace, homeDirectory },
			{ settingsState: sharedSettings, mcpConnector: callGate.connector },
		);
		await expect(active.application.run(["plugin", "marketplace", "add", marketplaceRoot, "--json"])).resolves.toBe(
			0,
		);
		active.stdout.take();
		await expect(active.application.run(["plugin", "add", LIVE_PLUGIN_ID, "--json"])).resolves.toBe(0);
		active.stdout.take();
		active.faux.setResponses([
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain(initialEvidence);
				const toolName = context.tools?.find(({ name }) => name.endsWith("__list_openai_docs"))?.name;
				if (!toolName) {
					throw new Error(`Active Run MCP Tool missing: ${context.tools?.map(({ name }) => name).join(", ")}`);
				}
				return fauxAssistantMessage(fauxToolCall(toolName!, { limit: 1 }, { id: "active-old-mcp-call" }), {
					stopReason: "toolUse",
					timestamp: 100,
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("active-old-mcp-call");
				return fauxAssistantMessage("old Run completed", { timestamp: 101 });
			},
		]);
		const activeRun = active.application.run([
			"--print",
			"--no-session",
			"$agent-plugins-example:migrate-agent-plugin search during upgrade",
		]);
		try {
			await within(
				Promise.race([
					callGate.started,
					activeRun.then((exitCode) => {
						throw new Error(
							`Active Run exited before its MCP call (exit ${exitCode}): ${active.stderr.value || active.stdout.value}`,
						);
					}),
				]),
				30_000,
			);
		} catch (error) {
			callGate.release();
			await activeRun;
			throw error;
		}

		await selectMarketplacePackage(marketplaceRoot, "upgraded");
		const next = createLiveApplication({ workspace, homeDirectory }, { settingsState: sharedSettings });
		try {
			await expect(next.application.run(["plugin", "upgrade", LIVE_PLUGIN_ID, "--json"])).resolves.toBe(0);
			expect(JSON.parse(next.stdout.take())).toMatchObject({
				type: "plugin_operation",
				operation: "upgrade",
				plugin: { pluginId: LIVE_PLUGIN_ID, selectedDigest: INSTALLED_DIGESTS.upgraded },
			});
			expect(callGate.stats.closeCount).toBe(0);
		} finally {
			callGate.release();
		}
		const activeExitCode = await activeRun;
		if (activeExitCode !== 0) {
			throw new Error(`Active Run failed after release: ${active.stderr.value || active.stdout.value}`);
		}
		expect(active.stdout.take()).toBe("old Run completed\n");
		expect(callGate.stats.closeCount).toBe(1);

		next.faux.setResponses([
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain(upgradedEvidence);
				expect(messages).not.toContain(initialEvidence);
				const toolName = context.tools?.find(({ name }) => name.endsWith("__list_openai_docs"))?.name;
				expect(toolName).toBeTruthy();
				return fauxAssistantMessage(fauxToolCall(toolName!, { limit: 1 }, { id: "active-new-mcp-call" }), {
					stopReason: "toolUse",
					timestamp: 102,
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("active-new-mcp-call");
				return fauxAssistantMessage("new Run completed", { timestamp: 103 });
			},
		]);
		await expect(
			next.application.run([
				"--print",
				"--no-session",
				"$agent-plugins-example:migrate-agent-plugin search after upgrade",
			]),
		).resolves.toBe(0);
		expect(next.stdout.take()).toBe("new Run completed\n");
		expect(next.stderr.value).toBe("");
	}, 180_000);

	test("shows the HTTPS fixture through machine-readable and interactive application surfaces", async () => {
		const workspace = await temporaryDirectory("agent-plugin-surface-workspace");
		const homeDirectory = await temporaryDirectory("agent-plugin-surface-home");
		const marketplaceRoot = await temporaryDirectory("agent-plugin-surface-marketplace");
		await Promise.all([
			stageOfficialPackage(marketplaceRoot, "initial", OFFICIAL_EXAMPLE_REVISIONS.initial),
			stageOfficialPackage(marketplaceRoot, "upgraded", OFFICIAL_EXAMPLE_REVISIONS.upgraded),
		]);
		await selectMarketplacePackage(marketplaceRoot, "initial");
		const fixture = createLiveApplication({ workspace, homeDirectory });

		await expect(fixture.application.run(["plugin", "marketplace", "add", marketplaceRoot, "--json"])).resolves.toBe(
			0,
		);
		expect(JSON.parse(fixture.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_marketplace_operation",
			operation: "add",
			marketplaces: [{ name: LIVE_MARKETPLACE, status: "available" }],
		});
		await expect(fixture.application.run(["plugin", "add", LIVE_PLUGIN_ID, "--json"])).resolves.toBe(0);
		expect(JSON.parse(fixture.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_operation",
			operation: "add",
			plugin: { pluginId: LIVE_PLUGIN_ID, state: "enabled" },
		});
		await expect(fixture.application.run(["plugin", "inspect", LIVE_PLUGIN_ID, "--json"])).resolves.toBe(0);
		expect(JSON.parse(fixture.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_inspect",
			plugin: {
				pluginId: LIVE_PLUGIN_ID,
				namespace: "agent-plugins-example",
				selectedDigest: INSTALLED_DIGESTS.initial,
				contributions: {
					skills: ["agent-plugins-example:migrate-agent-plugin"],
					mcpServers: ["agent-plugins-example:openai-docs"],
				},
			},
		});
		expect(fixture.stderr.value).toBe("");
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("<plugins_instructions>");
				expect(JSON.stringify(context.messages)).toContain("migrate-agent-plugin");
				const toolName = context.tools?.find(({ name }) => name.endsWith("__list_openai_docs"))?.name;
				expect(toolName).toBeTruthy();
				return fauxAssistantMessage(fauxToolCall(toolName!, { limit: 1 }, { id: "live-plugin-mcp-call" }), {
					stopReason: "toolUse",
					timestamp: 100,
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("live-plugin-mcp-call");
				return fauxAssistantMessage("live Plugin Run complete", { timestamp: 101 });
			},
		]);
		await expect(
			fixture.application.run([
				"--print",
				"--no-session",
				"$agent-plugins-example:migrate-agent-plugin find Agent Plugins documentation",
			]),
		).resolves.toBe(0);
		expect(fixture.stdout.take()).toBe("live Plugin Run complete\n");
		expect(fixture.stderr.value).toBe("");

		const running = fixture.application.run(["--interactive", "--no-color", "--no-session"]);
		try {
			await until(() => fixture.terminal.started);
			fixture.terminal.clearOutput();
			await fixture.terminal.emit({ type: "text", text: "/plugins" });
			await fixture.terminal.emit({
				type: "key",
				key: "enter",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			await until(() => fixture.terminal.readOutput().includes("agent-plugins-example"));
			expect(fixture.terminal.readOutput()).toContain("enabled");
			await fixture.terminal.emit({
				type: "key",
				key: "down",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			await fixture.terminal.emit({
				type: "key",
				key: "down",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			await fixture.terminal.emit({
				type: "key",
				key: "enter",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			});
			await until(() => fixture.terminal.readOutput().includes(LIVE_PLUGIN_ID));
			expect(fixture.terminal.readOutput()).toContain("official-example");
			expect(fixture.terminal.readOutput()).toContain("valid");
		} finally {
			for (let count = 0; count < 2; count++) {
				await fixture.terminal.emit({
					type: "key",
					key: "escape",
					shift: false,
					control: false,
					alt: false,
					meta: false,
					action: "press",
				});
			}
			for (let count = 0; count < 2; count++) {
				await fixture.terminal.emit({
					type: "key",
					key: "c",
					text: "c",
					shift: false,
					control: true,
					alt: false,
					meta: false,
					action: "press",
				});
			}
		}
		await expect(running).resolves.toBe(0);

		const disabled = await runInteractivePluginAction(fixture.pluginsCommand, LIVE_PLUGIN_ID, "disable");
		expect(disabled.snapshot.plugins).toEqual([
			expect.objectContaining({ pluginId: LIVE_PLUGIN_ID, state: "disabled", enabled: false }),
		]);
		expect(disabled.screen.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: LIVE_PLUGIN_ID, status: "disabled" })]),
		);
		expect(await inspectPluginJson(fixture, LIVE_PLUGIN_ID)).toMatchObject({
			type: "plugin_inspect",
			revision: disabled.snapshot.revision,
			plugin: { pluginId: LIVE_PLUGIN_ID, state: "installed", enabled: false },
		});

		await selectMarketplacePackage(marketplaceRoot, "upgraded");
		const upgraded = await runInteractivePluginAction(fixture.pluginsCommand, LIVE_PLUGIN_ID, "upgrade");
		expect(upgraded.snapshot.plugins).toEqual([
			expect.objectContaining({
				pluginId: LIVE_PLUGIN_ID,
				state: "disabled",
				enabled: false,
				selectedDigest: INSTALLED_DIGESTS.upgraded,
			}),
		]);
		expect(upgraded.screen.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: LIVE_PLUGIN_ID, status: "disabled" })]),
		);
		expect(await inspectPluginJson(fixture, LIVE_PLUGIN_ID)).toMatchObject({
			type: "plugin_inspect",
			revision: upgraded.snapshot.revision,
			plugin: {
				pluginId: LIVE_PLUGIN_ID,
				state: "installed",
				enabled: false,
				selectedDigest: INSTALLED_DIGESTS.upgraded,
			},
		});

		const enabled = await runInteractivePluginAction(fixture.pluginsCommand, LIVE_PLUGIN_ID, "enable");
		expect(enabled.snapshot.plugins).toEqual([
			expect.objectContaining({ pluginId: LIVE_PLUGIN_ID, state: "enabled", enabled: true }),
		]);
		expect(enabled.screen.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: LIVE_PLUGIN_ID, status: "enabled" })]),
		);
		expect(await inspectPluginJson(fixture, LIVE_PLUGIN_ID)).toMatchObject({
			type: "plugin_inspect",
			revision: enabled.snapshot.revision,
			plugin: { pluginId: LIVE_PLUGIN_ID, state: "enabled", enabled: true },
		});

		const removed = await runInteractivePluginAction(fixture.pluginsCommand, LIVE_PLUGIN_ID, "remove");
		expect(removed.snapshot.plugins).toEqual([
			expect.objectContaining({ pluginId: LIVE_PLUGIN_ID, state: "available" }),
		]);
		expect(removed.screen.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: LIVE_PLUGIN_ID, status: "available" })]),
		);
		expect(await inspectPluginJson(fixture, LIVE_PLUGIN_ID)).toMatchObject({
			type: "plugin_inspect",
			revision: removed.snapshot.revision,
			plugin: { pluginId: LIVE_PLUGIN_ID, installed: false, state: "available" },
		});
		expect(fixture.stderr.value).toBe("");
	}, 120_000);

	test("returns a versioned machine-readable failure when a Git source is unavailable", async () => {
		const workspace = await temporaryDirectory("agent-plugin-outage-workspace");
		const homeDirectory = await temporaryDirectory("agent-plugin-outage-home");
		const fixture = createLiveApplication({ workspace, homeDirectory });

		await expect(
			fixture.application.run([
				"plugin",
				"marketplace",
				"add",
				"https://unavailable.agent-plugins.invalid/source.git",
				"--json",
			]),
		).resolves.toBe(1);
		expect(JSON.parse(fixture.stdout.take())).toMatchObject({
			schemaVersion: 1,
			type: "plugin_error",
			code: "plugin_marketplace_operation_failed",
			operation: "marketplace-add",
			committed: false,
			message: expect.any(String),
		});
		expect(fixture.stderr.value).toBe("");
	}, 30_000);

	test("fails closed on malformed Agent Plugins without probing a foreign .codex-plugin package", async () => {
		const paths: LiveLifecyclePaths = Object.freeze({
			workspace: await temporaryDirectory("agent-plugin-invalid-workspace"),
			userHome: await temporaryDirectory("agent-plugin-invalid-user-home"),
			dataRoot: await temporaryDirectory("agent-plugin-invalid-data"),
			stateRoot: await temporaryDirectory("agent-plugin-invalid-state"),
			settingsHome: await temporaryDirectory("agent-plugin-invalid-settings"),
		});
		const marketplaceRoot = await temporaryDirectory("agent-plugin-invalid-marketplace");
		const packagesRoot = join(marketplaceRoot, ".agents", "plugins", "packages");
		const malformedRoot = join(packagesRoot, "malformed-agent-plugin");
		const foreignRoot = join(packagesRoot, "foreign-codex-plugin");
		await Promise.all([
			mkdir(malformedRoot, { recursive: true }),
			mkdir(join(foreignRoot, ".codex-plugin"), { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(malformedRoot, "plugin.json"), "{ malformed Agent Plugin"),
			writeFile(
				join(foreignRoot, ".codex-plugin", "plugin.json"),
				JSON.stringify({ name: "foreign-codex-plugin", version: "1.0.0" }),
			),
			writeFile(
				join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
				JSON.stringify({
					name: "invalid-packages",
					plugins: [
						{ name: "malformed-agent-plugin", source: "./packages/malformed-agent-plugin" },
						{ name: "foreign-codex-plugin", source: "./packages/foreign-codex-plugin" },
					],
				}),
			),
		]);
		const foreignProbes: string[] = [];
		const fixture = createLiveApplication(
			{ workspace: paths.workspace, homeDirectory: paths.userHome },
			{ fileSystem: failOnForeignProtocolProbe(createNodeFileSystem(), foreignProbes) },
		);

		await expect(fixture.application.run(["plugin", "marketplace", "add", marketplaceRoot, "--json"])).resolves.toBe(
			0,
		);
		const marketplaceResult = JSON.parse(fixture.stdout.take());
		expect(marketplaceResult).toMatchObject({
			schemaVersion: 1,
			type: "plugin_marketplace_operation",
			operation: "add",
		});
		expect(marketplaceResult.marketplaces).toEqual([
			expect.objectContaining({ name: "invalid-packages", status: "available" }),
		]);
		expect(marketplaceResult.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "plugin-marketplace-package-invalid",
					pluginId: "foreign-codex-plugin@invalid-packages",
				}),
				expect.objectContaining({
					code: "plugin-marketplace-package-invalid",
					pluginId: "malformed-agent-plugin@invalid-packages",
				}),
			]),
		);

		const invalidPluginIds = [
			"foreign-codex-plugin@invalid-packages",
			"malformed-agent-plugin@invalid-packages",
		] as const satisfies readonly CodingPluginId[];
		for (const pluginId of invalidPluginIds) {
			expect(await inspectPluginJson(fixture, pluginId)).toMatchObject({
				schemaVersion: 1,
				type: "plugin_inspect",
				plugin: {
					pluginId,
					state: "invalid",
					available: false,
					installed: false,
					invalid: true,
				},
				diagnostics: [
					expect.objectContaining({
						code: "plugin-marketplace-package-invalid",
						pluginId,
					}),
				],
			});

			const detail = await openInteractivePluginDetail(fixture.pluginsCommand, pluginId);
			expect(detail.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "validity", description: "invalid" }),
					expect.objectContaining({ id: "diagnostics", description: "1 total" }),
				]),
			);
			let diagnosticsScreen: CommandFlowScreen | undefined;
			await detail.items.find(({ id }) => id === "diagnostics")!.onSelect!({
				push: (screen) => {
					diagnosticsScreen = screen;
				},
				back: () => undefined,
				close: () => undefined,
			});
			expect(commandFlowMenu(diagnosticsScreen).items).toEqual([
				expect.objectContaining({ label: "warning: plugin-marketplace-package-invalid" }),
			]);
		}
		expect(fixture.stderr.value).toBe("");
		expect(foreignProbes).toEqual([]);
	});
});
