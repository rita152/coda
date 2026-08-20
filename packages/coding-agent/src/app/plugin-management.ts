import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { IdGenerator } from "@coda/agent";
import type { McpHostSnapshot } from "@coda/mcp";
import type {
	PluginsCommand,
	PluginsCommandFlowSnapshot,
	PluginWorkspaceMcpTrustReviewer,
} from "../commands/plugins-flow.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { WorkspaceMcpTrustRecord } from "../mcp/config.ts";
import {
	type CodingPluginInstallationStore,
	createCodingPluginInstallationStore,
} from "../plugins/installation-store.ts";
import { createCodingPluginsManager } from "../plugins/inventory.ts";
import {
	CodingPluginAlreadyInstalledError,
	CodingPluginChangeNotificationError,
	type CodingPluginManagement,
	type CodingPluginManagementPlugin,
	type CodingPluginManagementSnapshot,
	createCodingPluginManagement,
} from "../plugins/management.ts";
import { createCodingPluginMarketplaceStore } from "../plugins/marketplace-store.ts";
import type {
	CodingPlugin,
	CodingPluginDiagnostic,
	CodingPluginId,
	CodingPluginMcpDiagnostic,
	CodingPluginMcpSource,
	CodingPluginsSnapshot,
} from "../plugins/types.ts";
import type { SettingsStore, UserSettings } from "../settings/types.ts";
import type { PluginCommandArguments } from "./plugin-arguments.ts";
import { pluginCommandHelp } from "./plugin-arguments.ts";

export type { PluginsCommand } from "../commands/plugins-flow.ts";

export interface ApplicationPluginActiveCatalog {
	readonly plugins: CodingPluginsSnapshot;
	readonly mcp: McpHostSnapshot;
	/** Exact MCP Server ids admitted from Agent Plugins into this published Project catalog. */
	readonly agentPluginServerIds: readonly string[];
	/** MCP failures produced while materializing the same published Agent Plugin inventory. */
	readonly pluginMcpDiagnostics?: readonly CodingPluginMcpDiagnostic[];
}

export interface ApplicationPluginServices {
	readonly installationStore: CodingPluginInstallationStore;
	readonly management: CodingPluginManagement;
	readonly command: PluginsCommand;
	installations(): ReturnType<CodingPluginInstallationStore["listVerified"]>;
	activateProjectRefresh(
		refresh: () => Promise<void>,
		catalog?: () => ApplicationPluginActiveCatalog,
		workspace?: string,
		markDirty?: () => void,
		workspaceMcpTrust?: ApplicationPluginWorkspaceMcpTrust,
	): () => void;
	dispatch(arguments_: PluginCommandArguments, io: Pick<ApplicationIO, "stdout">): Promise<number>;
}

export interface ApplicationPluginWorkspaceMcpTrust {
	/** Explicitly reviews the exact Workspace Plugin MCP package revision. */
	review?(source: CodingPluginMcpSource): boolean | Promise<boolean>;
	/** Records the already-durable trust fact in the current Session. */
	onCommitted?(record: WorkspaceMcpTrustRecord): void | Promise<void>;
}

export function createApplicationPluginServices(input: {
	readonly homeDirectory: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly idGenerator: IdGenerator;
	readonly settings: SettingsStore;
}): ApplicationPluginServices {
	const root = join(input.homeDirectory, ".coda", "plugins");
	const installationRoot = join(root, "installations");
	const environment = definedEnvironment(input.environment);
	const marketplaceStore = createCodingPluginMarketplaceStore({
		root: join(root, "marketplaces"),
		fileSystem: input.fileSystem,
		processRunner: input.processRunner,
		idGenerator: input.idGenerator,
		environment,
	});
	const installationStore = createCodingPluginInstallationStore({
		root: installationRoot,
		fileSystem: input.fileSystem,
		idGenerator: input.idGenerator,
	});
	let activeRefresh: (() => Promise<void>) | undefined;
	let activeCatalog: (() => ApplicationPluginActiveCatalog) | undefined;
	let activeMarkDirty: (() => void) | undefined;
	let activeWorkspaceMcpTrust: ApplicationPluginWorkspaceMcpTrust | undefined;
	const workspaceMcpTrustReview = new AsyncLocalStorage<PluginWorkspaceMcpTrustReviewer>();
	let activeWorkspace = input.cwd;
	let prepareActiveWorkspaceMcpTrust: () => Promise<void> = async () => undefined;
	const notifyActiveProject = async (): Promise<void> => {
		const failures: unknown[] = [];
		try {
			await prepareActiveWorkspaceMcpTrust();
		} catch (error) {
			failures.push(error);
		}
		try {
			activeMarkDirty?.();
		} catch (error) {
			failures.push(error);
		}
		try {
			await activeRefresh?.();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Plugin runtime notification failed");
	};
	const management = createCodingPluginManagement({
		marketplaceStore,
		installationStore,
		fileSystem: input.fileSystem,
		processRunner: input.processRunner,
		idGenerator: input.idGenerator,
		stagingRoot: join(root, "staging"),
		environment,
		marketplaceBaseDirectory: input.cwd,
		loadSettings: () => input.settings.load(),
		...(input.settings.update
			? { updateSettings: (mutator: (settings: UserSettings) => UserSettings) => input.settings.update!(mutator) }
			: {}),
		saveSettings: (settings) => input.settings.save(settings),
		onChanged: notifyActiveProject,
	});
	const createInventoryManager = (workspace: string) =>
		createCodingPluginsManager({
			workspace,
			userHome: input.homeDirectory,
			dataRoot: join(input.homeDirectory, ".coda", "plugin-data"),
			fileSystem: input.fileSystem,
			verifyManagedInstallation: (record, options) => installationStore.verify(record, options),
		});
	let inventoryWorkspace = input.cwd;
	let inventoryManager = createInventoryManager(inventoryWorkspace);
	const bindInventoryWorkspace = (workspace: string): void => {
		activeWorkspace = workspace;
		if (inventoryWorkspace === workspace) return;
		inventoryWorkspace = workspace;
		inventoryManager = createInventoryManager(workspace);
	};
	prepareActiveWorkspaceMcpTrust = async (): Promise<void> => {
		const trust = activeWorkspaceMcpTrust;
		const contextualReview = workspaceMcpTrustReview.getStore();
		if (!contextualReview && !trust?.review) return;
		let settings = await input.settings.load();
		const managedInstallations = await installations();
		const inventory = await inventoryManager.refresh({
			enablement: settings.plugins ?? {},
			managedInstallations: managedInstallations.installations,
			managedInstallationVerifications: managedInstallations.verifications,
		});
		for (const source of inventory.mcpSources) {
			if (!source.requiresWorkspaceTrust || source.servers.length === 0) continue;
			if (workspaceMcpSourceTrusted(settings, activeWorkspace, source)) continue;
			const reviewed = trust?.review
				? await trust.review(source)
				: await contextualReview!({
						workspace: activeWorkspace,
						pluginId: source.plugin.installationId,
						path: source.path,
						sha256: source.sha256,
					});
			if (!reviewed) continue;
			const record: WorkspaceMcpTrustRecord = Object.freeze({
				workspace: activeWorkspace,
				path: source.path,
				sha256: source.sha256,
			});
			let committed = false;
			if (input.settings.update) {
				settings = await input.settings.update((current) => {
					if (workspaceMcpSourceTrusted(current, activeWorkspace, source)) return current;
					committed = true;
					return withWorkspaceMcpTrust(current, record);
				});
			} else {
				const current = await input.settings.load();
				if (workspaceMcpSourceTrusted(current, activeWorkspace, source)) {
					settings = current;
				} else {
					settings = withWorkspaceMcpTrust(current, record);
					await input.settings.save(settings);
					committed = true;
				}
			}
			if (committed) await trust?.onCommitted?.(record);
		}
	};
	const installations = async (): ReturnType<CodingPluginInstallationStore["listVerified"]> => {
		try {
			await input.fileSystem.lstat(installationRoot);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) {
				return Object.freeze({
					version: 1 as const,
					installations: Object.freeze([]),
					verifications: Object.freeze([]),
				});
			}
			throw error;
		}
		return installationStore.listVerified();
	};
	const effectiveSnapshot = async (
		managedSnapshot?: CodingPluginManagementSnapshot,
	): Promise<CodingPluginManagementSnapshot> => {
		const selectedManagedSnapshot = managedSnapshot ?? (await management.snapshot());
		const [settings, managedInstallations] = await Promise.all([input.settings.load(), installations()]);
		const active = activeCatalog?.();
		const inventory =
			active?.plugins ??
			(await inventoryManager.refresh({
				enablement: settings.plugins ?? {},
				managedInstallations: managedInstallations.installations,
				managedInstallationVerifications: managedInstallations.verifications,
			}));
		return mergeEffectivePluginInventory(selectedManagedSnapshot, inventory, settings, activeWorkspace, active);
	};
	const throwCommittedAdapterFailure = async (
		failure: unknown,
		fallback: CodingPluginManagementSnapshot,
		pluginId: CodingPluginId,
		options: {
			readonly code: "plugin_change_notification_failed" | "plugin_post_commit_failed";
			readonly message: string;
			readonly managedSnapshot?: CodingPluginManagementSnapshot;
		},
	): Promise<never> => {
		const failures = [failure];
		let snapshot = boundedCommittedApplicationFallback(fallback, pluginId);
		try {
			await notifyActiveProject();
		} catch (error) {
			failures.push(error);
		}
		try {
			snapshot = await effectiveSnapshot(options.managedSnapshot);
		} catch (error) {
			failures.push(error);
		}
		const cause =
			failures.length === 1
				? failure
				: new AggregateError(failures, "Plugin post-commit application convergence failed");
		throw new CodingPluginChangeNotificationError(snapshot, cause, options);
	};
	const lifecycle = async (
		operation: "add" | "enable" | "disable" | "upgrade" | "remove",
		pluginId: CodingPluginId,
	): Promise<CodingPluginManagementSnapshot> => {
		const before = await effectiveSnapshot();
		const direct = before.plugins.find(
			(plugin) => plugin.pluginId === pluginId && isDirectPluginSource(plugin.marketplace),
		);
		if (direct) {
			if (operation === "enable" || operation === "disable") {
				return setDirectPluginEnablement(pluginId, operation === "enable", before);
			}
			if (operation === "remove") {
				throw new Error("Direct Plugin installations cannot be removed; remove its package directory explicitly");
			}
			if (operation === "upgrade") {
				throw new Error("Direct Plugin installations cannot be upgraded; update its package directory explicitly");
			}
		}
		const changed = await pluginLifecycleOperation(management, operation, pluginId);
		try {
			return await effectiveSnapshot(changed);
		} catch (error) {
			return throwCommittedAdapterFailure(error, changed, pluginId, {
				code: "plugin_post_commit_failed",
				message: "Plugin state committed, but the effective application projection failed",
				managedSnapshot: changed,
			});
		}
	};
	const setDirectPluginEnablement = async (
		pluginId: CodingPluginId,
		enabled: boolean,
		before: CodingPluginManagementSnapshot,
	): Promise<CodingPluginManagementSnapshot> => {
		if (input.settings.update) {
			await input.settings.update((current) => {
				const plugins = { ...(current.plugins ?? {}), [pluginId]: { enabled } };
				return Object.freeze({ ...current, plugins });
			});
		} else {
			const current = await input.settings.load();
			const plugins = { ...(current.plugins ?? {}), [pluginId]: { enabled } };
			await input.settings.save(Object.freeze({ ...current, plugins }));
		}
		const fallback = committedDirectEnablementFallback(before, pluginId, enabled);
		try {
			await notifyActiveProject();
		} catch (error) {
			return throwCommittedAdapterFailure(error, fallback, pluginId, {
				code: "plugin_change_notification_failed",
				message: "Plugin state committed, but the runtime refresh notification failed",
			});
		}
		try {
			return await effectiveSnapshot();
		} catch (error) {
			return throwCommittedAdapterFailure(error, fallback, pluginId, {
				code: "plugin_post_commit_failed",
				message: "Plugin state committed, but the effective application projection failed",
			});
		}
	};
	const project = (snapshot: CodingPluginManagementSnapshot): PluginsCommandFlowSnapshot =>
		projectFlowSnapshot(snapshot);
	const withWorkspaceMcpTrustReview = <T>(
		review: PluginWorkspaceMcpTrustReviewer | undefined,
		operation: () => Promise<T>,
	): Promise<T> => (review ? workspaceMcpTrustReview.run(review, operation) : operation());
	const command: PluginsCommand = Object.freeze({
		snapshot: async () => project(await effectiveSnapshot()),
		install: (pluginId: CodingPluginId, review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await lifecycle("add", pluginId))),
		enable: (pluginId: CodingPluginId, review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await lifecycle("enable", pluginId))),
		disable: (pluginId: CodingPluginId, review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await lifecycle("disable", pluginId))),
		upgrade: (pluginId: CodingPluginId, review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await lifecycle("upgrade", pluginId))),
		remove: (pluginId: CodingPluginId, review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await lifecycle("remove", pluginId))),
		refresh: (review?: PluginWorkspaceMcpTrustReviewer) =>
			withWorkspaceMcpTrustReview(review, async () => project(await effectiveSnapshot(await management.refresh()))),
	});
	return Object.freeze({
		installationStore,
		management,
		command,
		installations,
		activateProjectRefresh: (
			refresh: () => Promise<void>,
			catalog?: () => ApplicationPluginActiveCatalog,
			workspace = input.cwd,
			markDirty?: () => void,
			workspaceMcpTrust?: ApplicationPluginWorkspaceMcpTrust,
		) => {
			activeRefresh = refresh;
			activeCatalog = catalog;
			activeMarkDirty = markDirty;
			activeWorkspaceMcpTrust = workspaceMcpTrust;
			bindInventoryWorkspace(workspace);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (activeRefresh === refresh) {
					activeRefresh = undefined;
					activeCatalog = undefined;
					activeMarkDirty = undefined;
					activeWorkspaceMcpTrust = undefined;
					bindInventoryWorkspace(input.cwd);
				}
			};
		},
		dispatch: (arguments_: PluginCommandArguments, io: Pick<ApplicationIO, "stdout">) =>
			dispatchPluginCommandWithJsonErrors(arguments_, management, effectiveSnapshot, lifecycle, io),
	});
}

function workspaceMcpSourceTrusted(
	settings: UserSettings,
	workspace: string,
	source: Pick<CodingPluginMcpSource, "path" | "sha256">,
): boolean {
	return (settings.workspaceMcpTrust ?? []).some(
		(record) => record.workspace === workspace && record.path === source.path && record.sha256 === source.sha256,
	);
}

function withWorkspaceMcpTrust(settings: UserSettings, record: WorkspaceMcpTrustRecord): UserSettings {
	return Object.freeze({
		...settings,
		workspaceMcpTrust: Object.freeze(
			[
				...(settings.workspaceMcpTrust ?? []).filter(
					(entry) => entry.workspace !== record.workspace || entry.path !== record.path,
				),
				record,
			].sort((left, right) => compareText(left.workspace, right.workspace) || compareText(left.path, right.path)),
		),
	});
}

const MAX_COMMITTED_APPLICATION_PLUGINS = 1_024;
const MAX_COMMITTED_APPLICATION_DIAGNOSTICS = 512;

function committedDirectEnablementFallback(
	before: CodingPluginManagementSnapshot,
	pluginId: CodingPluginId,
	enabled: boolean,
): CodingPluginManagementSnapshot {
	const plugins = before.plugins.map((plugin) =>
		plugin.pluginId === pluginId
			? Object.freeze({
					...plugin,
					state: plugin.invalid ? ("invalid" as const) : enabled ? ("enabled" as const) : ("installed" as const),
					enabled,
				})
			: plugin,
	);
	return committedApplicationSnapshot(before, plugins, pluginId);
}

function boundedCommittedApplicationFallback(
	snapshot: CodingPluginManagementSnapshot,
	pluginId: CodingPluginId,
): CodingPluginManagementSnapshot {
	return committedApplicationSnapshot(snapshot, snapshot.plugins, pluginId);
}

function committedApplicationSnapshot(
	base: CodingPluginManagementSnapshot,
	plugins: readonly CodingPluginManagementPlugin[],
	pluginId: CodingPluginId,
): CodingPluginManagementSnapshot {
	const fallbackDiagnostic = Object.freeze({
		code: "plugin-post-commit-projection-failed",
		severity: "error" as const,
		message: "Plugin state is durable, but its complete application projection is temporarily unavailable",
		pluginId,
		component: "plugin" as const,
	});
	const diagnostics = deduplicateDiagnostics([
		...base.diagnostics.slice(0, Math.max(0, MAX_COMMITTED_APPLICATION_DIAGNOSTICS - 1)),
		fallbackDiagnostic,
	]);
	const projection = {
		version: 1 as const,
		marketplaces: Object.freeze(base.marketplaces.slice(0, MAX_COMMITTED_APPLICATION_PLUGINS)),
		plugins: Object.freeze(boundedApplicationPluginsWithTarget(plugins, pluginId, MAX_COMMITTED_APPLICATION_PLUGINS)),
		diagnostics: Object.freeze(diagnostics),
	};
	return Object.freeze({
		...projection,
		revision: `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
	});
}

function boundedApplicationPluginsWithTarget(
	plugins: readonly CodingPluginManagementPlugin[],
	pluginId: CodingPluginId,
	maximum: number,
): readonly CodingPluginManagementPlugin[] {
	const bounded = plugins.slice(0, maximum);
	const target = plugins.find((plugin) => plugin.pluginId === pluginId);
	if (target && !bounded.some((plugin) => plugin.pluginId === pluginId)) {
		bounded[Math.max(0, maximum - 1)] = target;
		bounded.sort((left, right) => compareText(left.pluginId, right.pluginId));
	}
	return bounded;
}

function mergeEffectivePluginInventory(
	managed: CodingPluginManagementSnapshot,
	inventory: CodingPluginsSnapshot,
	settings: UserSettings,
	workspace: string,
	active?: ApplicationPluginActiveCatalog,
): CodingPluginManagementSnapshot {
	const plugins = new Map(managed.plugins.map((plugin) => [plugin.pluginId, plugin] as const));
	for (const installation of inventory.installations) {
		if (!isDirectPluginSource(installation.source)) continue;
		plugins.set(installation.installationId, directPluginProjection(installation, settings, workspace));
	}
	for (const snapshot of inventory.snapshots) {
		if (snapshot.status !== "rejected") continue;
		const pluginId = directPluginIdForOrigin(snapshot.origin);
		if (!pluginId || plugins.has(pluginId)) continue;
		plugins.set(pluginId, rejectedDirectPluginProjection(snapshot, pluginId, settings));
	}
	const projectedPlugins = [...plugins.values()]
		.map((plugin) => withActivePluginState(plugin, active))
		.sort((left, right) => compareText(left.pluginId, right.pluginId));
	const diagnostics = deduplicateDiagnostics([
		...managed.diagnostics,
		...inventory.diagnostics.map(inventoryDiagnosticProjection),
		...activePluginMaterializationDiagnostics(active),
		...activePluginMcpDiagnostics(active),
	]).slice(0, 512);
	const projection = {
		version: 1 as const,
		marketplaces: managed.marketplaces,
		plugins: Object.freeze(projectedPlugins),
		diagnostics: Object.freeze(diagnostics),
	};
	return Object.freeze({
		...projection,
		revision: `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
	});
}

function rejectedDirectPluginProjection(
	snapshot: Extract<CodingPluginsSnapshot["snapshots"][number], { readonly status: "rejected" }>,
	pluginId: CodingPluginId,
	settings: UserSettings,
): CodingPluginManagementPlugin {
	const marketplace = snapshot.origin.scope === "workspace" ? "workspace-local" : "user-local";
	const enabled = settings.plugins?.[pluginId]?.enabled ?? true;
	const selectedRevision = createHash("sha256")
		.update(
			JSON.stringify({
				requestedRoot: snapshot.requestedRoot,
				diagnostics: snapshot.diagnostics.map(({ code, message }) => [code, message]),
			}),
		)
		.digest("hex");
	return Object.freeze({
		pluginId,
		name: snapshot.origin.slot,
		namespace: snapshot.origin.slot,
		marketplace,
		scope: snapshot.origin.scope,
		displayName: snapshot.origin.slot,
		state: "invalid",
		available: false,
		installed: true,
		enabled,
		updateAvailable: false,
		invalid: true,
		selectedRevision,
		selectedRoot: snapshot.requestedRoot,
		source: Object.freeze({
			source: "local" as const,
			path: snapshot.requestedRoot,
			root: snapshot.requestedRoot,
		}),
		contributions: Object.freeze({ skills: Object.freeze([]), mcpServers: Object.freeze([]) }),
		trust: "not-required",
	});
}

function directPluginProjection(
	plugin: CodingPlugin,
	settings: UserSettings,
	workspace: string,
): CodingPluginManagementPlugin {
	const manifest = plugin.snapshot.manifest;
	const enabled = settings.plugins?.[plugin.installationId]?.enabled ?? plugin.enabled;
	const skillNames = plugin.snapshot.skills.candidates
		.map(({ metadata }) => `${manifest.name}:${metadata.name}`)
		.sort(compareText);
	const mcpServerNames = plugin.snapshot.mcpServers.map(({ name }) => `${manifest.name}:${name}`).sort(compareText);
	const selectedRevision = plugin.contentDigest;
	const trust = directPluginTrust(plugin, settings, workspace);
	return Object.freeze({
		pluginId: plugin.installationId,
		name: manifest.name,
		namespace: manifest.name,
		marketplace: plugin.source,
		scope: plugin.origin.scope,
		displayName: manifest.name,
		...(manifest.description !== undefined ? { description: manifest.description } : {}),
		state: enabled ? "enabled" : "installed",
		available: false,
		installed: true,
		enabled,
		updateAvailable: false,
		invalid: false,
		...(manifest.version !== undefined ? { installedVersion: manifest.version } : {}),
		selectedDigest: plugin.contentDigest,
		selectedRevision,
		selectedRoot: plugin.snapshot.root,
		source: Object.freeze({ source: "local" as const, path: plugin.snapshot.root, root: plugin.snapshot.root }),
		contributions: Object.freeze({
			skills: Object.freeze(skillNames),
			mcpServers: Object.freeze(mcpServerNames),
		}),
		trust,
		...(mcpServerNames.length > 0 ? { health: "disconnected" as const } : {}),
	});
}

function directPluginTrust(
	plugin: CodingPlugin,
	settings: UserSettings,
	workspace: string,
): CodingPluginManagementPlugin["trust"] {
	if (plugin.origin.scope !== "workspace" || plugin.snapshot.mcpServers.length === 0) return "not-required";
	const configuration = plugin.snapshot.mcpConfiguration;
	if (!configuration) return "not-required";
	return (settings.workspaceMcpTrust ?? []).some(
		(record) =>
			record.workspace === workspace && record.path === configuration.path && record.sha256 === configuration.sha256,
	)
		? "trusted"
		: "untrusted";
}

function withActivePluginState(
	plugin: CodingPluginManagementPlugin,
	active?: ApplicationPluginActiveCatalog,
): CodingPluginManagementPlugin {
	if (!active || plugin.contributions.mcpServers.length === 0) return plugin;
	if (
		active.pluginMcpDiagnostics?.some(
			(diagnostic) =>
				activePluginForMaterializationDiagnostic(active, diagnostic)?.installationId === plugin.pluginId,
		)
	) {
		return Object.freeze({ ...plugin, health: "failed-to-start" as const });
	}
	const activePluginServerIds = new Set(active.agentPluginServerIds);
	const sources = active.plugins.mcpSources.filter((source) => source.plugin.installationId === plugin.pluginId);
	const serverIds = sources.flatMap(({ servers }) =>
		servers.flatMap(({ id }) => (activePluginServerIds.has(id) ? [id] : [])),
	);
	const servers = serverIds.flatMap((id) => {
		const server = active.mcp.servers.find((candidate) => candidate.id === id);
		return server ? [server] : [];
	});
	const health: NonNullable<CodingPluginManagementPlugin["health"]> = servers.some(
		({ status }) => status === "degraded",
	)
		? "failed-to-start"
		: serverIds.length > 0 && servers.length === serverIds.length && servers.every(({ status }) => status === "ready")
			? "ready"
			: "disconnected";
	return Object.freeze({ ...plugin, health });
}

function activePluginMaterializationDiagnostics(
	active?: ApplicationPluginActiveCatalog,
): CodingPluginManagementSnapshot["diagnostics"] {
	if (!active?.pluginMcpDiagnostics) return Object.freeze([]);
	return Object.freeze(
		active.pluginMcpDiagnostics.flatMap((diagnostic) => {
			const plugin = activePluginForMaterializationDiagnostic(active, diagnostic);
			if (!plugin) return [];
			const localComponentName =
				"componentName" in diagnostic && typeof diagnostic.componentName === "string"
					? diagnostic.componentName
					: "serverName" in diagnostic && typeof diagnostic.serverName === "string"
						? diagnostic.serverName
						: undefined;
			const declaredComponentName =
				localComponentName !== undefined &&
				plugin.snapshot.mcpServers.some(({ name }) => name === localComponentName)
					? `${plugin.snapshot.manifest.name}:${localComponentName}`
					: undefined;
			return [
				Object.freeze({
					code: diagnostic.code,
					severity: diagnostic.severity,
					message: diagnostic.message,
					pluginId: plugin.installationId,
					...("path" in diagnostic && diagnostic.path ? { path: diagnostic.path } : {}),
					component: "mcp" as const,
					...(declaredComponentName ? { componentName: declaredComponentName } : {}),
				}),
			];
		}),
	);
}

function activePluginForMaterializationDiagnostic(
	active: ApplicationPluginActiveCatalog,
	diagnostic: CodingPluginMcpDiagnostic,
): CodingPlugin | undefined {
	const { origin } = diagnostic;
	if (!origin.installationId || !origin.pluginName) return undefined;
	const plugin = active.plugins.plugins.find(({ installationId }) => installationId === origin.installationId);
	if (
		!plugin ||
		plugin.snapshot.manifest.name !== origin.pluginName ||
		plugin.origin.root !== origin.root ||
		plugin.origin.pluginRoot !== origin.pluginRoot
	) {
		return undefined;
	}
	return plugin;
}

function activePluginMcpDiagnostics(
	active?: ApplicationPluginActiveCatalog,
): CodingPluginManagementSnapshot["diagnostics"] {
	if (!active) return Object.freeze([]);
	const activePluginServerIds = new Set(active.agentPluginServerIds);
	const pluginByServerId = new Map<string, CodingPluginId>();
	for (const source of active.plugins.mcpSources) {
		for (const server of source.servers) {
			if (activePluginServerIds.has(server.id)) pluginByServerId.set(server.id, source.plugin.installationId);
		}
	}
	return Object.freeze(
		active.mcp.diagnostics.flatMap((diagnostic) => {
			const pluginId = pluginByServerId.get(diagnostic.serverId);
			return pluginId
				? [
						Object.freeze({
							code: diagnostic.code,
							severity: "error" as const,
							message: diagnostic.message,
							pluginId,
							component: "mcp" as const,
							componentName: diagnostic.serverSemanticName,
						}),
					]
				: [];
		}),
	);
}

function inventoryDiagnosticProjection(
	diagnostic: CodingPluginDiagnostic,
): CodingPluginManagementSnapshot["diagnostics"][number] {
	const origin = "origin" in diagnostic ? diagnostic.origin : undefined;
	const pluginId =
		"installationId" in diagnostic
			? diagnostic.installationId
			: (origin?.installationId ?? (origin ? directPluginIdForOrigin(origin) : undefined));
	const phase = "phase" in diagnostic ? diagnostic.phase : "discover";
	const localComponentName =
		"componentName" in diagnostic && typeof diagnostic.componentName === "string"
			? diagnostic.componentName
			: undefined;
	const componentName =
		localComponentName !== undefined && origin?.pluginName !== undefined
			? `${origin.pluginName}:${localComponentName}`
			: undefined;
	return Object.freeze({
		code: diagnostic.code,
		severity: diagnostic.severity,
		message: diagnostic.message,
		...(pluginId ? { pluginId } : {}),
		...("path" in diagnostic && diagnostic.path ? { path: diagnostic.path } : {}),
		component: phase === "skill" ? "skill" : phase === "mcp" ? "mcp" : "plugin",
		...(componentName !== undefined ? { componentName } : {}),
	});
}

function directPluginIdForOrigin(
	origin: CodingPluginsSnapshot["snapshots"][number]["origin"],
): CodingPluginId | undefined {
	if (origin.installationId !== undefined) return origin.installationId;
	if (origin.pluginName !== undefined) return undefined;
	return `${origin.slot}@${origin.scope}-local` as CodingPluginId;
}

function deduplicateDiagnostics(
	diagnostics: readonly CodingPluginManagementSnapshot["diagnostics"][number][],
): CodingPluginManagementSnapshot["diagnostics"][number][] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = JSON.stringify([
			diagnostic.pluginId,
			diagnostic.componentName,
			diagnostic.code,
			diagnostic.message,
			diagnostic.path,
		]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isDirectPluginSource(source: string): source is "user-local" | "workspace-local" {
	return source === "user-local" || source === "workspace-local";
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function definedEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
	);
}

async function dispatchPluginCommand(
	arguments_: PluginCommandArguments,
	management: CodingPluginManagement,
	effectiveSnapshot: (managedSnapshot?: CodingPluginManagementSnapshot) => Promise<CodingPluginManagementSnapshot>,
	lifecycle: (
		operation: "add" | "enable" | "disable" | "upgrade" | "remove",
		pluginId: CodingPluginId,
	) => Promise<CodingPluginManagementSnapshot>,
	io: Pick<ApplicationIO, "stdout">,
): Promise<number> {
	if (arguments_.command === "help") {
		await io.stdout.write(pluginCommandHelp(arguments_.topic));
		return 0;
	}
	if (arguments_.command === "list") {
		const snapshot = await effectiveSnapshot(await management.list());
		const filtered = arguments_.marketplaceName
			? snapshot.plugins.filter(({ marketplace }) => marketplace === arguments_.marketplaceName)
			: snapshot.plugins;
		if (arguments_.json) {
			await writeJson(io, {
				schemaVersion: 1,
				type: "plugin_list",
				revision: snapshot.revision,
				installed: filtered.filter(({ installed }) => installed),
				available: arguments_.available ? filtered.filter(({ installed }) => !installed) : [],
				diagnostics: snapshot.diagnostics,
			});
		} else {
			await writePluginList(
				io,
				filtered.filter(({ installed }) => installed),
			);
		}
		return 0;
	}
	if (arguments_.command === "inspect") {
		const snapshot = await effectiveSnapshot();
		const plugin = snapshot.plugins.find(({ pluginId }) => pluginId === arguments_.pluginId);
		if (!plugin) throw new Error(`Plugin is not available or installed: ${arguments_.pluginId}`);
		const diagnostics = snapshot.diagnostics.filter(
			(diagnostic) => diagnostic.pluginId === undefined || diagnostic.pluginId === arguments_.pluginId,
		);
		if (arguments_.json) {
			await writeJson(io, {
				schemaVersion: 1,
				type: "plugin_inspect",
				revision: snapshot.revision,
				plugin,
				diagnostics,
			});
		} else {
			await writePluginDetail(io, plugin, diagnostics);
		}
		return 0;
	}
	if (
		arguments_.command === "add" ||
		arguments_.command === "enable" ||
		arguments_.command === "disable" ||
		arguments_.command === "upgrade" ||
		arguments_.command === "remove"
	) {
		const snapshot = await lifecycle(arguments_.command, arguments_.pluginId);
		const plugin = snapshot.plugins.find(({ pluginId }) => pluginId === arguments_.pluginId);
		if (arguments_.json) {
			await writeJson(io, {
				schemaVersion: 1,
				type: "plugin_operation",
				operation: arguments_.command,
				revision: snapshot.revision,
				plugin: plugin ?? { pluginId: arguments_.pluginId },
				diagnostics: snapshot.diagnostics,
			});
		} else {
			await io.stdout.write(`${pluginLifecycleVerb(arguments_.command)} ${arguments_.pluginId}\n`);
		}
		return 0;
	}
	if (arguments_.command === "marketplace-list") {
		const snapshot = await management.marketplaceList();
		if (arguments_.json) {
			await writeJson(io, {
				schemaVersion: 1,
				type: "plugin_marketplace_list",
				revision: snapshot.revision,
				marketplaces: snapshot.marketplaces,
				diagnostics: snapshot.diagnostics,
			});
		} else if (snapshot.marketplaces.length === 0) {
			await io.stdout.write("(no Plugin Marketplaces)\n");
		} else {
			for (const marketplace of snapshot.marketplaces) {
				await io.stdout.write(`${marketplace.name}\t${marketplace.status}\t${marketplace.root}\n`);
			}
		}
		return 0;
	}
	const operation = arguments_.command.slice("marketplace-".length) as "add" | "remove" | "upgrade";
	const snapshot =
		arguments_.command === "marketplace-add"
			? await management.marketplaceAdd({
					source: arguments_.source,
					...(arguments_.ref ? { ref: arguments_.ref } : {}),
					...(arguments_.sparse.length > 0 ? { sparse: arguments_.sparse } : {}),
				})
			: arguments_.command === "marketplace-remove"
				? await management.marketplaceRemove(arguments_.marketplaceName)
				: await management.marketplaceUpgrade(arguments_.marketplaceName);
	if (arguments_.json) {
		await writeJson(io, {
			schemaVersion: 1,
			type: "plugin_marketplace_operation",
			operation,
			revision: snapshot.revision,
			marketplaces: snapshot.marketplaces,
			diagnostics: snapshot.diagnostics,
		});
	} else {
		await io.stdout.write(`Plugin Marketplace ${operation} complete\n`);
	}
	return 0;
}

async function dispatchPluginCommandWithJsonErrors(
	arguments_: PluginCommandArguments,
	management: CodingPluginManagement,
	effectiveSnapshot: (managedSnapshot?: CodingPluginManagementSnapshot) => Promise<CodingPluginManagementSnapshot>,
	lifecycle: (
		operation: "add" | "enable" | "disable" | "upgrade" | "remove",
		pluginId: CodingPluginId,
	) => Promise<CodingPluginManagementSnapshot>,
	io: Pick<ApplicationIO, "stdout">,
): Promise<number> {
	try {
		return await dispatchPluginCommand(arguments_, management, effectiveSnapshot, lifecycle, io);
	} catch (error) {
		if (arguments_.command === "help" || !arguments_.json) throw error;
		const notificationFailure = error instanceof CodingPluginChangeNotificationError ? error : undefined;
		await writeJson(io, {
			schemaVersion: 1,
			type: "plugin_error",
			code: pluginCommandErrorCode(arguments_, error),
			operation: arguments_.command,
			...(arguments_.command === "add" ||
			arguments_.command === "inspect" ||
			arguments_.command === "enable" ||
			arguments_.command === "disable" ||
			arguments_.command === "upgrade" ||
			arguments_.command === "remove"
				? { pluginId: arguments_.pluginId }
				: {}),
			committed: notificationFailure !== undefined,
			...(notificationFailure
				? {
						revision: notificationFailure.committedSnapshot.revision,
						diagnostics: notificationFailure.committedSnapshot.diagnostics.slice(
							0,
							MAX_COMMITTED_APPLICATION_DIAGNOSTICS,
						),
					}
				: {}),
			message: errorMessage(error),
		});
		return 1;
	}
}

function pluginCommandErrorCode(arguments_: PluginCommandArguments, error: unknown): string {
	if (error instanceof CodingPluginAlreadyInstalledError) return error.code;
	if (error instanceof CodingPluginChangeNotificationError) return error.code;
	if (
		arguments_.command === "inspect" &&
		error instanceof Error &&
		error.message.startsWith("Plugin is not available or installed:")
	) {
		return "plugin_not_found";
	}
	if (
		arguments_.command === "add" ||
		arguments_.command === "enable" ||
		arguments_.command === "disable" ||
		arguments_.command === "upgrade" ||
		arguments_.command === "remove"
	) {
		return "plugin_operation_failed";
	}
	if (arguments_.command.startsWith("marketplace-")) return "plugin_marketplace_operation_failed";
	return "plugin_command_failed";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pluginLifecycleOperation(
	management: CodingPluginManagement,
	operation: "add" | "enable" | "disable" | "upgrade" | "remove",
	pluginId: CodingPluginId,
): Promise<CodingPluginManagementSnapshot> {
	if (operation === "add") return management.install(pluginId);
	if (operation === "enable") return management.enable(pluginId);
	if (operation === "disable") return management.disable(pluginId);
	if (operation === "upgrade") return management.upgrade(pluginId);
	return management.remove(pluginId);
}

function pluginLifecycleVerb(operation: "add" | "enable" | "disable" | "upgrade" | "remove"): string {
	if (operation === "add") return "Installed";
	if (operation === "enable") return "Enabled";
	if (operation === "disable") return "Disabled";
	if (operation === "upgrade") return "Upgraded";
	return "Removed";
}

function projectFlowSnapshot(snapshot: CodingPluginManagementSnapshot): PluginsCommandFlowSnapshot {
	return Object.freeze({
		revision: snapshot.revision,
		plugins: Object.freeze(
			snapshot.plugins.map((plugin) =>
				Object.freeze({
					pluginId: plugin.pluginId,
					displayName: plugin.displayName,
					...(plugin.description !== undefined ? { description: plugin.description } : {}),
					state: flowState(plugin),
					enabled: plugin.enabled,
					validity: plugin.invalid ? ("invalid" as const) : ("valid" as const),
					scope: plugin.scope,
					...(plugin.source !== undefined ? { source: pluginSourceLabel(plugin.source) } : {}),
					...(plugin.selectedDigest !== undefined ? { selectedDigest: plugin.selectedDigest } : {}),
					...(plugin.selectedRevision !== undefined ? { selectedRevision: plugin.selectedRevision } : {}),
					...(plugin.availableRevision !== undefined ? { availableRevision: plugin.availableRevision } : {}),
					contributions: plugin.contributions,
					...(plugin.installedVersion !== undefined ? { installedVersion: plugin.installedVersion } : {}),
					...(plugin.availableVersion !== undefined ? { availableVersion: plugin.availableVersion } : {}),
					updateAvailable: plugin.updateAvailable,
					trust: plugin.trust,
					...(plugin.health !== undefined ? { health: plugin.health } : {}),
					actions: pluginFlowActions(plugin),
				}),
			),
		),
		diagnostics: Object.freeze(
			snapshot.diagnostics.map((diagnostic) =>
				Object.freeze({
					code: diagnostic.code,
					severity: diagnostic.severity,
					message: diagnostic.message,
					...(diagnostic.pluginId !== undefined ? { pluginId: diagnostic.pluginId } : {}),
					...(diagnostic.componentName !== undefined ? { componentName: diagnostic.componentName } : {}),
				}),
			),
		),
	});
}

function pluginFlowActions(
	plugin: CodingPluginManagementPlugin,
): readonly ("install" | "enable" | "disable" | "upgrade" | "remove")[] {
	if (isDirectPluginSource(plugin.marketplace)) {
		if (plugin.invalid) return Object.freeze([]);
		return Object.freeze([plugin.enabled ? "disable" : "enable"]);
	}
	if (!plugin.installed) return Object.freeze(!plugin.invalid && plugin.available ? ["install"] : []);
	const actions: ("install" | "enable" | "disable" | "upgrade" | "remove")[] = [];
	if (!plugin.invalid) actions.push(plugin.enabled ? "disable" : "enable");
	if (plugin.available && (plugin.invalid || plugin.updateAvailable)) actions.push("upgrade");
	actions.push("remove");
	return Object.freeze(actions);
}

function flowState(
	plugin: CodingPluginManagementPlugin,
): "available" | "disabled" | "enabled" | "invalid" | "update-available" {
	if (plugin.invalid) return "invalid";
	if (!plugin.installed) return "available";
	if (plugin.updateAvailable) return "update-available";
	return plugin.enabled ? "enabled" : "disabled";
}

function pluginSourceLabel(source: NonNullable<CodingPluginManagementPlugin["source"]>): string {
	if (source.source === "local") return source.root;
	return `${source.url}${source.ref ? `@${source.ref}` : source.sha ? `@${source.sha}` : ""}${source.path ? `#${source.path}` : ""}`;
}

async function writePluginList(
	io: Pick<ApplicationIO, "stdout">,
	plugins: readonly CodingPluginManagementPlugin[],
): Promise<void> {
	if (plugins.length === 0) {
		await io.stdout.write("(no installed Plugins)\n");
		return;
	}
	for (const plugin of plugins) {
		await io.stdout.write(`${plugin.pluginId}\t${plugin.state}\t${plugin.installedVersion ?? ""}\n`);
	}
}

async function writePluginDetail(
	io: Pick<ApplicationIO, "stdout">,
	plugin: CodingPluginManagementPlugin,
	diagnostics: readonly CodingPluginManagementSnapshot["diagnostics"][number][],
): Promise<void> {
	await io.stdout.write(`${plugin.displayName} (${plugin.pluginId})\n`);
	await io.stdout.write(`State: ${plugin.state}\n`);
	await io.stdout.write(`Enabled: ${plugin.enabled ? "yes" : "no"}\n`);
	await io.stdout.write(`Validity: ${plugin.invalid ? "invalid" : "valid"}\n`);
	await io.stdout.write(`Scope: ${plugin.scope}\n`);
	await io.stdout.write(`Source: ${plugin.source ? pluginSourceLabel(plugin.source) : "(none)"}\n`);
	await io.stdout.write(`Selected digest: ${plugin.selectedDigest ?? "(none)"}\n`);
	await io.stdout.write(`Selected revision: ${plugin.selectedRevision ?? "(none)"}\n`);
	await io.stdout.write(`Available revision: ${plugin.availableRevision ?? "(none)"}\n`);
	await io.stdout.write(`Update: ${plugin.updateAvailable ? "available" : "current"}\n`);
	await io.stdout.write(`Version: ${plugin.installedVersion ?? plugin.availableVersion ?? "unknown"}\n`);
	await io.stdout.write(`Skills: ${plugin.contributions.skills.join(", ") || "(none)"}\n`);
	await io.stdout.write(`MCP Servers: ${plugin.contributions.mcpServers.join(", ") || "(none)"}\n`);
	await io.stdout.write(`Trust: ${plugin.trust}\n`);
	if (plugin.health) await io.stdout.write(`MCP health: ${plugin.health}\n`);
	for (const diagnostic of diagnostics.slice(0, 20)) {
		await io.stdout.write(
			`${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.componentName ? `${diagnostic.componentName}: ` : ""}${diagnostic.message}\n`,
		);
	}
}

async function writeJson(io: Pick<ApplicationIO, "stdout">, value: unknown): Promise<void> {
	await io.stdout.write(`${JSON.stringify(value)}\n`);
}
