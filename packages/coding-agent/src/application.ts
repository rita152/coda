import type { Clock, IdGenerator } from "@coda/agent";
import type { MutableModels } from "@coda/ai";
import type { McpConnector, McpElicitationResult } from "@coda/mcp";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal, TerminalColorScheme } from "@coda/tui";
import { HELP, parseArguments, runControlConfiguration } from "./app/argument-parsing.ts";
import { runInteractiveApplication } from "./app/interactive-run.ts";
import { createAttachmentPreparer } from "./app/interactive-session-options.ts";
import { promptInput } from "./app/media-attachments.ts";
import { runPrint } from "./app/print-run.ts";
import {
	authenticateInitialModel,
	createApplicationPromptRuntime,
	createApplicationSettingsState,
	loadProjectSkills,
	openProjectServices,
	selectInitialModel,
} from "./app/project-runtime.ts";
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
	type OpenedSessionRuntime,
	openSessionRuntime,
	openWorkspaceRuntime,
	openWorkspaceSession,
	resolveWorkspaceContext,
} from "./app/workspace-session.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import type { CompletionWorkspaceEvidenceProvider } from "./completion/index.ts";
import { CommandLifecycleHookHost, hookReviewText, inspectHookConfiguration, trustAllHooks } from "./hooks/index.ts";
import type { ApplicationIO } from "./host/application-io.ts";
import type { FileSystem } from "./host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { inspectMcpConfiguration } from "./mcp/config.ts";
import type { McpAgentElicitation } from "./mcp/run-capability.ts";
import type { ModelCapabilityResolver } from "./models/model-capabilities.ts";
import { ProviderManager } from "./models/provider-manager.ts";
import { createWorkspaceWorkCoordinator } from "./runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import { summarizeSessionRecords } from "./session/session-summary.ts";
import type { SessionManager } from "./session/types.ts";
import { loadProjectInstructions } from "./settings/project-context.ts";
import type { SettingsStore } from "./settings/types.ts";
import type { SkillWatcherFactory } from "./skills/watcher.ts";
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
					const listed = { id: workspaceId, path: workspace.root };
					const summaries = sessions.listSummaries
						? await sessions.listSummaries(listed)
						: (await sessions.list(listed)).map((descriptor) => summarizeSessionRecords(descriptor, []));
					if (parsed.output === "json") {
						for (const summary of summaries) {
							await options.io.stdout.write(
								`${JSON.stringify({
									schemaVersion: 1,
									type: "session",
									title: summary.title,
									updatedAt: summary.updatedAt,
									promptCount: summary.promptCount,
									...summary.descriptor,
								})}\n`,
							);
						}
					} else if (summaries.length === 0) {
						await options.io.stdout.write("(no Sessions)\n");
					} else {
						for (const summary of summaries) {
							await options.io.stdout.write(
								`${summary.title}\t${summary.descriptor.id}\t${new Date(summary.updatedAt).toISOString()}\n`,
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
				const interactiveRuntime = createApplicationPromptRuntime(options, parsed, settings);
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
				const workspaceResources = createWorkspaceSessionResources();
				let closeProjectUi: (() => void) | undefined;
				let sessionRuntime: OpenedSessionRuntime | undefined;
				const closeRuntime = async (): Promise<void> => {
					const failures: unknown[] = [];
					try {
						if (sessionRuntime) await sessionRuntime.close();
						else await session.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await workspaceResources.close();
					} catch (error) {
						failures.push(error);
					}
					if (failures.length === 1) throw failures[0];
					if (failures.length > 1) {
						throw new AggregateError(failures, "Could not close the application runtime");
					}
				};
				try {
					const initialModel = await selectInitialModel({
						options,
						session,
						settings,
						requestedModel: parsed.model,
						requestedReasoning: parsed.reasoning,
						interactiveRuntime,
					});
					settings = initialModel.settings;
					const { model, reasoning } = initialModel;
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
					const projectSkills = await loadProjectSkills({
						workspace: workspace.root,
						homeDirectory: options.runtime.homeDirectory,
						fileSystem: options.fileSystem,
					});
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
					let hookConfiguration = await inspectHookConfiguration({
						workspace: workspace.root,
						homeDirectory: options.runtime.homeDirectory,
						fileSystem: options.fileSystem,
						trust: settings.hookTrust ?? [],
					});
					for (const diagnostic of hookConfiguration.diagnostics) {
						await maintenanceDiagnostics({
							code: diagnostic.code,
							message: `${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
						});
					}
					const untrustedHooks = hookConfiguration.handlers.filter(({ trust }) => trust === "untrusted");
					if (untrustedHooks.length > 0) {
						const trustedInteractively =
							!parsed.trustHooks && interactiveRuntime
								? await confirmFromTerminal(interactiveRuntime, hookReviewText(hookConfiguration))
								: false;
						if (parsed.trustHooks || trustedInteractively) {
							settings = trustAllHooks(settings, hookConfiguration);
							await options.settings.save(settings);
							hookConfiguration = await inspectHookConfiguration({
								workspace: workspace.root,
								homeDirectory: options.runtime.homeDirectory,
								fileSystem: options.fileSystem,
								trust: settings.hookTrust ?? [],
							});
						} else if (!interactiveRuntime) {
							await options.io.stderr.write(
								`coda: ${untrustedHooks.length} untrusted Hook handler${untrustedHooks.length === 1 ? " was" : "s were"} omitted; pass --trust-hooks after review\n`,
							);
						}
					}
					const configuredShell = options.runtime.environment.SHELL;
					const lifecycleHooks = new CommandLifecycleHookHost({
						configuration: hookConfiguration,
						processRunner: options.processRunner,
						shellExecutable: configuredShell?.startsWith("/") ? configuredShell : "/bin/sh",
						platform: options.runtime.platform,
						environment: options.runtime.environment,
						diagnostic: maintenanceDiagnostics,
					});
					workspaceResources.useLifecycleHooks(lifecycleHooks);
					const settingsState = createApplicationSettingsState(settings);
					const projectServices = await openProjectServices({
						options,
						settings: settingsState,
						workspace,
						mcpConfiguration,
						skills: projectSkills,
						interactive: interactiveRuntime !== undefined,
						diagnostics: maintenanceDiagnostics,
						resources: workspaceResources,
						hooks: lifecycleHooks,
					});
					closeProjectUi = projectServices.closeUi;
					const { mcpRegistry, commandRegistry, skillsCommand, mcpCommand, hooksCommand } = projectServices;
					const skillsManager = projectSkills.manager;
					const skillsSnapshot = projectSkills.snapshot;
					const auth = await authenticateInitialModel({
						options,
						model,
						apiKey: parsed.apiKey,
						interactiveRuntime,
						imageCount: parsed.imagePaths.length,
					});
					const interactiveMcpElicitation =
						parsed.mode === "interactive" && !options.mcpElicitation
							? new InteractiveMcpElicitationHandler()
							: undefined;
					const primaryMcpElicitation =
						options.mcpElicitation ?? interactiveMcpElicitation?.forSession(session.descriptor.id);
					const openedWorkspace = await openWorkspaceRuntime({
						createWorkCoordinator: createWorkspaceWorkCoordinator,
						options,
						resources: workspaceResources,
						sessions,
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
						lifecycleHooks,
					});
					const activeProcessSessionManager = openedWorkspace.processSessionManager;
					const inputResources = openedWorkspace.inputResources;
					const activeWorkCoordinator = openedWorkspace.coordinator;
					sessionRuntime = await openSessionRuntime({
						options,
						coordinator: activeWorkCoordinator,
						session,
						model,
						reasoning,
						authSnapshot: auth,
						mcpElicitation: primaryMcpElicitation,
						runControl: configuredRunControl,
						workspaceDiffs,
						mode: parsed.mode,
					});
					const agentRuntime = sessionRuntime.work;
					const mediaLibrary = sessionRuntime.mediaLibrary;
					const restoredMedia = sessionRuntime.restoredMedia;
					const initialAttachmentIds: string[] = [];
					for (const path of parsed.imagePaths) {
						initialAttachmentIds.push((await mediaLibrary.ingestPath(path)).id);
					}
					const initialInput = await promptInput(parsed.prompt, initialAttachmentIds, mediaLibrary);
					const prepareAttachments = createAttachmentPreparer({
						restoredMedia,
						mediaLibrary,
						session,
						inputResources,
					});
					if (parsed.mode === "interactive") {
						return await runInteractiveApplication({
							options,
							providerManager,
							settings: settingsState,
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
							hooksCommand,
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
						runControl: sessionRuntime.runControl,
						drainWorkspaceDiffSupplements: workspaceDiffs.drain,
					});
				} finally {
					closeProjectUi?.();
					await closeRuntime();
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
