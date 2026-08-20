import type { Clock } from "@coda/agent";
import type { Api, AuthResult, Model, MutableModels, ThinkingLevel } from "@coda/ai";
import { createMcpHost, type McpConnector, type McpHostSnapshot, type McpServerDefinition } from "@coda/mcp";
import type { SkillsSnapshot } from "@coda/skills";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal, TerminalColorScheme } from "@coda/tui";
import { createCoreCommandRegistry } from "../commands/core-commands.ts";
import { McpCommandRegistryBinding } from "../commands/mcp-extensions.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { SkillCommandRegistryBinding } from "../commands/skill-extensions.ts";
import type { HookRuntimeSnapshot } from "../hooks/types.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { Workspace } from "../host/workspace.ts";
import { type InspectedMcpConfiguration, inspectMcpConfiguration, type McpServerConfiguration } from "../mcp/config.ts";
import { CodingMcpRegistry, type CodingMcpToolLease } from "../mcp/registry.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import { effectiveReasoningEffort } from "../models/reasoning-effort.ts";
import type { CodingPluginsSnapshot } from "../plugins/types.ts";
import type {
	AcquireProjectRunCapabilityBundle,
	ProjectRunCapabilityBundle,
} from "../runtime/project-capability-bundle.ts";
import type { Session } from "../session/types.ts";
import type { SettingsStore, UserSettings } from "../settings/types.ts";
import { CodingSkillsManager } from "../skills/manager.ts";
import { collectSkillRoots } from "../skills/roots.ts";
import type { CodingSkillOrigin, CodingSkillsSnapshot } from "../skills/types.ts";
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
	readonly plugins?: ProjectPluginSource;
}

export interface ProjectPluginSource {
	readonly watchRoots: readonly string[];
	inventory(): CodingPluginsSnapshot;
	skillSnapshots():
		| readonly SkillsSnapshot<CodingSkillOrigin>[]
		| Promise<readonly SkillsSnapshot<CodingSkillOrigin>[]>;
	refresh(settings: UserSettings): Promise<CodingPluginsSnapshot>;
	/** Retains client-owned package revisions needed by lazy Skill activation in one active Run. */
	retainRunRevisions?(
		inventory: CodingPluginsSnapshot,
		signal?: AbortSignal,
	): Promise<{ dispose(): Promise<void> | void }>;
	/** Collects revisions retired by the just-published complete Project refresh. */
	collectRetiredRevisions?(signal?: AbortSignal): Promise<void>;
	mcpDefinitions(input: {
		readonly settings: UserSettings;
		readonly reservedServerIds: readonly string[];
	}): Promise<ProjectPluginMcpDefinitions>;
}

export interface ProjectPluginMcpDefinitions {
	readonly definitions: readonly McpServerDefinition[];
	readonly agentPluginServerIds: readonly string[];
}

export async function loadProjectSkills(input: {
	readonly workspace: string;
	readonly homeDirectory: string;
	readonly fileSystem: FileSystem;
	readonly plugins?: ProjectPluginSource;
}): Promise<ProjectSkills> {
	const roots = await collectSkillRoots({
		workspace: input.workspace,
		homeDirectory: input.homeDirectory,
		fileSystem: input.fileSystem,
	});
	const manager = new CodingSkillsManager({
		fileSystem: input.fileSystem,
		roots,
		...(input.plugins ? { supplementalSnapshots: () => input.plugins!.skillSnapshots() } : {}),
	});
	return { roots, manager, snapshot: await manager.refresh(), ...(input.plugins ? { plugins: input.plugins } : {}) };
}

export interface ProjectServices {
	readonly mcpRegistry?: CodingMcpRegistry;
	readonly commandRegistry: CommandRegistry;
	readonly skillsCommand: NonNullable<InteractiveSessionOptions["skillsCommand"]>;
	readonly mcpCommand: NonNullable<InteractiveSessionOptions["mcpCommand"]>;
	readonly hooksCommand: NonNullable<InteractiveSessionOptions["hooksCommand"]>;
	readonly acquireRunCapabilityBundle: AcquireProjectRunCapabilityBundle;
	/** Reload and atomically publish Plugin, Skill, and MCP state for future Runs. */
	readonly refreshProject: () => Promise<void>;
	/** Marks externally committed Plugin state as mandatory before the next Run can acquire capabilities. */
	readonly markProjectDirty: () => void;
	readonly capabilityCatalogSnapshot: () => {
		readonly revision: string;
		readonly plugins: CodingPluginsSnapshot;
		readonly skills: CodingSkillsSnapshot;
		readonly mcp: McpHostSnapshot;
		readonly agentPluginServerIds: readonly string[];
	};
	/** Native declarations plus effective Project/Plugin MCP Servers used to determine missing dependencies. */
	readonly configuredMcpServers: () => readonly McpServerConfiguration[];
	closeUi(): void;
}

function emptyCodingPluginsSnapshot(): CodingPluginsSnapshot {
	return Object.freeze({
		installations: Object.freeze([]),
		plugins: Object.freeze([]),
		snapshots: Object.freeze([]),
		skills: Object.freeze([]),
		mcpSources: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
}

function emptyMcpSnapshot(): McpHostSnapshot {
	return Object.freeze({
		revision: 0,
		servers: Object.freeze([]),
		tools: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
}

function emptyMcpToolLease(snapshot: McpHostSnapshot): CodingMcpToolLease {
	return Object.freeze({
		revision: snapshot.revision,
		servers: snapshot.servers,
		tools: snapshot.tools,
		agentPluginServerIds: Object.freeze([]),
		callTool: async () => {
			throw new Error("MCP is unavailable");
		},
		dispose: async () => undefined,
	});
}

function configurationForDefinition(definition: McpServerDefinition): McpServerConfiguration {
	const transport =
		definition.transport.kind === "http"
			? Object.freeze({
					kind: "http" as const,
					url: definition.transport.url,
					...(definition.transport.headers ? { headers: definition.transport.headers } : {}),
				})
			: Object.freeze({
					kind: "stdio" as const,
					command: definition.transport.command,
					...(definition.transport.args ? { args: definition.transport.args } : {}),
					...(definition.transport.cwd ? { cwd: definition.transport.cwd } : {}),
					...(definition.transport.environment ? { environment: definition.transport.environment } : {}),
				});
	return Object.freeze({
		id: definition.id,
		protocol: definition.protocol,
		transport,
		...(definition.enabled !== undefined ? { enabled: definition.enabled } : {}),
		...(definition.tools ? { tools: definition.tools } : {}),
	});
}

function withLatestProjectCapabilitySettings(current: UserSettings, latest: UserSettings): UserSettings {
	const {
		mcpServers: _currentMcpServers,
		workspaceMcpTrust: _currentWorkspaceMcpTrust,
		plugins: _currentPlugins,
		...retained
	} = current;
	return Object.freeze({
		...retained,
		...(latest.mcpServers ? { mcpServers: latest.mcpServers } : {}),
		...(latest.workspaceMcpTrust ? { workspaceMcpTrust: latest.workspaceMcpTrust } : {}),
		...(latest.plugins ? { plugins: latest.plugins } : {}),
	});
}

export async function openProjectServices(input: {
	readonly options: ProjectRuntimeApplicationOptions;
	readonly settings: ApplicationSettingsState;
	readonly workspace: Workspace;
	readonly mcpConfiguration: InspectedMcpConfiguration;
	readonly agentPluginServerIds?: readonly string[];
	readonly skills: ProjectSkills;
	readonly interactive: boolean;
	readonly diagnostics: DiagnosticSink;
	readonly resources: WorkspaceSessionResources;
	readonly hooks: { snapshot(): HookRuntimeSnapshot };
}): Promise<ProjectServices> {
	let mcpConfiguration = input.mcpConfiguration;
	let mcpRegistry: CodingMcpRegistry | undefined;
	let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
	let mcpRegistryBinding: McpCommandRegistryBinding | undefined;
	let detachMcpCatalog: (() => void) | undefined;
	let skillWatcher: ReturnType<SkillWatcherFactory["watch"]> | undefined;
	let skillUiClosed = false;
	const closeUi = () => {
		skillUiClosed = true;
		skillWatcher?.dispose();
		detachMcpCatalog?.();
		mcpRegistryBinding?.dispose();
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
			const mcpSnapshot = await mcpRegistry.reload(mcpConfiguration.definitions, {
				agentPluginServerIds: input.agentPluginServerIds ?? [],
			});
			for (const server of mcpSnapshot.servers) {
				if (server.status === "degraded") {
					await input.options.io.stderr.write(
						`coda: MCP Server ${server.semanticName} is unavailable: ${server.error ?? "unknown error"}\n`,
					);
				}
			}
		}
		const commandRegistry = input.options.commandRegistry ?? createCoreCommandRegistry();
		skillRegistryBinding = new SkillCommandRegistryBinding(commandRegistry);
		mcpRegistryBinding = new McpCommandRegistryBinding(commandRegistry);
		let generation = 0;
		let published = Object.freeze({
			revision: `project:${++generation}`,
			plugins: input.skills.plugins?.inventory() ?? emptyCodingPluginsSnapshot(),
			skills: input.skills.snapshot,
			mcp: mcpRegistry?.snapshot() ?? emptyMcpSnapshot(),
			agentPluginServerIds: Object.freeze([...(input.agentPluginServerIds ?? [])]),
		});
		const syncPublishedUi = (): void => {
			if (skillUiClosed) return;
			try {
				skillRegistryBinding!.sync(published.skills);
			} catch (error) {
				void Promise.resolve(
					input.diagnostics({
						code: "project-capabilities.skills-ui-sync-failed",
						message: error instanceof Error ? error.message : String(error),
					}),
				).catch(() => undefined);
			}
			try {
				mcpRegistryBinding!.sync(published.mcp);
			} catch (error) {
				void Promise.resolve(
					input.diagnostics({
						code: "project-capabilities.mcp-ui-sync-failed",
						message: error instanceof Error ? error.message : String(error),
					}),
				).catch(() => undefined);
			}
		};
		const publish = (candidate: {
			readonly plugins: CodingPluginsSnapshot;
			readonly skills: CodingSkillsSnapshot;
			readonly mcp: McpHostSnapshot;
			readonly agentPluginServerIds: readonly string[];
		}) => {
			published = Object.freeze({
				revision: `project:${++generation}`,
				...candidate,
				agentPluginServerIds: Object.freeze([...candidate.agentPluginServerIds]),
			});
			syncPublishedUi();
			return published;
		};
		syncPublishedUi();
		const collectRetiredRevisions = async (signal?: AbortSignal): Promise<void> => {
			try {
				await input.skills.plugins?.collectRetiredRevisions?.(signal);
			} catch (error) {
				await input.diagnostics({
					code: "project-capabilities.plugin-revision-cleanup-failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		};
		const watchedProjectLocations = (): readonly string[] =>
			Object.freeze([
				...new Set([...input.skills.roots.map(({ path }) => path), ...(input.skills.plugins?.watchRoots ?? [])]),
			]);
		const reconcileSkillWatcher = (): void => {
			if (!skillWatcher) return;
			try {
				skillWatcher.reconcile(watchedProjectLocations());
			} catch (error) {
				void Promise.resolve(
					input.diagnostics({
						code: "skills.watcher-failed",
						message: error instanceof Error ? error.message : String(error),
					}),
				).catch(() => undefined);
			}
		};
		await collectRetiredRevisions();
		const mcpCommandSnapshot = () => ({
			host: published.mcp,
			...(mcpConfiguration.workspace ? { workspace: mcpConfiguration.workspace } : {}),
		});
		let projectTransitionTail: Promise<void> = Promise.resolve();
		let requestedProjectGeneration = 0;
		let publishedProjectGeneration = 0;
		const markProjectDirty = (): void => {
			requestedProjectGeneration++;
		};
		const serializeProjectTransition = <T>(operation: () => Promise<T>): Promise<T> => {
			const result = projectTransitionTail.then(operation);
			projectTransitionTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};
		if (mcpRegistry) {
			detachMcpCatalog = mcpRegistry.onDidChange((snapshot) => {
				void serializeProjectTransition(async () => {
					if (snapshot.revision <= published.mcp.revision) return;
					publish({
						plugins: published.plugins,
						skills: published.skills,
						mcp: snapshot,
						agentPluginServerIds: published.agentPluginServerIds,
					});
				}).catch((error: unknown) => {
					void Promise.resolve(
						input.diagnostics({
							code: "project-capabilities.mcp-publication-failed",
							message: error instanceof Error ? error.message : String(error),
						}),
					).catch(() => undefined);
				});
			});
		}
		const executeFullRefresh = async () => {
			const refreshGeneration = requestedProjectGeneration;
			try {
				const latestSettings = await input.options.settings.load();
				const candidateSettings = withLatestProjectCapabilitySettings(input.settings.current, latestSettings);
				const nativeMcpConfiguration = await inspectMcpConfiguration({
					workspace: input.workspace.root,
					fileSystem: input.options.fileSystem,
					userServers: candidateSettings.mcpServers ?? [],
					workspaceTrust: candidateSettings.workspaceMcpTrust ?? [],
					environment: input.options.runtime.environment,
				});
				const candidatePlugins = (await input.skills.plugins?.refresh(candidateSettings)) ?? published.plugins;
				input.skills.manager.markDirty();
				const candidateSkills = await input.skills.manager.refresh({ rescan: false });
				const pluginDefinitions = (await input.skills.plugins?.mcpDefinitions({
					settings: candidateSettings,
					reservedServerIds: nativeMcpConfiguration.definitions.map(({ id }) => id),
				})) ?? { definitions: [], agentPluginServerIds: [] };
				const candidateMcpConfiguration = Object.freeze({
					...nativeMcpConfiguration,
					definitions: Object.freeze([...nativeMcpConfiguration.definitions, ...pluginDefinitions.definitions]),
				});
				if (!mcpRegistry && candidateMcpConfiguration.definitions.length > 0) {
					throw new Error("MCP Servers are configured but no MCP connector is available");
				}
				const candidateMcp = mcpRegistry
					? await mcpRegistry.reload(candidateMcpConfiguration.definitions, {
							agentPluginServerIds: pluginDefinitions.agentPluginServerIds,
						})
					: emptyMcpSnapshot();
				mcpConfiguration = candidateMcpConfiguration;
				input.settings.current = candidateSettings;
				publish({
					plugins: candidatePlugins,
					skills: candidateSkills,
					mcp: candidateMcp,
					agentPluginServerIds: pluginDefinitions.agentPluginServerIds,
				});
				reconcileSkillWatcher();
				publishedProjectGeneration = Math.max(publishedProjectGeneration, refreshGeneration);
				await collectRetiredRevisions();
				return { skills: published.skills, mcp: mcpCommandSnapshot() };
			} catch (error) {
				await input.diagnostics({
					code: "project-capabilities.refresh-failed",
					message: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		};
		const refreshProject = () => serializeProjectTransition(executeFullRefresh);
		const acquireRunCapabilityBundle: AcquireProjectRunCapabilityBundle = (signal) =>
			serializeProjectTransition(async (): Promise<ProjectRunCapabilityBundle> => {
				signal.throwIfAborted();
				if (publishedProjectGeneration < requestedProjectGeneration) await executeFullRefresh();
				const retainedRevisions = await input.skills.plugins?.retainRunRevisions?.(published.plugins, signal);
				try {
					if (mcpRegistry) {
						try {
							await mcpRegistry.refresh({ signal });
						} catch (error) {
							signal.throwIfAborted();
							await input.diagnostics({
								code: "project-capabilities.mcp-tools-refresh-failed",
								message: error instanceof Error ? error.message : String(error),
							});
						}
						const currentMcp = mcpRegistry.snapshot();
						if (currentMcp.revision !== published.mcp.revision) {
							publish({
								plugins: published.plugins,
								skills: published.skills,
								mcp: currentMcp,
								agentPluginServerIds: published.agentPluginServerIds,
							});
						}
					}
					const state = published;
					const mcpLease = mcpRegistry ? mcpRegistry.acquireTools() : emptyMcpToolLease(state.mcp);
					if (signal.aborted) {
						await mcpLease.dispose().catch(() => undefined);
						signal.throwIfAborted();
					}
					let disposeOperation: Promise<void> | undefined;
					return Object.freeze({
						revision: state.revision,
						plugins: state.plugins,
						skills: state.skills,
						mcp: mcpLease,
						dispose: () => {
							disposeOperation ??= (async () => {
								const results = await Promise.allSettled([
									Promise.resolve(mcpLease.dispose()),
									Promise.resolve(retainedRevisions?.dispose()),
								]);
								const failures = results.filter(
									(result): result is PromiseRejectedResult => result.status === "rejected",
								);
								if (failures.length === 1) throw failures[0]!.reason;
								if (failures.length > 1) {
									throw new AggregateError(
										failures.map(({ reason }) => reason),
										"Project Run capability disposal failed",
									);
								}
							})();
							return disposeOperation;
						},
					});
				} catch (error) {
					await Promise.resolve(retainedRevisions?.dispose()).catch(() => undefined);
					throw error;
				}
			});
		if (input.interactive && input.options.skillWatcher) {
			skillWatcher = input.options.skillWatcher.watch(
				watchedProjectLocations(),
				() => {
					// One serialized reload publishes Plugin Skills and MCP definitions from
					// the same refreshed inventory instead of leaving a split live view.
					markProjectDirty();
					void refreshProject().catch((error: unknown) =>
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
		return {
			...(mcpRegistry ? { mcpRegistry } : {}),
			commandRegistry,
			skillsCommand: {
				snapshot: async () => published.skills,
				refresh: async () => (await refreshProject()).skills,
			},
			mcpCommand: {
				snapshot: mcpCommandSnapshot,
				reload: async () => (await refreshProject()).mcp,
				reconnect: (serverId: string) =>
					serializeProjectTransition(async () => {
						if (!mcpRegistry) throw new Error("MCP is unavailable");
						const mcp = await mcpRegistry.reconnect(serverId);
						publish({
							plugins: published.plugins,
							skills: published.skills,
							mcp,
							agentPluginServerIds: published.agentPluginServerIds,
						});
						return mcpCommandSnapshot();
					}),
			},
			hooksCommand: { snapshot: () => input.hooks.snapshot() },
			acquireRunCapabilityBundle,
			refreshProject: async () => {
				await refreshProject();
			},
			markProjectDirty,
			capabilityCatalogSnapshot: () => published,
			configuredMcpServers: () =>
				Object.freeze([
					...(input.settings.current.mcpServers ?? []),
					...(mcpConfiguration.workspace?.servers ?? []),
					...mcpConfiguration.definitions.map(configurationForDefinition),
				]),
			closeUi,
		};
	} catch (error) {
		closeUi();
		throw error;
	}
}
