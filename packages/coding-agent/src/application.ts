import { isAbsolute, join, relative, sep } from "node:path";
import type { Clock, IdGenerator } from "@coda/agent";
import type { MutableModels } from "@coda/ai";
import type { McpConnector, McpElicitationResult } from "@coda/mcp";
import { createCommandPermissionPolicy } from "@coda/permission";
import type { OpenCodingAgentOptions } from "@coda/runtime";
import {
	createAnthropicSandboxEngine,
	openProcessConfinement,
	type ProcessConfinement,
	processConfinementActive,
	type SandboxMode,
} from "@coda/sandbox";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal, TerminalColorScheme } from "@coda/tui";
import {
	absoluteTmpdir,
	commandPermissionOptionsFor,
	createLiveWrapScript,
	createPermissionsCommand,
	replaceProcessConfinement,
	resolveApprovalPolicy,
	resolveSandboxMode,
} from "./app/approval-sandbox.ts";
import { HELP, parseArguments, runControlConfiguration } from "./app/argument-parsing.ts";
import { runInteractiveApplication } from "./app/interactive-run.ts";
import { createAttachmentPreparer } from "./app/interactive-session-options.ts";
import { createApplicationPluginServices } from "./app/plugin-management.ts";
import { prepareUserPrompt } from "./app/prepare-user-prompt.ts";
import { runPrint } from "./app/print-run.ts";
import {
	authenticateInitialModel,
	createApplicationPromptRuntime,
	createApplicationSettingsState,
	loadProjectSkills,
	openProjectServices,
	type ProjectPluginSource,
	selectInitialModel,
} from "./app/project-runtime.ts";
import { createSessionSkillMcpDependencyPreparation } from "./app/skill-mcp-dependencies.ts";
import {
	mcpTrustDecision,
	projectTrustDecision,
	validateSkillPath,
	workspaceMcpReviewText,
	workspacePluginMcpReviewText,
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
import type { CompletionWorkspaceEvidenceProvider } from "./completion/types.ts";
import { hookReviewText, inspectHookConfiguration, trustAllHooks } from "./hooks/config.ts";
import { CommandLifecycleHookHost } from "./hooks/manager.ts";
import { type CommandPermissionAsk, PermissionLifecycleHookHost } from "./hooks/permission-host.ts";
import type { ApplicationIO } from "./host/application-io.ts";
import { type FileStatus, type FileSystem, isFileSystemError } from "./host/file-system.ts";
import type { ProcessRunner, ProcessSessionRunner } from "./host/process-runner.ts";
import { inspectMcpConfiguration } from "./mcp/config.ts";
import type { McpAgentElicitation } from "./mcp/run-capability.ts";
import type { ModelCapabilityResolver } from "./models/model-capabilities.ts";
import { ProviderManager } from "./models/provider-manager.ts";
import { createCodingPluginsManager, materializeCodingPluginMcpDefinitions } from "./plugins/inventory.ts";
import type { CodingPluginMcpDiagnostic, CodingPluginsSnapshot } from "./plugins/types.ts";
import { createWorkspaceWorkCoordinator } from "./runtime/workspace-work-coordinator.ts";
import { InMemorySessionManager } from "./session/memory-session-manager.ts";
import { summarizeSessionRecords } from "./session/session-summary.ts";
import type { SessionManager } from "./session/types.ts";
import { loadProjectInstructions } from "./settings/project-context.ts";
import type { SettingsStore, UserSettings } from "./settings/types.ts";
import type { SkillWatcherFactory } from "./skills/watcher.ts";
import {
	createWebRuntime,
	unavailableWebRuntime,
	type WebHostnameResolver,
	type WebPinnedFetch,
} from "./tools/web/runtime.ts";
import { InteractiveCommandPermissionHandler } from "./ui/command-permission.ts";
import { FullScreenOutputGate } from "./ui/full-screen-output.ts";
import { InteractiveMcpElicitationHandler } from "./ui/mcp-elicitation.ts";
import { type InteractiveProcessLifecycle, InteractiveTerminationError } from "./ui/process-lifecycle.ts";
import { confirmFromTerminal, selectFromTerminal } from "./ui/prompts.ts";
import { InteractiveSkillMcpDependencyHandler } from "./ui/skill-mcp-dependency.ts";

export type { ApplicationIO, ApplicationOutput } from "./host/application-io.ts";
export type { SettingsStore, UserSettings } from "./settings/types.ts";

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
	readonly fetch?: typeof globalThis.fetch;
	/** Must accompany fetch and resolveHostname; incomplete Web transports fail closed. */
	readonly pinnedFetch?: WebPinnedFetch;
	readonly resolveHostname?: WebHostnameResolver;
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
	readonly wrapScript?: (
		request: Parameters<ProcessConfinement["wrapScript"]>[0],
	) => Promise<Awaited<ReturnType<ProcessConfinement["wrapScript"]>> | undefined>;
	readonly modelCapabilities?: ModelCapabilityResolver;
	readonly skillWatcher?: SkillWatcherFactory;
	readonly mcpConnector?: McpConnector;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly commandPermissionAsk?: CommandPermissionAsk;
	readonly processConfinement?: ProcessConfinement;
	/** Shared with host-owned interrupted Tool recovery so it observes the current Run authority. */
	readonly sandboxModeState?: { current: SandboxMode };
	/** Private deterministic seam for completion-gate integration tests. */
	readonly completionWorkspaceEvidence?: CompletionWorkspaceEvidenceProvider;
}

export interface CodingAgentApplication {
	run(args: readonly string[]): Promise<number>;
}

interface PluginDataDirectoryLease {
	readonly path: string;
	readonly device?: string;
	readonly inode?: string;
	readonly requireOwnerWriteExecute?: true;
}

const OWNER_WRITE_EXECUTE = 0o300;

function pluginDataPathIsContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function pluginDataIdentityMatches(lease: PluginDataDirectoryLease, status: FileStatus): boolean {
	return (
		lease.device === undefined ||
		lease.inode === undefined ||
		status.device === undefined ||
		status.inode === undefined ||
		(lease.device === status.device && lease.inode === status.inode)
	);
}

async function assertPluginDataDirectoryLease(
	fileSystem: FileSystem,
	lease: PluginDataDirectoryLease,
	label: string,
): Promise<void> {
	const status = await fileSystem.lstat(lease.path);
	if (
		status.kind !== "directory" ||
		!pluginDataIdentityMatches(lease, status) ||
		(lease.requireOwnerWriteExecute && (status.mode & OWNER_WRITE_EXECUTE) !== OWNER_WRITE_EXECUTE)
	) {
		throw new Error(`${label} changed after it was validated`);
	}
	if (relative(lease.path, await fileSystem.realpath(lease.path)) !== "") {
		throw new Error(`${label} changed after it was validated`);
	}
}

async function ensurePluginDataChild(
	fileSystem: FileSystem,
	parent: PluginDataDirectoryLease,
	name: string,
	label: string,
): Promise<PluginDataDirectoryLease> {
	await assertPluginDataDirectoryLease(fileSystem, parent, "Plugin data parent");
	const path = join(parent.path, name);
	let status: FileStatus;
	try {
		status = await fileSystem.lstat(path);
	} catch (error) {
		if (!isFileSystemError(error, "ENOENT")) throw error;
		try {
			await fileSystem.makeDirectory(path, { mode: 0o700 });
		} catch (mkdirError) {
			if (!isFileSystemError(mkdirError, "EEXIST")) throw mkdirError;
		}
		status = await fileSystem.lstat(path);
	}
	if (status.kind !== "directory") throw new Error(`${label} must be a real directory`);
	const canonical = await fileSystem.realpath(path);
	if (relative(path, canonical) !== "" || !pluginDataPathIsContained(parent.path, canonical)) {
		throw new Error(`${label} resolves outside its client-owned parent`);
	}
	const canonicalStatus = await fileSystem.lstat(canonical);
	if ((canonicalStatus.mode & OWNER_WRITE_EXECUTE) !== OWNER_WRITE_EXECUTE) {
		throw new Error(`${label} must be owner-writable and owner-searchable`);
	}
	const lease = Object.freeze({
		path: canonical,
		requireOwnerWriteExecute: true as const,
		...(canonicalStatus.device === undefined ? {} : { device: canonicalStatus.device }),
		...(canonicalStatus.inode === undefined ? {} : { inode: canonicalStatus.inode }),
	});
	if (canonicalStatus.kind !== "directory" || !pluginDataIdentityMatches(lease, status)) {
		throw new Error(`${label} changed while it was validated`);
	}
	await assertPluginDataDirectoryLease(fileSystem, lease, label);
	return lease;
}

async function preparePluginDataRoot(fileSystem: FileSystem, homeDirectory: string): Promise<PluginDataDirectoryLease> {
	const canonicalHome = await fileSystem.realpath(homeDirectory);
	const homeStatus = await fileSystem.lstat(canonicalHome);
	if (homeStatus.kind !== "directory") throw new Error("Home directory must be a real directory");
	const home = Object.freeze({
		path: canonicalHome,
		...(homeStatus.device === undefined ? {} : { device: homeStatus.device }),
		...(homeStatus.inode === undefined ? {} : { inode: homeStatus.inode }),
	});
	const codaData = await ensurePluginDataChild(fileSystem, home, ".coda", "Coda data directory");
	return ensurePluginDataChild(fileSystem, codaData, "plugin-data", "Plugin dataRoot");
}

async function preparePluginDataDirectory(
	fileSystem: FileSystem,
	configuredDataRoot: string,
	dataRoot: PluginDataDirectoryLease,
	requestedDataDirectory: string,
): Promise<PluginDataDirectoryLease> {
	if (!isAbsolute(requestedDataDirectory)) {
		throw new Error("Plugin dataDirectory must be absolute");
	}
	const childName = relative(configuredDataRoot, requestedDataDirectory);
	if (
		childName === "" ||
		childName === ".." ||
		childName.startsWith(`..${sep}`) ||
		isAbsolute(childName) ||
		childName.includes(sep)
	) {
		throw new Error("Plugin dataDirectory must be a direct child of the client Plugin dataRoot");
	}
	return ensurePluginDataChild(fileSystem, dataRoot, childName, "Plugin dataDirectory");
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
	const activeSandboxModeState = providedOptions.sandboxModeState ?? { current: "danger-full-access" as const };
	const web =
		providedOptions.fetch && providedOptions.pinnedFetch && providedOptions.resolveHostname
			? createWebRuntime({
					fetch: providedOptions.fetch,
					pinnedFetch: providedOptions.pinnedFetch,
					settings: options.settings,
					environment: options.runtime.environment,
					diagnostics: options.diagnostics,
					clock: options.runtime.clock,
					resolveHostname: providedOptions.resolveHostname,
					sandboxMode: () => activeSandboxModeState.current,
				})
			: unavailableWebRuntime;
	const pluginServices = createApplicationPluginServices({
		homeDirectory: options.runtime.homeDirectory,
		cwd: options.runtime.cwd,
		environment: options.runtime.environment,
		fileSystem: options.fileSystem,
		processRunner: options.processRunner,
		idGenerator: options.runtime.idGenerator,
		settings: options.settings,
	});
	let providersRestored = false;
	let precedingRun: Promise<void> = Promise.resolve();
	return {
		run: async (args) => {
			const previousRun = precedingRun;
			let releaseRun!: () => void;
			precedingRun = new Promise<void>((resolve) => {
				releaseRun = resolve;
			});
			await previousRun;
			try {
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
					if (parsed.action === "plugin") {
						if (parsed.workspace === undefined) return await pluginServices.dispatch(parsed.plugin!, options.io);
						const { workspace } = await resolveWorkspaceContext(parsed.workspace, options);
						const deactivate = pluginServices.activateProjectRefresh(
							async () => undefined,
							undefined,
							workspace.root,
						);
						try {
							return await pluginServices.dispatch(parsed.plugin!, options.io);
						} finally {
							deactivate();
						}
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
					activeSandboxModeState.current = resolveSandboxMode({
						cli: parsed.sandboxMode,
						noSandbox: parsed.noSandbox,
						bypassApprovalsAndSandbox: parsed.bypassApprovalsAndSandbox,
						settings: settings.sandbox,
					});
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
					let deactivateProjectPluginRefresh: (() => void) | undefined;
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
								const trustRecord = projectTrust.trustRecord;
								const committed = await updateSettingsTransaction(
									options.settings,
									(current) =>
										projectTrustDecision({
											workspace: workspace.root,
											instructions: projectInstructions,
											settings: current,
											authorized: true,
										}).updatedSettings ?? current,
								);
								settings = committed.settings;
								if (committed.changed) {
									await session.record({ type: "project_trust_changed", trust: trustRecord });
								}
							}
						}
						const managedInstallationSnapshot = await pluginServices.installations();
						const managedInstallations = managedInstallationSnapshot.installations;
						const pluginDiscoveryOptions = {
							workspace: workspace.root,
							userHome: options.runtime.homeDirectory,
							dataRoot: join(options.runtime.homeDirectory, ".coda", "plugin-data"),
							fileSystem: options.fileSystem,
							managedInstallations,
							managedInstallationVerifications: managedInstallationSnapshot.verifications,
							verifyManagedInstallation: (
								record: (typeof managedInstallations)[number],
								verifyOptions?: { readonly signal?: AbortSignal },
							) => pluginServices.installationStore.verify(record, verifyOptions),
							...(settings.plugins ? { enablement: settings.plugins } : {}),
						};
						const codingPluginsManager = createCodingPluginsManager(pluginDiscoveryOptions);
						let codingPlugins: CodingPluginsSnapshot = await codingPluginsManager.refresh();
						const emptyPluginMcpDiagnostics: readonly CodingPluginMcpDiagnostic[] = Object.freeze([]);
						const pluginMcpDiagnosticsByInventory = new WeakMap<
							CodingPluginsSnapshot,
							readonly CodingPluginMcpDiagnostic[]
						>();
						const reportPluginDiagnostics = async (
							diagnostics: CodingPluginsSnapshot["diagnostics"] | readonly CodingPluginMcpDiagnostic[],
						): Promise<void> => {
							for (const diagnostic of diagnostics) {
								const path = "path" in diagnostic ? diagnostic.path : undefined;
								await maintenanceDiagnostics({
									code: `plugins.${diagnostic.code}`,
									message: `${diagnostic.message}${path ? ` (${path})` : ""}`,
								});
							}
						};
						await reportPluginDiagnostics(codingPlugins.diagnostics);
						const pluginSource: ProjectPluginSource = Object.freeze({
							get watchRoots() {
								const canonicalLinkedRoots = codingPlugins.installations
									.filter(({ origin }) => origin.root !== origin.pluginRoot)
									.map(({ origin }) => origin.pluginRoot)
									.sort();
								return Object.freeze([
									...new Set([
										join(workspace.root, ".agents", "plugins"),
										join(options.runtime.homeDirectory, ".agents", "plugins"),
										join(options.runtime.homeDirectory, ".coda", "plugins", "installations"),
										...canonicalLinkedRoots,
									]),
								]);
							},
							inventory: () => codingPlugins,
							skillSnapshots: () => codingPlugins.skills,
							refresh: async (refreshedSettings: UserSettings) => {
								const refreshedInstallationSnapshot = await pluginServices.installations();
								const refreshed = await codingPluginsManager.refresh({
									enablement: refreshedSettings.plugins ?? {},
									managedInstallations: refreshedInstallationSnapshot.installations,
									managedInstallationVerifications: refreshedInstallationSnapshot.verifications,
								});
								codingPlugins = refreshed;
								await reportPluginDiagnostics(refreshed.diagnostics);
								return refreshed;
							},
							retainRunRevisions: (inventory: CodingPluginsSnapshot, signal?: AbortSignal) =>
								pluginServices.installationStore.retainRevisions(
									inventory.installations
										.filter(({ source }) => source !== "workspace-local" && source !== "user-local")
										.map(({ origin }) => origin.root),
									{ signal },
								),
							collectRetiredRevisions: (signal?: AbortSignal) =>
								pluginServices.installationStore.collectRetiredRevisions({ signal }),
							mcpDefinitions: async ({
								settings: pluginSettings,
								reservedServerIds,
							}: Parameters<ProjectPluginSource["mcpDefinitions"]>[0]) => {
								const inventory = codingPlugins;
								const configuredPluginDataRoot = join(options.runtime.homeDirectory, ".coda", "plugin-data");
								const trustedSources = inventory.mcpSources.filter(
									(source) =>
										source.servers.length > 0 &&
										(!source.requiresWorkspaceTrust ||
											(pluginSettings.workspaceMcpTrust ?? []).some(
												(record) =>
													record.workspace === workspace.root &&
													record.path === source.path &&
													record.sha256 === source.sha256,
											)),
								);
								let pluginDataRoot: PluginDataDirectoryLease | undefined;
								if (trustedSources.some((source) => source.servers.some(({ type }) => type === "stdio"))) {
									try {
										pluginDataRoot = await preparePluginDataRoot(
											options.fileSystem,
											options.runtime.homeDirectory,
										);
									} catch (error) {
										await maintenanceDiagnostics({
											code: "plugins.plugin-data-unavailable",
											message: `Could not prepare client Plugin dataRoot: ${error instanceof Error ? error.message : String(error)}`,
										});
									}
								}
								const preparedSources: typeof trustedSources = [];
								for (const source of trustedSources) {
									let preparedSource = source;
									try {
										if (source.servers.some(({ type }) => type === "stdio")) {
											if (!pluginDataRoot) throw new Error("client Plugin dataRoot is unavailable");
											const dataDirectory = await preparePluginDataDirectory(
												options.fileSystem,
												configuredPluginDataRoot,
												pluginDataRoot,
												source.plugin.dataDirectory,
											);
											preparedSource = Object.freeze({
												...source,
												plugin: Object.freeze({ ...source.plugin, dataDirectory: dataDirectory.path }),
											});
										}
									} catch (error) {
										await maintenanceDiagnostics({
											code: "plugins.plugin-data-unavailable",
											message: `Could not prepare Plugin data for ${source.plugin.snapshot.manifest.name}: ${error instanceof Error ? error.message : String(error)}`,
										});
										preparedSource = Object.freeze({
											...source,
											servers: Object.freeze(source.servers.filter(({ type }) => type !== "stdio")),
										});
									}
									if (preparedSource.servers.length > 0) preparedSources.push(preparedSource);
								}
								const materialized = await materializeCodingPluginMcpDefinitions({
									sources: preparedSources,
									...(pluginDataRoot ? { dataRoot: pluginDataRoot.path } : {}),
									baseEnvironment: options.runtime.environment,
									platform: options.runtime.platform,
									reservedServerIds,
								});
								await reportPluginDiagnostics(materialized.diagnostics);
								pluginMcpDiagnosticsByInventory.set(inventory, materialized.diagnostics);
								return Object.freeze({
									definitions: materialized.definitions,
									agentPluginServerIds: Object.freeze(
										materialized.entries.map(({ definition }) => definition.id),
									),
								});
							},
						});
						const projectSkills = await loadProjectSkills({
							workspace: workspace.root,
							homeDirectory: options.runtime.homeDirectory,
							fileSystem: options.fileSystem,
							plugins: pluginSource,
						});
						let mcpConfiguration = await inspectMcpConfiguration({
							workspace: workspace.root,
							fileSystem: options.fileSystem,
							userServers: settings.mcpServers ?? [],
							workspaceTrust: settings.workspaceMcpTrust ?? [],
							environment: options.runtime.environment,
						});
						if (mcpConfiguration.workspace?.trust === "untrusted") {
							const workspaceMcp = mcpConfiguration.workspace;
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
								const trustRecord = mcpTrust.trustRecord;
								const committed = await updateSettingsTransaction(
									options.settings,
									(current) =>
										mcpTrustDecision({
											workspace: workspace.root,
											snapshot: workspaceMcp,
											settings: current,
											authorized: true,
										}).updatedSettings ?? current,
								);
								settings = committed.settings;
								if (committed.changed) {
									await session.record({ type: "mcp_trust_changed", trust: trustRecord });
								}
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
						for (const source of codingPlugins.mcpSources.filter(
							(source) => source.requiresWorkspaceTrust && source.servers.length > 0,
						)) {
							const alreadyTrusted = (settings.workspaceMcpTrust ?? []).some(
								(record) =>
									record.workspace === workspace.root &&
									record.path === source.path &&
									record.sha256 === source.sha256,
							);
							if (alreadyTrusted) continue;
							const trustedInteractively =
								!parsed.trustProjectMcp && interactiveRuntime
									? await confirmFromTerminal(interactiveRuntime, workspacePluginMcpReviewText(source))
									: false;
							const mcpTrust = mcpTrustDecision({
								workspace: workspace.root,
								snapshot: {
									path: source.path,
									sha256: source.sha256,
									trust: "untrusted",
									serverCount: source.servers.length,
									servers: [],
								},
								settings,
								authorized: parsed.trustProjectMcp || trustedInteractively,
							});
							if (mcpTrust.updatedSettings && mcpTrust.trustRecord) {
								const trustRecord = mcpTrust.trustRecord;
								const committed = await updateSettingsTransaction(
									options.settings,
									(current) =>
										mcpTrustDecision({
											workspace: workspace.root,
											snapshot: {
												path: source.path,
												sha256: source.sha256,
												trust: "untrusted",
												serverCount: source.servers.length,
												servers: [],
											},
											settings: current,
											authorized: true,
										}).updatedSettings ?? current,
								);
								settings = committed.settings;
								if (committed.changed) {
									await session.record({ type: "mcp_trust_changed", trust: trustRecord });
								}
							} else if (!mcpTrust.trusted && !interactiveRuntime) {
								await options.io.stderr.write(
									`coda: Workspace Agent Plugin ${source.plugin.snapshot.manifest.name} MCP configuration ${source.sha256} is untrusted; its Servers were omitted\n`,
								);
							}
						}
						const pluginMcpDefinitions = await pluginSource.mcpDefinitions({
							settings,
							reservedServerIds: mcpConfiguration.definitions.map(({ id }) => id),
						});
						mcpConfiguration = Object.freeze({
							...mcpConfiguration,
							definitions: Object.freeze([...mcpConfiguration.definitions, ...pluginMcpDefinitions.definitions]),
						});
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
								settings = (
									await updateSettingsTransaction(options.settings, (current) =>
										trustAllHooks(current, hookConfiguration),
									)
								).settings;
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
						const approvalPolicy = resolveApprovalPolicy({
							cli: parsed.approvalPolicy,
							noPermission: parsed.noPermission,
							bypassApprovalsAndSandbox: parsed.bypassApprovalsAndSandbox,
							settings: settings.permission,
							interactive: parsed.mode === "interactive",
						});
						const sandboxModeState = activeSandboxModeState;
						const sandboxMode = sandboxModeState.current;
						const tmpdir = absoluteTmpdir(options.runtime.environment);
						const settingsState = createApplicationSettingsState(settings);
						const persistSettings = async (next: typeof settings): Promise<void> => {
							settings = next;
							settingsState.current = next;
							await options.settings.save(next);
						};
						const permissionActive = parsed.mode === "interactive" || parsed.strictPermissions === true;
						const commandHooks = new CommandLifecycleHookHost({
							configuration: hookConfiguration,
							processRunner: options.processRunner,
							shellExecutable: configuredShell?.startsWith("/") ? configuredShell : "/bin/sh",
							platform: options.runtime.platform,
							environment: options.runtime.environment,
							permissionMode: permissionActive ? "default" : "bypassPermissions",
							diagnostic: maintenanceDiagnostics,
						});
						const interactivePermission =
							parsed.mode === "interactive" && !options.commandPermissionAsk
								? new InteractiveCommandPermissionHandler()
								: undefined;
						const permissionPolicy = createCommandPermissionPolicy(
							commandPermissionOptionsFor(
								approvalPolicy,
								sandboxMode,
								workspace.root,
								(settings.permission?.remembered ?? []).filter(
									(record) =>
										record.scope === "user" ||
										(record.scope === "workspace" && record.workspace === workspace.root),
								),
								{ tmpdir, filesystemEnforced: !processConfinementActive(sandboxMode) },
							),
						);
						const lifecycleHooks = new PermissionLifecycleHookHost({
							inner: commandHooks,
							policy: permissionPolicy,
							ask:
								options.commandPermissionAsk ??
								(interactivePermission
									? (request) => interactivePermission.request(request)
									: async () => ({
											action: "deny",
											reason: "Command Permission requires an interactive Session",
										})),
							onRemember: async (record) => {
								if (record.scope !== "user" && record.scope !== "workspace") return;
								const retained = (settings.permission?.remembered ?? []).filter(
									(entry) => entry.key !== record.key || entry.workspace !== record.workspace,
								);
								await persistSettings({
									...settings,
									permission: {
										...settings.permission,
										approvalPolicy: permissionPolicy.snapshot().approvalPolicy,
										remembered: [...retained, record],
									},
								});
							},
						});
						workspaceResources.useLifecycleHooks(lifecycleHooks);
						const confinementHolder: { current?: ProcessConfinement } = {
							current: options.processConfinement,
						};
						const ownsConfinement = options.wrapScript === undefined && options.processConfinement === undefined;
						if (!confinementHolder.current && ownsConfinement && processConfinementActive(sandboxMode)) {
							try {
								confinementHolder.current = await openProcessConfinement({
									platform: options.runtime.platform,
									config: {
										workspace: workspace.root,
										mode: sandboxMode,
										...(settings.sandbox?.allowedDomains
											? { allowedDomains: settings.sandbox.allowedDomains }
											: {}),
										...(settings.sandbox?.deniedDomains
											? { deniedDomains: settings.sandbox.deniedDomains }
											: {}),
										...(tmpdir ? { tmpdir } : {}),
									},
									engine: createAnthropicSandboxEngine(),
								});
							} catch (error) {
								await maintenanceDiagnostics({
									code: "sandbox.unavailable",
									message: error instanceof Error ? error.message : String(error),
								});
							}
						}
						if (confinementHolder.current) workspaceResources.useProcessConfinement(confinementHolder.current);
						permissionPolicy.configure({
							filesystemEnforced:
								!processConfinementActive(sandboxModeState.current) ||
								confinementHolder.current !== undefined ||
								options.wrapScript !== undefined,
						});
						const wrapScript = options.wrapScript ?? createLiveWrapScript(confinementHolder);
						const sessionOptions = {
							...options,
							wrapScript,
							web,
						};
						const permissionBounds = () => ({
							tmpdir,
							filesystemEnforced:
								!processConfinementActive(sandboxModeState.current) ||
								confinementHolder.current !== undefined ||
								options.wrapScript !== undefined,
						});
						const permissionsCommand = createPermissionsCommand({
							policy: permissionPolicy,
							workspace: workspace.root,
							sandboxMode: sandboxModeState,
							bounds: permissionBounds,
							...(ownsConfinement
								? {
										replaceConfinement: async (mode) => {
											try {
												await replaceProcessConfinement({
													holder: confinementHolder,
													mode,
													workspace: workspace.root,
													platform: options.runtime.platform,
													engine: createAnthropicSandboxEngine(),
													resources: workspaceResources,
													...(settings.sandbox?.allowedDomains
														? { allowedDomains: settings.sandbox.allowedDomains }
														: {}),
													...(settings.sandbox?.deniedDomains
														? { deniedDomains: settings.sandbox.deniedDomains }
														: {}),
													...(tmpdir ? { tmpdir } : {}),
												});
											} catch (error) {
												await maintenanceDiagnostics({
													code: "sandbox.unavailable",
													message: error instanceof Error ? error.message : String(error),
												});
											}
										},
									}
								: {}),
						});
						const projectServices = await openProjectServices({
							options,
							settings: settingsState,
							workspace,
							mcpConfiguration,
							agentPluginServerIds: pluginMcpDefinitions.agentPluginServerIds,
							skills: projectSkills,
							interactive: interactiveRuntime !== undefined,
							diagnostics: maintenanceDiagnostics,
							resources: workspaceResources,
							hooks: commandHooks,
						});
						deactivateProjectPluginRefresh = pluginServices.activateProjectRefresh(
							projectServices.refreshProject,
							() => {
								const catalog = projectServices.capabilityCatalogSnapshot();
								return Object.freeze({
									...catalog,
									pluginMcpDiagnostics:
										pluginMcpDiagnosticsByInventory.get(catalog.plugins) ?? emptyPluginMcpDiagnostics,
								});
							},
							workspace.root,
							projectServices.markProjectDirty,
							interactiveRuntime
								? {
										...(parsed.trustProjectMcp ? { review: () => true } : {}),
										onCommitted: (record) => session.record({ type: "mcp_trust_changed", trust: record }),
									}
								: undefined,
						);
						closeProjectUi = projectServices.closeUi;
						const {
							mcpRegistry,
							commandRegistry,
							skillsCommand,
							mcpCommand,
							hooksCommand,
							capabilityCatalogSnapshot,
						} = projectServices;
						const skillsManager = projectSkills.manager;
						const skillsSnapshot = projectSkills.snapshot;
						const interactiveSkillMcpDependencies = interactiveRuntime
							? new InteractiveSkillMcpDependencyHandler({
									fallback: async (request) =>
										(await selectFromTerminal(
											interactiveRuntime,
											`${request.title}\n\n${request.message}`,
											request.choices,
										)) === "install"
											? "install"
											: "continue",
									canUseFallback: () => !fullScreenOutput.active,
								})
							: undefined;
						const createSkillMcpDependencyPreparation = (sessionId: string) =>
							createSessionSkillMcpDependencyPreparation({
								settings: settingsState,
								store: options.settings,
								refreshProject: projectServices.refreshProject,
								configuredServers: projectServices.configuredMcpServers,
								capabilityCatalogSnapshot,
								approvalPolicy: () => permissionPolicy.snapshot().approvalPolicy,
								sandboxMode: () => sandboxModeState.current,
								...(interactiveSkillMcpDependencies
									? { decide: interactiveSkillMcpDependencies.forSession(sessionId) }
									: {}),
								reportDiagnostic: (diagnostic) =>
									maintenanceDiagnostics({ code: diagnostic.code, message: diagnostic.message }),
							});
						const primarySkillMcpDependencyPreparation = createSkillMcpDependencyPreparation(
							session.descriptor.id,
						);
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
							options: sessionOptions,
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
							projectCapabilities: projectServices.acquireRunCapabilityBundle,
							mcpDiagnostic: (diagnostic) =>
								maintenanceDiagnostics({ code: diagnostic.code, message: diagnostic.message }),
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
						const initialCapabilityCatalog = capabilityCatalogSnapshot();
						const initialInput = await prepareUserPrompt({
							text: parsed.prompt,
							attachmentIds: initialAttachmentIds,
							mediaLibrary,
							skills: initialCapabilityCatalog.skills,
							projectRevision: initialCapabilityCatalog.revision,
							mcpTools: initialCapabilityCatalog.mcp.tools,
							prepareSkillMcpDependencies: primarySkillMcpDependencyPreparation,
						});
						const prepareAttachments = createAttachmentPreparer({
							restoredMedia,
							mediaLibrary,
							session,
							inputResources,
						});
						if (parsed.mode === "interactive") {
							if (!interactiveSkillMcpDependencies) {
								throw new Error("Interactive Skill MCP dependency prompts are unavailable");
							}
							return await runInteractiveApplication({
								options: {
									...options,
									wrapScript: sessionOptions.wrapScript,
									...(interactivePermission ? { commandPermission: interactivePermission } : {}),
								},
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
								pluginsCommand: pluginServices.command,
								mcpCommand,
								projectCapabilityCatalog: capabilityCatalogSnapshot,
								primarySkillMcpDependencyPreparation,
								createSkillMcpDependencyPreparation,
								skillMcpDependencies: interactiveSkillMcpDependencies,
								...(mcpRegistry ? { mcpRegistry } : {}),
								hooksCommand,
								permissionsCommand,
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
						deactivateProjectPluginRefresh?.();
						closeProjectUi?.();
						await closeRuntime();
					}
				} catch (error) {
					if (error instanceof InteractiveTerminationError) return error.exitCode;
					const message = error instanceof Error ? error.message : String(error);
					await options.io.stderr.write(`coda: ${message}\n`);
					return 1;
				}
			} finally {
				releaseRun();
			}
		},
	};
}

async function updateSettingsTransaction(
	store: SettingsStore,
	mutator: (settings: UserSettings) => UserSettings,
): Promise<{ readonly settings: UserSettings; readonly changed: boolean }> {
	let changed = false;
	if (store.update) {
		const settings = await store.update((current) => {
			const next = mutator(current);
			changed = next !== current;
			return next;
		});
		return Object.freeze({ settings, changed });
	}
	const current = await store.load();
	const settings = mutator(current);
	changed = settings !== current;
	if (changed) await store.save(settings);
	return Object.freeze({ settings, changed });
}

const unavailableProviderDiscoveryFetch: typeof globalThis.fetch = async () => {
	throw new Error("Custom Provider discovery requires an injected fetch adapter");
};
