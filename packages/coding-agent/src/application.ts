import type { Clock, IdGenerator } from "@coda/agent";
import type { MutableModels } from "@coda/ai";
import { createMcpHost, type McpConnector, type McpElicitationResult } from "@coda/mcp";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal, TerminalColorScheme } from "@coda/tui";
import { findModel, HELP, parseArguments, runControlConfiguration } from "./app/argument-parsing.ts";
import { authenticateInteractively, promptRuntime, selectModelInteractively } from "./app/auth-flows.ts";
import { runInteractiveApplication } from "./app/interactive-run.ts";
import {
	assertModelSupportsImages,
	createAttachmentPreparer,
	createSessionMediaLibrary,
	restoreSessionMedia,
} from "./app/interactive-session-options.ts";
import { promptInput } from "./app/media-attachments.ts";
import { runPrint } from "./app/print-run.ts";
import {
	mcpTrustDecision,
	projectTrustDecision,
	validateSkillPath,
	workspaceMcpReviewText,
} from "./app/trust-gating.ts";
import {
	createMaintenanceDiagnostics,
	createWorkspaceDiffTracker,
	createWorkspaceSessionResources,
	dispatchMaintenanceCleanup,
	openWorkspaceRuntime,
	openWorkspaceSession,
	resolveWorkspaceContext,
	trackWorkspaceDiffs,
} from "./app/workspace-session.ts";
import { createCoreCommandRegistry } from "./commands/core-commands.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import { SkillCommandRegistryBinding } from "./commands/skill-extensions.ts";
import type { CompletionWorkspaceEvidenceProvider } from "./completion/index.ts";
import type { ApplicationIO } from "./host/application-io.ts";
import type { FileSystem } from "./host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { inspectMcpConfiguration } from "./mcp/config.ts";
import { CodingMcpRegistry } from "./mcp/registry.ts";
import type { McpAgentElicitation } from "./mcp/run-capability.ts";
import type { ModelCapabilityResolver } from "./models/model-capabilities.ts";
import { ProviderManager } from "./models/provider-manager.ts";
import { effectiveReasoningEffort } from "./models/reasoning-effort.ts";
import type { AgentRunControlBinding } from "./run-control/index.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import type { SessionManager } from "./session/types.ts";
import { loadProjectInstructions } from "./settings/project-context.ts";
import type { SettingsStore } from "./settings/types.ts";
import { CodingSkillsManager } from "./skills/manager.ts";
import { collectSkillRoots } from "./skills/roots.ts";
import type { CodingSkillsSnapshot } from "./skills/types.ts";
import type { SkillWatcher, SkillWatcherFactory } from "./skills/watcher.ts";
import { FullScreenOutputGate } from "./ui/full-screen-output.ts";
import { InteractiveMcpElicitationHandler } from "./ui/mcp-elicitation.ts";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./ui/process-lifecycle.ts";
import { confirmFromTerminal } from "./ui/prompts.ts";

export type { ApplicationInput, ApplicationIO, ApplicationOutput } from "./host/application-io.ts";
export type { ModelSelection } from "./models/model-selection.ts";
export type { ProjectTrustRecord, SettingsStore, UserSettings } from "./settings/types.ts";

export interface ApplicationRuntime {
	readonly cwd: string;
	readonly homeDirectory: string;
	readonly platform: NodeJS.Platform;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: Scheduler;
	readonly interactiveLifecycle?: InteractiveProcessLifecycle;
}

export interface TerminalStartupOptions {
	readonly noColor: boolean;
	readonly colorScheme: TerminalColorScheme;
}

export interface TerminalFactory {
	create(options: TerminalStartupOptions): Terminal;
}

export interface CodingAgentApplicationOptions {
	readonly models: MutableModels;
	readonly providerManager?: ProviderManager;
	readonly commandRegistry?: CommandRegistry;
	readonly settings: SettingsStore;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly io: ApplicationIO;
	readonly fullScreenOutput?: FullScreenOutputGate;
	readonly runtime: ApplicationRuntime;
	readonly terminalFactory?: TerminalFactory;
	readonly keybindings?: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly sessions?: SessionManager;
	/** Node composition injects a durable, process-leased Workspace persistence Module. */
	readonly workspacePersistence?: (request: {
		readonly workspaceId: string;
		readonly workspaceRoot: string;
	}) => NonNullable<OpenCodingAgentOptions["persistence"]>;
	readonly processSessionRunner?: ProcessSessionRunner;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly mcpConnector?: McpConnector;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	/** Private deterministic seam for completion-gate integration tests. */
	readonly completionWorkspaceEvidence?: CompletionWorkspaceEvidenceProvider;
}

export interface CodingAgentApplication {
	run(args: readonly string[]): Promise<number>;
}

export function createCodingAgentApplication(providedOptions: CodingAgentApplicationOptions): CodingAgentApplication {
	const fullScreenOutput = providedOptions.fullScreenOutput ?? new FullScreenOutputGate(providedOptions.io);
	const options: CodingAgentApplicationOptions = {
		...providedOptions,
		io: fullScreenOutput.io,
		fullScreenOutput,
		diagnostics: providedOptions.diagnostics ?? fullScreenOutput.diagnostics,
	};
	const sessions =
		options.sessions ??
		new InMemorySessionManager({ clock: options.runtime.clock, idGenerator: options.runtime.idGenerator });
	const providerManager =
		providedOptions.providerManager ??
		new ProviderManager({ models: providedOptions.models, fetch: unavailableProviderDiscoveryFetch });
	let providersRestored = false;
	return {
		run: async (args) => {
			try {
				const parsed = await parseArguments(args, options.io);
				const configuredRunControl = runControlConfiguration(parsed);
				if (configuredRunControl && !options.runtime.scheduler) {
					throw new Error("Configured RunControl requires an injected Scheduler");
				}
				if (parsed.action === "help") {
					await options.io.stdout.write(HELP);
					return 0;
				}
				if (parsed.action === "version") {
					await options.io.stdout.write("0.1.0\n");
					return 0;
				}
				if (parsed.action === "skills-validate") {
					return validateSkillPath(parsed.skillsPath!, options, parsed.output);
				}
				const maintenanceDiagnostics = createMaintenanceDiagnostics(options);
				const cleanupExit = dispatchMaintenanceCleanup({
					explicit: parsed.action === "cleanup",
					output: parsed.output,
					options,
					diagnostics: maintenanceDiagnostics,
				});
				if (cleanupExit) return await cleanupExit;
				if (parsed.action === "sessions") {
					const { workspace, workspaceId } = await resolveWorkspaceContext(parsed.workspace, options);
					const descriptors = await sessions.list({ id: workspaceId, path: workspace.root });
					if (parsed.output === "json") {
						for (const descriptor of descriptors) {
							await options.io.stdout.write(
								`${JSON.stringify({ schemaVersion: 1, type: "session", ...descriptor })}\n`,
							);
						}
					} else if (descriptors.length === 0) {
						await options.io.stdout.write("(no Sessions)\n");
					} else {
						for (const descriptor of descriptors) {
							await options.io.stdout.write(
								`${descriptor.id}\t${new Date(descriptor.createdAt).toISOString()}\t${descriptor.workspace.path}\n`,
							);
						}
					}
					return 0;
				}
				if (parsed.mode === "print" && parsed.prompt.length === 0 && parsed.imagePaths.length === 0) {
					throw new Error("Print mode requires a prompt or image");
				}
				let settings = await options.settings.load();
				if (!providersRestored) {
					providerManager.restore(settings.customProviders ?? []);
					providersRestored = true;
				}
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
				const interactiveRuntime = terminal ? promptRuntime(options, terminal) : undefined;
				const { workspace, workspaceId, session } = await openWorkspaceSession({
					path: parsed.workspace,
					options,
					sessions,
					mode: parsed.mode,
					resumeId: parsed.resumeId,
					forceUnlock: parsed.forceUnlock,
					persistent: parsed.persistSession || (parsed.mode === "interactive" && !parsed.noSession),
				});
				const workspaceDiffs = createWorkspaceDiffTracker({
					processRunner: options.processRunner,
					workspace: workspace.root,
					environment: options.runtime.environment,
				});
				const mediaLibrary = createSessionMediaLibrary(session, options);
				const workspaceResources = createWorkspaceSessionResources({
					session,
					mediaLibrary,
					workspaceDiffs,
				});
				let skillWatcher: SkillWatcher | undefined;
				let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
				let skillUiClosed = false;
				let mcpRegistry: CodingMcpRegistry | undefined;
				let runControlBinding: AgentRunControlBinding | undefined;
				try {
					let selection = parsed.model ?? session.restored.model ?? settings.defaultModel;
					if (!selection) {
						if (!interactiveRuntime) {
							throw new Error("Print mode requires an explicit, restored, or configured Model");
						}
						selection = await selectModelInteractively(options, interactiveRuntime);
						settings = { ...settings, defaultModel: selection };
						await options.settings.save(settings);
					}
					const model = findModel(options.models, selection);
					const reasoning = effectiveReasoningEffort(
						model,
						parsed.reasoning ?? session.restored.reasoning ?? settings.defaultReasoning ?? "medium",
					);
					const projectInstructions = await loadProjectInstructions(workspace, options.fileSystem);
					let projectTrust = projectTrustDecision({
						workspace: workspace.root,
						...(projectInstructions ? { instructions: projectInstructions } : {}),
						settings,
						authorized: false,
					});
					if (projectInstructions && !projectTrust.trusted) {
						const trustedInteractively =
							!parsed.trustProject && interactiveRuntime
								? await confirmFromTerminal(
										interactiveRuntime,
										[
											"Trust this project instruction file?",
											`Path: ${projectInstructions.path}`,
											`SHA-256: ${projectInstructions.sha256}`,
											"The exact hash will be bound to this Workspace; any change requires review again.",
											"",
											"Content preview:",
											projectInstructions.content.slice(0, 2_000),
											...(projectInstructions.content.length > 2_000
												? ["… (preview truncated; review the file at the path above)"]
												: []),
										].join("\n"),
									)
								: false;
						projectTrust = projectTrustDecision({
							workspace: workspace.root,
							instructions: projectInstructions,
							settings,
							authorized: parsed.trustProject || trustedInteractively,
						});
						if (!projectTrust.trusted) {
							throw new Error(
								`AGENTS.md is untrusted or changed (${projectInstructions.sha256}); pass --trust-project after review`,
							);
						}
						if (projectTrust.updatedSettings && projectTrust.trustRecord) {
							settings = projectTrust.updatedSettings;
							await options.settings.save(settings);
							await session.record({ type: "project_trust_changed", trust: projectTrust.trustRecord });
						}
					}
					const skillRoots = await collectSkillRoots({
						workspace: workspace.root,
						homeDirectory: options.runtime.homeDirectory,
					});
					const skillsManager = new CodingSkillsManager({
						fileSystem: options.fileSystem,
						roots: skillRoots,
					});
					const skillsSnapshot = await skillsManager.refresh();
					let mcpConfiguration = await inspectMcpConfiguration({
						workspace: workspace.root,
						fileSystem: options.fileSystem,
						userServers: settings.mcpServers ?? [],
						workspaceTrust: settings.workspaceMcpTrust ?? [],
						environment: options.runtime.environment,
					});
					if (mcpConfiguration.workspace?.trust === "untrusted") {
						const trustedInteractively =
							!parsed.trustProjectMcp && interactiveRuntime
								? await confirmFromTerminal(
										interactiveRuntime,
										workspaceMcpReviewText(mcpConfiguration.workspace),
									)
								: false;
						const mcpTrust = mcpTrustDecision({
							workspace: workspace.root,
							snapshot: mcpConfiguration.workspace,
							settings,
							authorized: parsed.trustProjectMcp || trustedInteractively,
						});
						if (mcpTrust.updatedSettings && mcpTrust.trustRecord) {
							settings = mcpTrust.updatedSettings;
							await options.settings.save(settings);
							await session.record({ type: "mcp_trust_changed", trust: mcpTrust.trustRecord });
							mcpConfiguration = await inspectMcpConfiguration({
								workspace: workspace.root,
								fileSystem: options.fileSystem,
								userServers: settings.mcpServers ?? [],
								workspaceTrust: settings.workspaceMcpTrust ?? [],
								environment: options.runtime.environment,
							});
						} else if (!mcpTrust.trusted && !interactiveRuntime) {
							await options.io.stderr.write(
								`coda: Workspace MCP configuration ${mcpConfiguration.workspace.sha256} is untrusted; its Servers were omitted\n`,
							);
						}
					}
					if (mcpConfiguration.definitions.length > 0 && !options.mcpConnector) {
						throw new Error("MCP Servers are configured but no MCP connector is available");
					}
					if (options.mcpConnector) {
						mcpRegistry = new CodingMcpRegistry({
							host: createMcpHost({ connector: options.mcpConnector }),
							...(options.runtime.scheduler ? { scheduler: options.runtime.scheduler } : {}),
						});
						workspaceResources.useMcpRegistry(mcpRegistry);
						const mcpSnapshot = await mcpRegistry.reload(mcpConfiguration.definitions);
						for (const server of mcpSnapshot.servers) {
							if (server.status === "degraded") {
								await options.io.stderr.write(
									`coda: MCP Server ${server.id} is unavailable: ${server.error ?? "unknown error"}\n`,
								);
							}
						}
					}
					const commandRegistry = options.commandRegistry ?? createCoreCommandRegistry();
					skillRegistryBinding = new SkillCommandRegistryBinding(commandRegistry);
					skillRegistryBinding.sync(skillsSnapshot);
					if (interactiveRuntime && options.skillWatcher) {
						skillWatcher = options.skillWatcher.watch(
							skillRoots.map(({ path }) => path),
							() => {
								skillsManager.markDirty();
								void skillsManager
									.refresh({ rescan: false })
									.then((snapshot) => {
										if (!skillUiClosed) skillRegistryBinding!.sync(skillsManager.current ?? snapshot);
									})
									.catch((error: unknown) =>
										maintenanceDiagnostics({
											code: "skills.refresh-failed",
											message: error instanceof Error ? error.message : String(error),
										}),
									);
							},
							(error) => {
								void maintenanceDiagnostics({ code: "skills.watcher-failed", message: error.message });
							},
						);
					}
					const refreshSkills = async (): Promise<CodingSkillsSnapshot> => {
						const snapshot = await skillsManager.refresh();
						const current = skillsManager.current ?? snapshot;
						skillRegistryBinding!.sync(current);
						return current;
					};
					const skillsCommand = {
						snapshot: refreshSkills,
						refresh: refreshSkills,
					};
					const mcpCommandSnapshot = () => ({
						host:
							mcpRegistry?.snapshot() ?? Object.freeze({ revision: 0, servers: [], tools: [], diagnostics: [] }),
						...(mcpConfiguration.workspace ? { workspace: mcpConfiguration.workspace } : {}),
					});
					const reloadMcp = async () => {
						const latestSettings = await options.settings.load();
						settings = {
							...settings,
							mcpServers: latestSettings.mcpServers,
							workspaceMcpTrust: latestSettings.workspaceMcpTrust,
						};
						mcpConfiguration = await inspectMcpConfiguration({
							workspace: workspace.root,
							fileSystem: options.fileSystem,
							userServers: settings.mcpServers ?? [],
							workspaceTrust: settings.workspaceMcpTrust ?? [],
							environment: options.runtime.environment,
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
					const mcpCommand = {
						snapshot: mcpCommandSnapshot,
						reload: reloadMcp,
						reconnect: async (serverId: string) => {
							if (!mcpRegistry) throw new Error("MCP is unavailable");
							await mcpRegistry.reconnect(serverId);
							return mcpCommandSnapshot();
						},
					};
					let auth = await options.models.getAuth(model, {
						apiKey: parsed.apiKey,
						clock: options.runtime.clock,
					});
					if (!auth && interactiveRuntime && !parsed.apiKey) {
						await authenticateInteractively(options, model.provider, interactiveRuntime);
						auth = await options.models.getAuth(model, { clock: options.runtime.clock });
					}
					if (!auth) throw new Error(`Model is not authenticated: ${model.provider}/${model.id}`);
					assertModelSupportsImages(model, parsed.imagePaths.length);
					const initialAttachmentIds: string[] = [];
					for (const path of parsed.imagePaths) {
						initialAttachmentIds.push((await mediaLibrary.ingestPath(path)).id);
					}
					const initialInput = await promptInput(parsed.prompt, initialAttachmentIds, mediaLibrary);
					const interactiveMcpElicitation =
						parsed.mode === "interactive" && !options.mcpElicitation
							? new InteractiveMcpElicitationHandler()
							: undefined;
					const primaryMcpElicitation =
						options.mcpElicitation ?? interactiveMcpElicitation?.forSession(session.descriptor.id);
					const openedWorkspace = await openWorkspaceRuntime({
						options,
						resources: workspaceResources,
						sessions,
						session,
						workspace,
						workspaceId,
						mode: parsed.mode,
						forceUnlock: parsed.forceUnlock,
						maxTurns: parsed.maxTurns,
						disableRunBudget: parsed.disableRunBudget,
						maxOutputTokens: parsed.maxOutputTokens,
						skillsManager,
						mcpRegistry,
						projectInstructions,
						model,
						reasoning,
						authSnapshot: auth,
						mcpElicitation: primaryMcpElicitation,
						runControl: configuredRunControl,
					});
					const activeProcessSessionManager = openedWorkspace.processSessionManager;
					const inputResources = openedWorkspace.inputResources;
					const activeWorkCoordinator = openedWorkspace.coordinator;
					const agentRuntime = openedWorkspace.work;
					runControlBinding = openedWorkspace.runControl;
					const restoredMedia = await restoreSessionMedia(session, options.fileSystem);
					const prepareAttachments = createAttachmentPreparer({
						restoredMedia,
						mediaLibrary,
						session,
						inputResources,
					});
					trackWorkspaceDiffs({
						work: agentRuntime,
						session,
						mode: parsed.mode,
						tracker: workspaceDiffs,
					});
					if (parsed.mode === "interactive") {
						return await runInteractiveApplication({
							options,
							providerManager,
							settings,
							sessions,
							workspace,
							workspaceId,
							session,
							work: agentRuntime,
							mediaLibrary,
							restoredMedia,
							inputResources,
							processSessionManager: activeProcessSessionManager,
							coordinator: activeWorkCoordinator,
							skillsManager,
							skillsSnapshot,
							skillsCommand,
							mcpCommand,
							commandRegistry,
							model,
							reasoning,
							apiKey: parsed.apiKey,
							runControl: configuredRunControl,
							interactiveRuntime: interactiveRuntime!,
							mcpElicitation: interactiveMcpElicitation,
							workspaceDiffs,
							initialInput,
							initialAttachmentIds,
							noAnimations: parsed.noAnimations,
						});
					}
					return await runPrint({
						work: agentRuntime,
						session,
						input: initialInput,
						attachmentIds: initialAttachmentIds,
						prepareAttachments,
						mediaLibrary,
						output: parsed.output,
						jsonEventStream: parsed.jsonEventStream,
						includeMediaData: parsed.includeMediaData,
						io: options.io,
						processRunner: options.processRunner,
						fileSystem: options.fileSystem,
						workspace: workspace.root,
						environment: options.runtime.environment,
						clock: options.runtime.clock,
						completionWorkspaceEvidence: options.completionWorkspaceEvidence,
						runControl: runControlBinding,
						drainWorkspaceDiffSupplements: workspaceDiffs.drain,
					});
				} finally {
					runControlBinding?.dispose();
					skillUiClosed = true;
					skillWatcher?.dispose();
					skillRegistryBinding?.dispose();
					await workspaceResources.close();
				}
			} catch (error) {
				if (error instanceof InteractiveTerminationError) return error.exitCode;
				const message = error instanceof Error ? error.message : String(error);
				await options.io.stderr.write(`coda: ${message}\n`);
				return 1;
			}
		},
	};
}

const unavailableProviderDiscoveryFetch: typeof globalThis.fetch = async () => {
	throw new Error("Custom Provider discovery requires an injected fetch adapter");
};
