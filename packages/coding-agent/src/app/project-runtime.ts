import type { Clock } from "@coda/agent";
import type { Api, AuthResult, Model, MutableModels, ThinkingLevel } from "@coda/ai";
import { createMcpHost, type McpConnector } from "@coda/mcp";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal, TerminalColorScheme } from "@coda/tui";
import { createCoreCommandRegistry } from "../commands/core-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { SkillCommandRegistryBinding } from "../commands/skill-extensions.ts";
import type { HookRuntimeSnapshot } from "../hooks/types.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { Workspace } from "../host/workspace.ts";
import { type InspectedMcpConfiguration, inspectMcpConfiguration } from "../mcp/config.ts";
import { CodingMcpRegistry } from "../mcp/registry.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import { effectiveReasoningEffort } from "../models/reasoning-effort.ts";
import type { Session } from "../session/types.ts";
import type { SettingsStore, UserSettings } from "../settings/types.ts";
import { CodingSkillsManager } from "../skills/manager.ts";
import { collectSkillRoots } from "../skills/roots.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import type { SkillWatcherFactory } from "../skills/watcher.ts";
import type { FullScreenOutputGate } from "../ui/full-screen-output.ts";
import type { InteractiveProcessLifecycle } from "../ui/process-lifecycle.ts";
import type { PromptRuntime } from "../ui/prompts.ts";
import type { InteractiveSessionOptions } from "../ui/run-interactive.ts";
import { findModel, type ParsedArguments } from "./argument-parsing.ts";
import { authenticateInteractively, promptRuntime, selectModelInteractively } from "./auth-flows.ts";
import { assertModelSupportsImages } from "./interactive-session-options.ts";
import type { WorkspaceSessionResources } from "./workspace-session.ts";

export interface ApplicationSettingsState {
	current: UserSettings;
}

export function createApplicationSettingsState(settings: UserSettings): ApplicationSettingsState {
	return { current: settings };
}

export interface ProjectRuntimeApplicationOptions {
	readonly models: MutableModels;
	readonly settings: SettingsStore;
	readonly fileSystem: FileSystem;
	readonly io: Pick<ApplicationIO, "stderr">;
	readonly mcpConnector?: McpConnector;
	readonly commandRegistry?: CommandRegistry;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly terminalFactory?: {
		create(options: { readonly noColor: boolean; readonly colorScheme: TerminalColorScheme }): Terminal;
	};
	readonly keybindings?: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly runtime: {
		readonly homeDirectory: string;
		readonly environment: Readonly<Record<string, string | undefined>>;
		readonly clock: Clock;
		readonly scheduler?: Scheduler;
		readonly interactiveLifecycle?: InteractiveProcessLifecycle;
	};
}

export function createApplicationPromptRuntime(
	options: ProjectRuntimeApplicationOptions,
	parsed: Pick<ParsedArguments, "mode" | "noColor" | "colorScheme">,
	settings: UserSettings,
): PromptRuntime | undefined {
	const terminal =
		parsed.mode === "interactive"
			? options.terminalFactory?.create({
					noColor: parsed.noColor || options.runtime.environment.NO_COLOR !== undefined,
					colorScheme: parsed.colorScheme ?? settings.ui?.colorScheme ?? "auto",
				})
			: undefined;
	if (parsed.mode === "interactive" && !terminal) {
		throw new Error("Interactive mode requires an injected Terminal factory");
	}
	return terminal ? promptRuntime(options, terminal) : undefined;
}

export async function selectInitialModel(input: {
	readonly options: ProjectRuntimeApplicationOptions;
	readonly session: Session;
	readonly settings: UserSettings;
	readonly requestedModel?: ModelSelection;
	readonly requestedReasoning?: ThinkingLevel | "off";
	readonly interactiveRuntime?: PromptRuntime;
}): Promise<{
	readonly settings: UserSettings;
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
}> {
	let settings = input.settings;
	let selection = input.requestedModel ?? input.session.restored.model ?? settings.defaultModel;
	if (!selection) {
		if (!input.interactiveRuntime) {
			throw new Error("Print mode requires an explicit, restored, or configured Model");
		}
		selection = await selectModelInteractively(input.options, input.interactiveRuntime);
		settings = { ...settings, defaultModel: selection };
		await input.options.settings.save(settings);
	}
	const model = findModel(input.options.models, selection);
	return {
		settings,
		model,
		reasoning: effectiveReasoningEffort(
			model,
			input.requestedReasoning ?? input.session.restored.reasoning ?? settings.defaultReasoning ?? "medium",
		),
	};
}

export async function authenticateInitialModel(input: {
	readonly options: ProjectRuntimeApplicationOptions;
	readonly model: Model<Api>;
	readonly apiKey?: string;
	readonly interactiveRuntime?: PromptRuntime;
	readonly imageCount: number;
}): Promise<AuthResult> {
	let auth = await input.options.models.getAuth(input.model, {
		apiKey: input.apiKey,
		clock: input.options.runtime.clock,
	});
	if (!auth && input.interactiveRuntime && !input.apiKey) {
		await authenticateInteractively(input.options, input.model.provider, input.interactiveRuntime);
		auth = await input.options.models.getAuth(input.model, { clock: input.options.runtime.clock });
	}
	if (!auth) throw new Error(`Model is not authenticated: ${input.model.provider}/${input.model.id}`);
	assertModelSupportsImages(input.model, input.imageCount);
	return auth;
}

export interface ProjectSkills {
	readonly roots: Awaited<ReturnType<typeof collectSkillRoots>>;
	readonly manager: CodingSkillsManager;
	readonly snapshot: CodingSkillsSnapshot;
}

export async function loadProjectSkills(input: {
	readonly workspace: string;
	readonly homeDirectory: string;
	readonly fileSystem: FileSystem;
}): Promise<ProjectSkills> {
	const roots = await collectSkillRoots({ workspace: input.workspace, homeDirectory: input.homeDirectory });
	const manager = new CodingSkillsManager({ fileSystem: input.fileSystem, roots });
	return { roots, manager, snapshot: await manager.refresh() };
}

export interface ProjectServices {
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly commandRegistry: CommandRegistry;
	readonly skillsCommand: NonNullable<InteractiveSessionOptions["skillsCommand"]>;
	readonly mcpCommand: NonNullable<InteractiveSessionOptions["mcpCommand"]>;
	readonly hooksCommand: NonNullable<InteractiveSessionOptions["hooksCommand"]>;
	closeUi(): void;
}

export async function openProjectServices(input: {
	readonly options: ProjectRuntimeApplicationOptions;
	readonly settings: ApplicationSettingsState;
	readonly workspace: Workspace;
	readonly mcpConfiguration: InspectedMcpConfiguration;
	readonly skills: ProjectSkills;
	readonly interactive: boolean;
	readonly diagnostics: DiagnosticSink;
	readonly resources: WorkspaceSessionResources;
	readonly hooks: { snapshot(): HookRuntimeSnapshot };
}): Promise<ProjectServices> {
	let mcpConfiguration = input.mcpConfiguration;
	let mcpRegistry: CodingMcpRegistry | undefined;
	let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
	let skillWatcher: ReturnType<SkillWatcherFactory["watch"]> | undefined;
	let skillUiClosed = false;
	const closeUi = () => {
		skillUiClosed = true;
		skillWatcher?.dispose();
		skillRegistryBinding?.dispose();
	};
	try {
		if (mcpConfiguration.definitions.length > 0 && !input.options.mcpConnector) {
			throw new Error("MCP Servers are configured but no MCP connector is available");
		}
		if (input.options.mcpConnector) {
			mcpRegistry = new CodingMcpRegistry({
				host: createMcpHost({ connector: input.options.mcpConnector }),
				...(input.options.runtime.scheduler ? { scheduler: input.options.runtime.scheduler } : {}),
			});
			input.resources.useMcpRegistry(mcpRegistry);
			const mcpSnapshot = await mcpRegistry.reload(mcpConfiguration.definitions);
			for (const server of mcpSnapshot.servers) {
				if (server.status === "degraded") {
					await input.options.io.stderr.write(
						`coda: MCP Server ${server.id} is unavailable: ${server.error ?? "unknown error"}\n`,
					);
				}
			}
		}
		const commandRegistry = input.options.commandRegistry ?? createCoreCommandRegistry();
		skillRegistryBinding = new SkillCommandRegistryBinding(commandRegistry);
		skillRegistryBinding.sync(input.skills.snapshot);
		if (input.interactive && input.options.skillWatcher) {
			skillWatcher = input.options.skillWatcher.watch(
				input.skills.roots.map(({ path }) => path),
				() => {
					input.skills.manager.markDirty();
					void input.skills.manager
						.refresh({ rescan: false })
						.then((snapshot) => {
							if (!skillUiClosed) skillRegistryBinding!.sync(input.skills.manager.current ?? snapshot);
						})
						.catch((error: unknown) =>
							input.diagnostics({
								code: "skills.refresh-failed",
								message: error instanceof Error ? error.message : String(error),
							}),
						);
				},
				(error) => {
					void input.diagnostics({ code: "skills.watcher-failed", message: error.message });
				},
			);
		}
		const refreshSkills = async (): Promise<CodingSkillsSnapshot> => {
			const snapshot = await input.skills.manager.refresh();
			const current = input.skills.manager.current ?? snapshot;
			skillRegistryBinding!.sync(current);
			return current;
		};
		const mcpCommandSnapshot = () => ({
			host: mcpRegistry?.snapshot() ?? Object.freeze({ revision: 0, servers: [], tools: [], diagnostics: [] }),
			...(mcpConfiguration.workspace ? { workspace: mcpConfiguration.workspace } : {}),
		});
		const reloadMcp = async () => {
			const latestSettings = await input.options.settings.load();
			input.settings.current = {
				...input.settings.current,
				mcpServers: latestSettings.mcpServers,
				workspaceMcpTrust: latestSettings.workspaceMcpTrust,
			};
			mcpConfiguration = await inspectMcpConfiguration({
				workspace: input.workspace.root,
				fileSystem: input.options.fileSystem,
				userServers: input.settings.current.mcpServers ?? [],
				workspaceTrust: input.settings.current.workspaceMcpTrust ?? [],
				environment: input.options.runtime.environment,
			});
			if (!mcpRegistry) {
				if (mcpConfiguration.definitions.length > 0) {
					throw new Error("MCP Servers are configured but no MCP connector is available");
				}
				return mcpCommandSnapshot();
			}
			await mcpRegistry.reload(mcpConfiguration.definitions);
			return mcpCommandSnapshot();
		};
		return {
			...(mcpRegistry ? { mcpRegistry } : {}),
			commandRegistry,
			skillsCommand: { snapshot: refreshSkills, refresh: refreshSkills },
			mcpCommand: {
				snapshot: mcpCommandSnapshot,
				reload: reloadMcp,
				reconnect: async (serverId: string) => {
					if (!mcpRegistry) throw new Error("MCP is unavailable");
					await mcpRegistry.reconnect(serverId);
					return mcpCommandSnapshot();
				},
			},
			hooksCommand: { snapshot: () => input.hooks.snapshot() },
			closeUi,
		};
	} catch (error) {
		closeUi();
		throw error;
	}
}
