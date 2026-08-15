import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import type { Api, AuthPrompt, Model, MutableModels } from "@coda/ai";
import { createMcpHost, type McpConnector, type McpElicitationResult } from "@coda/mcp";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import {
	createTerminalImageSurface,
	type DiagnosticSink,
	type Keybinding,
	type Scheduler,
	type Terminal,
	type TerminalColorScheme,
} from "@coda/tui";
import {
	codingAgentRunBudget,
	finalText,
	findModel,
	HELP,
	parseArguments,
	runControlConfiguration,
} from "./app/argument-parsing.ts";
import { JsonEventWriter } from "./app/json-event-writer.ts";
import {
	chatAttachment,
	hasAgentInput,
	openAttachmentInSystemViewer,
	openPathInSystemViewer,
	pathSafeIdentity,
	prepareAttachmentTransaction,
	projectJsonMedia,
	promptInput,
	restoredChatAttachments,
} from "./app/media-attachments.ts";
import { createSessionPresentation } from "./app/session-presentation.ts";
import {
	assertSkillReferencesAvailable,
	mcpTrustDecision,
	projectTrustDecision,
	validateSkillPath,
	workspaceMcpReviewText,
} from "./app/trust-gating.ts";
import { createCoreCommandRegistry } from "./commands/core-commands.ts";
import type { ModelCommandEntry } from "./commands/model-flow.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import { SkillCommandRegistryBinding } from "./commands/skill-extensions.ts";
import {
	CodingCompletionController,
	type CompletionWorkspaceEvidenceProvider,
	createGitWorkspaceEvidenceProvider,
} from "./completion/index.ts";
import { collectWorkspaceDiff } from "./completion/workspace-diff.ts";
import type { ApplicationIO } from "./host/application-io.ts";
import type { FileSystem } from "./host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { createWorkspace } from "./host/workspace.ts";
import { cleanupSessionMedia } from "./maintenance/session-media.ts";
import { cleanupTemporaryLogs } from "./maintenance/temporary-logs.ts";
import { inspectMcpConfiguration } from "./mcp/config.ts";
import { CodingMcpRegistry } from "./mcp/registry.ts";
import type { McpAgentElicitation } from "./mcp/run-capability.ts";
import { MediaLibrary } from "./media/media-library.ts";
import { type ModelCapabilityResolver, resolveModelRuntimeCapabilities } from "./models/model-capabilities.ts";
import { catalogModelFromRuntime } from "./models/model-catalog.ts";
import type { ModelSelection } from "./models/model-selection.ts";
import { ProviderManager } from "./models/provider-manager.ts";
import { availableReasoningEfforts, effectiveReasoningEffort } from "./models/reasoning-effort.ts";
import { ProcessSessionManager } from "./process/process-session-manager.ts";
import { type AgentRunControlBinding, bindAgentRunControl } from "./run-control/index.ts";
import { withRunControlEvidence } from "./run-evidence/run-evidence.ts";
import type { SessionWorkController } from "./runtime/session-work-controller.ts";
import { WorkspaceInputResources } from "./runtime/workspace-input-resources.ts";
import { createWorkspaceWorkCoordinator } from "./runtime/workspace-work-coordinator.ts";
import { DraftSession } from "./session/draft-session.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import type { Session, SessionId, SessionManager } from "./session/types.ts";
import { loadProjectInstructions } from "./settings/project-context.ts";
import type { SettingsStore } from "./settings/types.ts";
import {
	activateExplicitSkillReferences,
	prependSkillContext,
	renderExplicitSkillContext,
	renderExplicitSkillReferences,
	sharedSkillArguments,
} from "./skills/context.ts";
import { CodingSkillsManager } from "./skills/manager.ts";
import { collectSkillRoots } from "./skills/roots.ts";
import type { CodingSkillsSnapshot } from "./skills/types.ts";
import type { SkillWatcher, SkillWatcherFactory } from "./skills/watcher.ts";
import { activitySummaryModeForApi } from "./ui/activity-status.ts";
import { FullScreenOutputGate } from "./ui/full-screen-output.ts";
import { InteractiveMcpElicitationHandler } from "./ui/mcp-elicitation.ts";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./ui/process-lifecycle.ts";
import { confirmFromTerminal, type PromptRuntime, promptTextFromTerminal, selectFromTerminal } from "./ui/prompts.ts";
import { type InteractiveSessionOptions, runInteractive } from "./ui/run-interactive.ts";
import { sessionCostSnapshot } from "./ui/session-status.ts";
import type { SessionStatusLineSnapshot } from "./ui/status-line.ts";

export type { ApplicationInput, ApplicationIO, ApplicationOutput } from "./host/application-io.ts";
export type { ModelSelection } from "./models/model-selection.ts";
export type { ProjectTrustRecord, SettingsStore, UserSettings } from "./settings/types.ts";

const unavailableProcessSessionRunner: ProcessSessionRunner = Object.freeze({
	start: async () => {
		throw new Error("Process sessions require a configured ProcessSessionRunner");
	},
});

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

function createEffortCommand(
	session: Session,
	work: SessionWorkController,
): NonNullable<InteractiveSessionOptions["effortCommand"]> {
	return {
		snapshot: () => ({
			current: work.state().selection.reasoning,
			available: availableReasoningEfforts(work.state().selection.model),
		}),
		select: async (effort) => {
			const selected = work.state().selection;
			const reasoning = effectiveReasoningEffort(selected.model, effort);
			if (reasoning !== effort) {
				throw new Error(
					`Reasoning effort ${effort} is not supported by ${selected.model.provider}/${selected.model.id}`,
				);
			}
			await session.record({
				type: "model_selected",
				model: { provider: selected.model.provider, id: selected.model.id },
				reasoning,
			});
			await work.selectReasoning(reasoning);
			return reasoning;
		},
	};
}

function promptRuntime(options: CodingAgentApplicationOptions, terminal: Terminal): PromptRuntime {
	if (!options.runtime.scheduler) {
		throw new Error("Interactive mode requires injected Terminal and Scheduler capabilities");
	}
	return {
		terminal,
		clock: options.runtime.clock,
		scheduler: options.runtime.scheduler,
		keybindings: options.keybindings ?? [],
		diagnostics: options.diagnostics,
		fullScreenOutput: options.fullScreenOutput,
		lifecycle: options.runtime.interactiveLifecycle,
	};
}

async function answerAuthPrompt(runtime: PromptRuntime, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const selected = await selectFromTerminal(runtime, prompt.message, prompt.options);
		if (selected === undefined) throw new Error("Authentication was cancelled");
		return selected;
	}
	const value = await promptTextFromTerminal(runtime, {
		message: prompt.message,
		placeholder: prompt.placeholder,
		secret: prompt.type === "secret",
	});
	if (value === undefined) throw new Error("Authentication was cancelled");
	return value;
}

async function authenticateInteractively(
	options: CodingAgentApplicationOptions,
	providerId: string,
	runtime: PromptRuntime,
): Promise<void> {
	await options.models.login(providerId, "api_key", {
		prompt: (prompt) => answerAuthPrompt(runtime, prompt),
		notify: (event) => {
			const message =
				event.type === "auth_url"
					? `Authenticate at ${event.url}`
					: event.type === "device_code"
						? `Authenticate at ${event.verificationUri} with code ${event.userCode}`
						: event.message;
			void options.io.stderr.write(`coda: ${message}\n`);
		},
	});
}

async function selectModelInteractively(
	options: CodingAgentApplicationOptions,
	runtime: PromptRuntime,
): Promise<ModelSelection> {
	let available = await options.models.getAvailable();
	if (available.length === 0) {
		const loginProviders = options.models
			.getProviders()
			.filter((provider) => provider.auth.apiKey?.login)
			.sort((left, right) => left.id.localeCompare(right.id));
		if (loginProviders.length === 0) throw new Error("No authenticated Models are available");
		const providerId =
			loginProviders.length === 1
				? loginProviders[0]!.id
				: await selectFromTerminal(
						runtime,
						"Select a Provider to authenticate",
						loginProviders.map((provider) => ({
							id: provider.id,
							label: provider.name,
							description: provider.id,
						})),
					);
		if (!providerId) throw new Error("Provider selection was cancelled");
		await authenticateInteractively(options, providerId, runtime);
		available = await options.models.getAvailable();
	}
	if (available.length === 0) throw new Error("No authenticated Models are available");
	const sorted = [...available].sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
	);
	const selected = await selectFromTerminal(
		runtime,
		"Select a Model",
		sorted.map((model) => ({
			id: `${model.provider}\0${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: `${model.name} • ${model.api}${model.reasoning ? " • reasoning" : ""}`,
		})),
	);
	if (!selected) throw new Error("Model selection was cancelled");
	const separator = selected.indexOf("\0");
	return { provider: selected.slice(0, separator), id: selected.slice(separator + 1) };
}

function interactiveStatusLineSnapshot(work: SessionWorkController, session: Session): SessionStatusLineSnapshot {
	const snapshot = work.state();
	const selected = snapshot.selection;
	const context = contextUsage(snapshot.messages, selected.model);
	const cost = sessionCostSnapshot(
		snapshot.messages,
		session.compactionCheckpoint?.usage.cumulativeCost ?? 0,
		session.discardedModelCost,
		selected.model.cost !== undefined,
	);
	return {
		modelSupportsReasoning: selected.model.reasoning,
		context: {
			usedTokens: context.usedTokens,
			windowTokens: context.windowTokens,
			estimated: context.estimated || latestUsageComesFromAnotherModel(snapshot.messages, selected.model),
		},
		...(cost ? { cost } : {}),
	};
}

function contextUsage(
	messages: import("@coda/agent").AgentState["messages"],
	model: Model<Api>,
): { readonly usedTokens: number; readonly windowTokens: number; readonly estimated: boolean } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]?.message;
		if (message?.role !== "assistant" && message?.role !== "toolResult") continue;
		const usage = message.usage;
		if (!usage) continue;
		const usedTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (usedTokens > 0) return { usedTokens, windowTokens: model.contextWindow, estimated: false };
	}
	const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
	return { usedTokens: Math.ceil(bytes / 4), windowTokens: model.contextWindow, estimated: true };
}

function latestUsageComesFromAnotherModel(
	messages: import("@coda/agent").AgentState["messages"],
	model: Model<Api>,
): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]?.message;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usageTokens =
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (usageTokens === 0) continue;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
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
				const maintenanceDiagnostics: DiagnosticSink =
					options.diagnostics ??
					((diagnostic) => options.io.stderr.write(`coda: [${diagnostic.code}] ${diagnostic.message}\n`));
				const cleanup = async () => {
					const [logs, media] = await Promise.all([
						cleanupTemporaryLogs({
							fileSystem: options.fileSystem,
							homeDirectory: options.runtime.homeDirectory,
							now: options.runtime.clock.now(),
							diagnostics: maintenanceDiagnostics,
						}),
						cleanupSessionMedia({
							fileSystem: options.fileSystem,
							homeDirectory: options.runtime.homeDirectory,
							now: options.runtime.clock.now(),
							diagnostics: maintenanceDiagnostics,
						}),
					]);
					return {
						removed: [...logs.removed, ...media.removed],
						retainedBytes: logs.retainedBytes + media.retainedBytes,
					};
				};
				if (parsed.action === "cleanup") {
					const result = await cleanup();
					if (parsed.output === "json") {
						await options.io.stdout.write(
							`${JSON.stringify({ schemaVersion: 1, type: "cleanup", removed: result.removed.length, retainedBytes: result.retainedBytes })}\n`,
						);
					} else {
						await options.io.stdout.write(
							`Removed ${result.removed.length} unreferenced artifact${result.removed.length === 1 ? "" : "s"}; ${result.retainedBytes} bytes retained.\n`,
						);
					}
					return 0;
				}
				void cleanup().catch(async (error: unknown) => {
					await maintenanceDiagnostics({
						code: "temporary-log.cleanup-failed",
						message: error instanceof Error ? error.message : String(error),
					});
				});
				if (parsed.action === "sessions") {
					const workspace = await createWorkspace(parsed.workspace ?? options.runtime.cwd, options.fileSystem);
					const workspaceId = createHash("sha256").update(workspace.root).digest("hex").slice(0, 32);
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
				const workspace = await createWorkspace(parsed.workspace ?? options.runtime.cwd, options.fileSystem);
				const workspaceId = createHash("sha256").update(workspace.root).digest("hex").slice(0, 32);
				const session = await sessions.open({
					workspace: { id: workspaceId, path: workspace.root },
					mode: parsed.mode,
					resumeId: parsed.resumeId,
					forceUnlock: parsed.forceUnlock,
					persistent: parsed.persistSession || (parsed.mode === "interactive" && !parsed.noSession),
				});
				const pendingWorkspaceDiffs = new Map<string, Set<Promise<void>>>();
				const beginWorkspaceDiffSupplement = (targetSession: Session, runId: string): Promise<void> => {
					const operation = (async () => {
						const diff = await collectWorkspaceDiff({
							processRunner: options.processRunner,
							workspace: workspace.root,
							environment: options.runtime.environment,
						});
						targetSession.supplementRunEvidence(runId, diff);
					})();
					const key = targetSession.descriptor.id;
					const pending = pendingWorkspaceDiffs.get(key) ?? new Set<Promise<void>>();
					pending.add(operation);
					pendingWorkspaceDiffs.set(key, pending);
					const remove = () => {
						pending.delete(operation);
						if (pending.size === 0) pendingWorkspaceDiffs.delete(key);
					};
					void operation.then(remove, remove);
					return operation;
				};
				const drainWorkspaceDiffSupplements = async (targetSession: Session): Promise<void> => {
					for (;;) {
						const pending = [...(pendingWorkspaceDiffs.get(targetSession.descriptor.id) ?? [])];
						if (pending.length === 0) return;
						await Promise.allSettled(pending);
					}
				};
				const mediaToken = pathSafeIdentity(options.runtime.idGenerator.generate("queue_item"));
				const mediaLibrary = new MediaLibrary({
					fileSystem: options.fileSystem,
					stagingDirectory: join(
						options.runtime.homeDirectory,
						".coda",
						"tmp",
						"media",
						pathSafeIdentity(session.descriptor.id),
						mediaToken,
					),
					mediaDirectory: session.descriptor.path
						? `${session.descriptor.path}.media`
						: join(
								options.runtime.homeDirectory,
								".coda",
								"tmp",
								"media",
								pathSafeIdentity(session.descriptor.id),
								"committed",
							),
					idGenerator: options.runtime.idGenerator,
				});
				const jsonEventWriter =
					parsed.output === "json"
						? new JsonEventWriter({
								mode: parsed.jsonEventStream,
								output: options.io.stdout,
								project: (value) => projectJsonMedia(value, mediaLibrary, parsed.includeMediaData),
							})
						: undefined;
				let skillWatcher: SkillWatcher | undefined;
				let skillRegistryBinding: SkillCommandRegistryBinding | undefined;
				let skillUiClosed = false;
				let mcpRegistry: CodingMcpRegistry | undefined;
				let processSessionManager: ProcessSessionManager | undefined;
				let runControlBinding: AgentRunControlBinding | undefined;
				let workCoordinator: ReturnType<typeof createWorkspaceWorkCoordinator> | undefined;
				const closeRuntimeResources = async (): Promise<void> => {
					const failures: unknown[] = [];
					try {
						await drainWorkspaceDiffSupplements(session);
					} catch (error) {
						failures.push(error);
					}
					try {
						if (workCoordinator) await workCoordinator.close();
						else await session.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await drainWorkspaceDiffSupplements(session);
					} catch (error) {
						failures.push(error);
					}
					try {
						await processSessionManager?.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await mcpRegistry?.close();
					} catch (error) {
						failures.push(error);
					}
					try {
						await mediaLibrary.dispose();
					} catch (error) {
						failures.push(error);
					}
					if (failures.length === 1) throw failures[0];
					if (failures.length > 1) throw new AggregateError(failures, "Could not close the Agent runtime");
				};
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
					if (parsed.imagePaths.length > 0 && !model.input.includes("image")) {
						throw new Error(`Model does not support image input: ${model.provider}/${model.id}`);
					}
					const initialAttachmentIds: string[] = [];
					for (const path of parsed.imagePaths) {
						initialAttachmentIds.push((await mediaLibrary.ingestPath(path)).id);
					}
					const initialInput = await promptInput(parsed.prompt, initialAttachmentIds, mediaLibrary);
					const configuredShell = options.runtime.environment.SHELL;
					const shellExecutable = configuredShell && isAbsolute(configuredShell) ? configuredShell : "/bin/sh";
					const interactiveMcpElicitation =
						parsed.mode === "interactive" && !options.mcpElicitation
							? new InteractiveMcpElicitationHandler()
							: undefined;
					const primaryMcpElicitation =
						options.mcpElicitation ?? interactiveMcpElicitation?.forSession(session.descriptor.id);
					const activeProcessSessionManager = new ProcessSessionManager({
						fileSystem: options.fileSystem,
						homeDirectory: options.runtime.homeDirectory,
						runner: options.processSessionRunner ?? unavailableProcessSessionRunner,
						idGenerator: options.runtime.idGenerator,
					});
					const inputResources = new WorkspaceInputResources();
					processSessionManager = activeProcessSessionManager;
					const workspacePersistence = options.workspacePersistence?.({
						workspaceId,
						workspaceRoot: workspace.root,
					});
					const activeWorkCoordinator = createWorkspaceWorkCoordinator({
						workspace,
						fileSystem: options.fileSystem,
						processRunner: options.processRunner,
						processSessionManager: activeProcessSessionManager,
						shellExecutable,
						hostRuntime: options.runtime,
						skillsManager,
						mcpRegistry,
						models: options.models,
						clock: options.runtime.clock,
						idGenerator: options.runtime.idGenerator,
						runBudget: codingAgentRunBudget(parsed.maxTurns, parsed.disableRunBudget),
						maxOutputTokens: parsed.maxOutputTokens,
						platform: options.runtime.platform,
						interactionMode: parsed.mode,
						projectInstructions,
						resources: inputResources.adapter,
						resumeDurableRoot: (sessionId) =>
							sessions.open({
								workspace: { id: workspaceId, path: workspace.root },
								mode: parsed.mode,
								resumeId: sessionId,
								forceUnlock: parsed.forceUnlock,
								persistent: true,
							}),
						...(workspacePersistence ? { persistence: workspacePersistence } : {}),
						...(options.runtime.scheduler ? { scheduler: options.runtime.scheduler } : {}),
					});
					workCoordinator = activeWorkCoordinator;
					await session.record({
						type: "model_selected",
						model: { provider: model.provider, id: model.id },
						reasoning,
					});
					const agentRuntime = await activeWorkCoordinator.open({
						session,
						selection: { model, reasoning, authSnapshot: auth },
						mcpElicitation: primaryMcpElicitation,
					});
					runControlBinding = configuredRunControl
						? bindAgentRunControl({
								work: agentRuntime,
								configuration: configuredRunControl,
								clock: options.runtime.clock,
								scheduler: options.runtime.scheduler!,
							})
						: undefined;
					const initialAttachments = await Promise.all(
						initialAttachmentIds.map((attachmentId) => chatAttachment(mediaLibrary, attachmentId)),
					);
					const restoredMedia = await restoredChatAttachments(
						session.mediaReferences,
						session.descriptor.path,
						options.fileSystem,
						new Set(session.recoverableFollowUps.map(({ item }) => item.id)),
					);
					const prepareAttachments = (attachmentIds: readonly string[]) =>
						prepareAttachmentTransaction(
							attachmentIds.filter((id) => !restoredMedia.contents.has(id)),
							mediaLibrary,
							session,
							inputResources,
						);
					const initialMessageCount = agentRuntime.state().messages.length;
					agentRuntime.subscribeResult(async (result) => {
						if (result.run) {
							const supplement = beginWorkspaceDiffSupplement(session, result.run.runId);
							if (parsed.mode === "interactive" && !agentRuntime.state().closed) {
								void supplement.catch(() => undefined);
							} else {
								await supplement;
							}
						}
					});
					const completionController =
						parsed.mode === "print"
							? new CodingCompletionController({
									workspaceEvidence:
										options.completionWorkspaceEvidence ??
										createGitWorkspaceEvidenceProvider({
											processRunner: options.processRunner,
											fileSystem: options.fileSystem,
											workspace: () => agentRuntime.state().activePlacement?.root ?? workspace.root,
											environment: options.runtime.environment,
											now: () => options.runtime.clock.now(),
										}),
									steer: (message) => agentRuntime.deliver("steering", message),
								})
							: undefined;
					if (completionController) {
						agentRuntime.subscribeControl((event) => completionController.accept(event));
					}
					if (parsed.mode === "interactive") {
						const secondaryResources = new Map<
							string,
							{
								readonly session: Session;
								readonly work: SessionWorkController;
								readonly mediaLibrary: MediaLibrary;
								readonly runControl?: AgentRunControlBinding;
							}
						>();
						const persistCustomProviders = async (): Promise<void> => {
							settings = { ...settings, customProviders: providerManager.configurations };
							await options.settings.save(settings);
						};
						const refreshProviderAuth = async (providerId: string): Promise<void> => {
							const targets = [
								{ work: agentRuntime, apiKey: parsed.apiKey },
								...[...secondaryResources.values()].map(({ work }) => ({ work, apiKey: undefined })),
							];
							for (const { work, apiKey } of targets) {
								const selected = work.state().selection;
								if (selected.model.provider !== providerId) continue;
								const model = options.models.getModel(providerId, selected.model.id) ?? selected.model;
								const authSnapshot = await options.models.getAuth(model, {
									apiKey,
									clock: options.runtime.clock,
								});
								await work.select({
									...selected,
									model,
									reasoning: effectiveReasoningEffort(model, selected.reasoning),
									authSnapshot,
								});
							}
						};
						const imageSurface = createTerminalImageSurface({
							terminal: interactiveRuntime!.terminal,
							environment: options.runtime.environment,
							allocateId: terminalImageIdAllocator(options.runtime.idGenerator),
						});
						const listModelEntries = async (): Promise<readonly ModelCommandEntry[]> => {
							const configuredProviders = new Set(
								(
									await Promise.all(
										options.models.getProviders().map(async (provider) => {
											try {
												return (await options.models.checkAuth(provider.id)) ? provider.id : undefined;
											} catch {
												return undefined;
											}
										}),
									)
								).filter((providerId): providerId is string => providerId !== undefined),
							);
							return options.models.getModels().map(
								(modelEntry): ModelCommandEntry => ({
									catalog:
										providerManager.catalogModel(modelEntry.provider, modelEntry.id) ??
										catalogModelFromRuntime(modelEntry),
									auth: configuredProviders.has(modelEntry.provider)
										? "configured"
										: "authentication_required",
								}),
							);
						};
						const authCommand = {
							providers: () => providerManager.authenticationEntries(),
							updateApiKey: async (providerId: string, apiKey: string) => {
								await providerManager.updateApiKey(providerId, apiKey);
								await persistCustomProviders();
								await refreshProviderAuth(providerId);
							},
							logout: async (providerId: string) => {
								await providerManager.logout(providerId);
								await refreshProviderAuth(providerId);
							},
							addCustomProvider: async (input: Parameters<ProviderManager["addCustomProvider"]>[0]) => {
								await providerManager.addCustomProvider(input);
								await persistCustomProviders();
							},
						};
						const createSecondarySessionOptions = async (
							targetSession: Session,
							fresh: boolean,
						): Promise<InteractiveSessionOptions> => {
							const targetMcpElicitation =
								options.mcpElicitation ?? interactiveMcpElicitation?.forSession(targetSession.descriptor.id);
							const targetMediaToken = pathSafeIdentity(options.runtime.idGenerator.generate("queue_item"));
							const targetMediaLibrary = new MediaLibrary({
								fileSystem: options.fileSystem,
								stagingDirectory: join(
									options.runtime.homeDirectory,
									".coda",
									"tmp",
									"media",
									pathSafeIdentity(targetSession.descriptor.id),
									targetMediaToken,
								),
								mediaDirectory: targetSession.descriptor.path
									? `${targetSession.descriptor.path}.media`
									: join(
											options.runtime.homeDirectory,
											".coda",
											"tmp",
											"media",
											pathSafeIdentity(targetSession.descriptor.id),
											"committed",
										),
								idGenerator: options.runtime.idGenerator,
							});
							let targetRuntimeToClose: SessionWorkController | undefined;
							let targetRunControlToDispose: AgentRunControlBinding | undefined;
							try {
								const targetSelection = targetSession.restored.model ?? settings.defaultModel;
								if (!targetSelection) throw new Error("A new Session requires a configured default Model");
								const targetModel = findModel(options.models, targetSelection);
								const targetReasoning = effectiveReasoningEffort(
									targetModel,
									targetSession.restored.reasoning ?? settings.defaultReasoning ?? "medium",
								);
								const targetAuth = await options.models.getAuth(targetModel, { clock: options.runtime.clock });
								if (!targetSession.restored.model) {
									const initialModelSelection = {
										type: "model_selected",
										model: { provider: targetModel.provider, id: targetModel.id },
										reasoning: targetReasoning,
									} as const;
									if (fresh && targetSession instanceof DraftSession) {
										targetSession.stageInitialChanges([initialModelSelection]);
									} else {
										await targetSession.record(initialModelSelection);
									}
								}
								const targetRuntime = await activeWorkCoordinator.open({
									session: targetSession,
									selection: {
										model: targetModel,
										reasoning: targetReasoning,
										authSnapshot: targetAuth,
									},
									mcpElicitation: targetMcpElicitation,
								});
								targetRuntimeToClose = targetRuntime;
								const targetRunControl = configuredRunControl
									? bindAgentRunControl({
											work: targetRuntime,
											configuration: configuredRunControl,
											clock: options.runtime.clock,
											scheduler: options.runtime.scheduler!,
										})
									: undefined;
								targetRunControlToDispose = targetRunControl;
								const targetRestoredMedia = await restoredChatAttachments(
									targetSession.mediaReferences,
									targetSession.descriptor.path,
									options.fileSystem,
									new Set(targetSession.recoverableFollowUps.map(({ item }) => item.id)),
								);
								const targetPrepareAttachments = (attachmentIds: readonly string[]) =>
									prepareAttachmentTransaction(
										attachmentIds.filter((id) => !targetRestoredMedia.contents.has(id)),
										targetMediaLibrary,
										targetSession,
										inputResources,
									);
								targetRuntime.subscribeResult(async (result) => {
									if (result.run) {
										const supplement = beginWorkspaceDiffSupplement(targetSession, result.run.runId);
										if (targetRuntime.state().closed) await supplement;
										else void supplement.catch(() => undefined);
									}
								});
								secondaryResources.set(targetSession.descriptor.id, {
									session: targetSession,
									work: targetRuntime,
									mediaLibrary: targetMediaLibrary,
									...(targetRunControl ? { runControl: targetRunControl } : {}),
								});
								return {
									work: targetRuntime,
									presentation: createSessionPresentation(targetSession),
									inputSession: targetSession,
									modelLabel: `${targetModel.provider}/${targetModel.id}`,
									activitySummaryMode: activitySummaryModeForApi(targetModel.api),
									statusLine: () => interactiveStatusLineSnapshot(targetRuntime, targetSession),
									modelCommand: {
										currentKey: () =>
											`${targetRuntime.state().selection.model.provider}/${targetRuntime.state().selection.model.id}`,
										list: listModelEntries,
										select: async (selected) => {
											const authSnapshot = await options.models.getAuth(selected.runtime, {
												clock: options.runtime.clock,
											});
											if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
											const nextReasoning = effectiveReasoningEffort(
												selected.runtime,
												targetRuntime.state().selection.reasoning,
											);
											await targetSession.record({
												type: "model_selected",
												model: { provider: selected.providerId, id: selected.id },
												reasoning: nextReasoning,
											});
											await targetRuntime.select({
												model: selected.runtime,
												reasoning: nextReasoning,
												authSnapshot,
											});
											return {
												modelLabel: selected.key,
												reasoning: nextReasoning,
												activitySummaryMode: activitySummaryModeForApi(selected.runtime.api),
											};
										},
										authenticate: (providerId) => {
											throw new Error(`Provider requires authentication: ${providerId}; use /auth`);
										},
									},
									effortCommand: createEffortCommand(targetSession, targetRuntime),
									authCommand,
									skillsCommand,
									mcpCommand,
									reasoning: targetReasoning,
									restoredAttachments: targetRestoredMedia.attachments,
									resolveExtensionReferences: async (references) => {
										const snapshot = await skillsManager.refresh({ rescan: false });
										assertSkillReferencesAvailable(snapshot, references);
									},
									buildPrompt: async (text, attachmentIds, inputContext) => {
										const selectedModel = targetRuntime.state().selection.model;
										if (attachmentIds.length > 0 && !selectedModel.input.includes("image")) {
											throw new Error(
												`Model does not support image input: ${selectedModel.provider}/${selectedModel.id}`,
											);
										}
										const skillReferences = inputContext.references.filter(
											({ source }) => source === "skill",
										);
										if (skillReferences.length === 0) {
											return promptInput(
												text,
												attachmentIds,
												targetMediaLibrary,
												targetRestoredMedia.contents,
											);
										}
										const snapshot = skillsManager.current ?? skillsSnapshot;
										assertSkillReferencesAvailable(snapshot, inputContext.references);
										const taskText = sharedSkillArguments(inputContext.composerText, skillReferences) ?? "";
										const input = await promptInput(
											taskText,
											attachmentIds,
											targetMediaLibrary,
											targetRestoredMedia.contents,
										);
										const activations = await activateExplicitSkillReferences({
											snapshot,
											references: skillReferences,
											composerText: inputContext.composerText,
										});
										const prepared = prependSkillContext(
											input,
											renderExplicitSkillContext(activations),
											renderExplicitSkillReferences(activations),
										);
										return prepared;
									},
									prepareAttachments: targetPrepareAttachments,
									onDetach: (attachmentId) =>
										targetRestoredMedia.contents.has(attachmentId)
											? Promise.resolve()
											: targetMediaLibrary.detach(attachmentId),
									onOpenAttachment: (attachmentId) => {
										const restoredPath = targetRestoredMedia.paths.get(attachmentId);
										return restoredPath
											? openPathInSystemViewer(
													restoredPath,
													options.processRunner,
													options.runtime,
													workspace.root,
												)
											: openAttachmentInSystemViewer(
													targetMediaLibrary,
													attachmentId,
													options.processRunner,
													options.runtime,
													workspace.root,
												);
									},
									toolResultImagesSupported: resolveModelRuntimeCapabilities(
										targetModel,
										options.modelCapabilities,
									).toolResultImages,
									onRetire: () => activeProcessSessionManager.retireSession(targetSession.descriptor.id),
								};
							} catch (error) {
								targetRunControlToDispose?.dispose();
								if (targetRuntimeToClose) await targetRuntimeToClose.close().catch(() => undefined);
								else await targetSession.close().catch(() => undefined);
								await targetMediaLibrary.dispose().catch(() => undefined);
								throw error;
							}
						};
						let exitCode: number;
						let overflowReplacement: InteractiveSessionOptions | undefined;
						try {
							exitCode = await runInteractive({
								work: agentRuntime,
								presentation: createSessionPresentation(session),
								inputSession: session,
								terminal: interactiveRuntime!.terminal,
								clock: options.runtime.clock,
								scheduler: interactiveRuntime!.scheduler,
								imageSurface,
								keybindings: options.keybindings ?? [],
								diagnostics: options.diagnostics,
								fullScreenOutput: options.fullScreenOutput,
								mcpElicitation: interactiveMcpElicitation,
								modelLabel: `${model.provider}/${model.id}`,
								activitySummaryMode: activitySummaryModeForApi(model.api),
								statusLine: () => interactiveStatusLineSnapshot(agentRuntime, session),
								modelCommand: {
									currentKey: () =>
										`${agentRuntime.state().selection.model.provider}/${agentRuntime.state().selection.model.id}`,
									list: listModelEntries,
									select: async (selected) => {
										const authSnapshot = await options.models.getAuth(selected.runtime, {
											apiKey: selected.providerId === model.provider ? parsed.apiKey : undefined,
											clock: options.runtime.clock,
										});
										if (!authSnapshot) throw new Error(`Model is not authenticated: ${selected.key}`);
										const nextReasoning = effectiveReasoningEffort(
											selected.runtime,
											agentRuntime.state().selection.reasoning,
										);
										await session.record({
											type: "model_selected",
											model: { provider: selected.providerId, id: selected.id },
											reasoning: nextReasoning,
										});
										await agentRuntime.select({
											model: selected.runtime,
											reasoning: nextReasoning,
											authSnapshot,
										});
										return {
											modelLabel: selected.key,
											reasoning: nextReasoning,
											activitySummaryMode: activitySummaryModeForApi(selected.runtime.api),
										};
									},
									authenticate: (providerId) => {
										throw new Error(`Provider requires authentication: ${providerId}; use /auth`);
									},
								},
								effortCommand: createEffortCommand(session, agentRuntime),
								authCommand,
								skillsCommand,
								mcpCommand,
								onRetire: () => activeProcessSessionManager.retireSession(session.descriptor.id),
								reasoning,
								motion: parsed.noAnimations ? "reduced" : (settings.ui?.motion ?? "full"),
								commandRegistry,
								sessionCommand: {
									list: async () =>
										(await sessions.list({ id: workspaceId, path: workspace.root })).map((descriptor) => ({
											id: descriptor.id,
											label: descriptor.id,
											description: new Date(descriptor.createdAt).toISOString(),
										})),
									open: async (sessionId) => {
										const targetSession = await sessions.open({
											workspace: { id: workspaceId, path: workspace.root },
											mode: "interactive",
											resumeId: sessionId,
											persistent: session.descriptor.persistent,
										});
										return createSecondarySessionOptions(targetSession, false);
									},
									create: async () => {
										const draftId = `session-${pathSafeIdentity(
											options.runtime.idGenerator.generate("queue_item"),
										)}` as SessionId;
										const targetSession = new DraftSession({
											descriptor: {
												id: draftId,
												workspace: { id: workspaceId, path: workspace.root },
												createdAt: options.runtime.clock.now(),
												persistent: session.descriptor.persistent,
											},
											materialize: () =>
												sessions.open({
													workspace: { id: workspaceId, path: workspace.root },
													mode: "interactive",
													persistent: session.descriptor.persistent,
													createId: draftId,
												}),
										});
										return createSecondarySessionOptions(targetSession, true);
									},
								},
								onContextOverflowReplacement: (replacement) => {
									overflowReplacement = replacement;
								},
								lifecycle: options.runtime.interactiveLifecycle,
								allocateId: () => options.runtime.idGenerator.generate("queue_item"),
								processRunner: options.processRunner,
								platform: options.runtime.platform,
								environment: options.runtime.environment,
								workspace: workspace.root,
								homePath: options.runtime.homeDirectory,
								onWarning: (message) => options.io.stderr.write(`coda: ${message}\n`),
								toolResultImagesSupported: resolveModelRuntimeCapabilities(model, options.modelCapabilities)
									.toolResultImages,
								initialPrompt: hasAgentInput(initialInput) ? initialInput : undefined,
								initialAttachmentIds,
								initialAttachments,
								restoredAttachments: restoredMedia.attachments,
								resolveExtensionReferences: async (references) => {
									const snapshot = await skillsManager.refresh({ rescan: false });
									assertSkillReferencesAvailable(snapshot, references);
								},
								buildPrompt: async (text, attachmentIds, inputContext) => {
									const selectedModel = agentRuntime.state().selection.model;
									if (attachmentIds.length > 0 && !selectedModel.input.includes("image")) {
										throw new Error(
											`Model does not support image input: ${selectedModel.provider}/${selectedModel.id}`,
										);
									}
									const skillReferences = inputContext.references.filter(({ source }) => source === "skill");
									if (skillReferences.length === 0) {
										return promptInput(text, attachmentIds, mediaLibrary, restoredMedia.contents);
									}
									const snapshot = skillsManager.current ?? skillsSnapshot;
									assertSkillReferencesAvailable(snapshot, inputContext.references);
									const taskText = sharedSkillArguments(inputContext.composerText, skillReferences) ?? "";
									const input = await promptInput(
										taskText,
										attachmentIds,
										mediaLibrary,
										restoredMedia.contents,
									);
									const activations = await activateExplicitSkillReferences({
										snapshot,
										references: skillReferences,
										composerText: inputContext.composerText,
									});
									const prepared = prependSkillContext(
										input,
										renderExplicitSkillContext(activations),
										renderExplicitSkillReferences(activations),
									);
									return prepared;
								},
								prepareAttachments,
								onDetach: (attachmentId) =>
									restoredMedia.contents.has(attachmentId)
										? Promise.resolve()
										: mediaLibrary.detach(attachmentId),
								onOpenAttachment: (attachmentId) => {
									const restoredPath = restoredMedia.paths.get(attachmentId);
									return restoredPath
										? openPathInSystemViewer(
												restoredPath,
												options.processRunner,
												options.runtime,
												workspace.root,
											)
										: openAttachmentInSystemViewer(
												mediaLibrary,
												attachmentId,
												options.processRunner,
												options.runtime,
												workspace.root,
											);
								},
							});
						} finally {
							await Promise.all(
								[...secondaryResources.values()].map(async (resource) => {
									const failures: unknown[] = [];
									resource.runControl?.dispose();
									try {
										await drainWorkspaceDiffSupplements(resource.session);
									} catch (error) {
										failures.push(error);
									}
									try {
										await resource.work.close();
									} catch (error) {
										failures.push(error);
									}
									try {
										await drainWorkspaceDiffSupplements(resource.session);
									} catch (error) {
										failures.push(error);
									}
									try {
										await resource.mediaLibrary.dispose();
									} catch (error) {
										failures.push(error);
									}
									if (failures.length === 1) throw failures[0];
									if (failures.length > 1) {
										throw new AggregateError(failures, "Could not close an interactive Session runtime");
									}
								}),
							);
						}
						const finalWork = overflowReplacement?.work ?? agentRuntime;
						const finalAgent = finalWork.state();
						const finalPresentation = overflowReplacement?.presentation ?? createSessionPresentation(session);
						const interactiveMessages = finalAgent.messages.slice(overflowReplacement ? 0 : initialMessageCount);
						const finalAssistant = [...interactiveMessages]
							.reverse()
							.find(
								({ message }) => message.role === "assistant" && finalText(message).trim().length > 0,
							)?.message;
						if (finalAssistant?.role === "assistant") {
							await options.io.stdout.write(`${finalText(finalAssistant)}\n`);
						}
						if (finalPresentation.descriptor.persistent && finalPresentation.descriptor.path) {
							await options.io.stdout.write(
								`Session ${finalPresentation.descriptor.id} • resume with: coda --resume ${finalPresentation.descriptor.id}\n`,
							);
						}
						if (finalAgent.lastRun && finalAgent.lastRun.outcome !== "success") {
							await options.io.stderr.write(
								`coda: ${finalAgent.lastRun.failure?.message ?? `Run ended with outcome ${finalAgent.lastRun.outcome}`}\n`,
							);
						}
						return exitCode;
					}
					if (jsonEventWriter) {
						agentRuntime.subscribe({
							accept: async (event) => {
								const runControl =
									event.type === "run_start" || event.type === "run_end"
										? runControlBinding?.reportForRun(String(event.runId))
										: undefined;
								await jsonEventWriter.writeAgentEvent(
									event,
									event.type === "run_start"
										? (() => {
												const prepared = agentRuntime.metadataForRun(String(event.runId));
												if (!prepared) throw new Error(`Prepared Run ${event.runId} is unavailable`);
												return prepared;
											})()
										: undefined,
									runControlBinding ? { schemaVersion: 3, ...(runControl ? { runControl } : {}) } : undefined,
								);
							},
							resynchronize: ({ reason, state, seed, toolInvocations }) =>
								jsonEventWriter.writeRecord({
									schemaVersion: 2,
									type: "resync_required",
									reason,
									status: state.status,
									sessionId: agentRuntime.sessionId,
									seed,
									toolInvocations,
								}),
						});
						agentRuntime.subscribeResult(async (result) => {
							const runId = result.run?.runId;
							if (!runId) return;
							await drainWorkspaceDiffSupplements(session);
							const evidence = session.runEvidence.at(-1);
							if (!evidence || evidence.runId !== runId) {
								throw new Error(`Run evidence was unavailable after completed Run ${runId}`);
							}
							const runControl = runControlBinding?.reportForRun(runId);
							const outputEvidence = runControl ? withRunControlEvidence(evidence, runControl) : evidence;
							await jsonEventWriter.writeRecord(outputEvidence);
							const disposition = completionController?.get(runId);
							if (!disposition) {
								throw new Error(`Completion disposition was unavailable after completed Run ${runId}`);
							}
							await jsonEventWriter.writeRecord(disposition);
						});
					}
					const initialMedia = await prepareAttachments(initialAttachmentIds);
					let initialMediaCommitted = false;
					const detachInitialMediaCommit = agentRuntime.subscribe({
						accept: async (event) => {
							if (event.type !== "run_start" || event.source !== "prompt" || initialMediaCommitted) return;
							await initialMedia.commit();
							initialMediaCommitted = true;
						},
						resynchronize: async ({ state }) => {
							if (!initialMediaCommitted && state.activeRun?.source === "prompt") {
								await initialMedia.commit();
								initialMediaCommitted = true;
							}
						},
					});
					let result: Awaited<ReturnType<SessionWorkController["prompt"]>>;
					try {
						result = await agentRuntime.prompt(initialInput, initialAttachmentIds);
					} finally {
						detachInitialMediaCommit();
						if (!initialMediaCommitted) await initialMedia.rollback();
					}
					if (result.state !== "succeeded" || result.run?.outcome !== "success") {
						const detail =
							result.run?.failure?.message ??
							result.diagnostics.at(-1)?.message ??
							`Work ended in state ${result.state}`;
						await options.io.stderr.write(`coda: ${detail}\n`);
						return 1;
					}
					const committed = [...agentRuntime.state().messages]
						.reverse()
						.find(({ message }) => message.role === "assistant")?.message;
					if (!committed || committed.role !== "assistant") throw new Error("Final Assistant Message is missing");
					if (parsed.output === "text") await options.io.stdout.write(`${finalText(committed)}\n`);
					const disposition = result.run ? completionController?.get(result.run.runId) : undefined;
					if (!disposition)
						throw new Error(`Completion disposition was unavailable after completed Run ${result.run?.runId}`);
					if (disposition.disposition !== "verified") {
						if (parsed.output === "text") {
							await options.io.stderr.write(
								`coda: completion ${disposition.disposition} (${disposition.reasons.join(", ")})\n`,
							);
						}
						return 1;
					}
					return 0;
				} finally {
					runControlBinding?.dispose();
					skillUiClosed = true;
					skillWatcher?.dispose();
					skillRegistryBinding?.dispose();
					await closeRuntimeResources();
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

function terminalImageIdAllocator(idGenerator: IdGenerator): () => number {
	const allocated = new Set<number>();
	return () => {
		for (let attempt = 0; attempt < 100; attempt++) {
			const identity = idGenerator.generate("queue_item");
			const id = createHash("sha256").update(identity).digest().readUInt32BE(0);
			if (id === 0 || allocated.has(id)) continue;
			allocated.add(id);
			return id;
		}
		throw new Error("Could not allocate a unique terminal image ID");
	};
}
