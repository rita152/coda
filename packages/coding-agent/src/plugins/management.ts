import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { IdGenerator } from "@coda/agent";
import { createPlugins, type PluginDiagnostic, type PluginManifest } from "@coda/plugins";
import { withFileMutex } from "../host/file-mutex.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { UserSettings } from "../settings/types.ts";
import type {
	CodingPluginInstallationRecord,
	CodingPluginInstallationStore,
	CodingPluginInstallationVerification,
} from "./installation-store.ts";
import type { CodingPluginMarketplaceEntry, CodingPluginMarketplaceSource } from "./marketplace.ts";
import type {
	AddCodingPluginMarketplaceInput,
	CodingPluginMarketplaceStore,
	CodingPluginMarketplaceStoreRecord,
	CodingPluginMarketplaceStoreSource,
} from "./marketplace-store.ts";
import type { CodingPluginId } from "./types.ts";

export type CodingPluginManagementState = "available" | "installed" | "enabled" | "update-available" | "invalid";

export interface CodingPluginManagementDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
	readonly pluginId?: CodingPluginId;
	readonly marketplace?: string;
	readonly path?: string;
	readonly component?: "plugin" | "skill" | "mcp";
	/** Stable user-facing component identity, such as `<plugin>:<server>`. */
	readonly componentName?: string;
}

export interface CodingPluginManagementMarketplace {
	readonly name: string;
	readonly source: CodingPluginMarketplaceStoreSource;
	readonly root: string;
	readonly revision?: string;
	readonly status: "available" | "invalid";
}

export interface CodingPluginManagementPlugin {
	readonly pluginId: CodingPluginId;
	readonly name: string;
	readonly namespace: string;
	readonly marketplace: string;
	readonly scope: "user" | "workspace";
	readonly displayName: string;
	readonly description?: string;
	readonly state: CodingPluginManagementState;
	readonly available: boolean;
	readonly installed: boolean;
	readonly enabled: boolean;
	readonly updateAvailable: boolean;
	readonly invalid: boolean;
	readonly availableVersion?: string;
	readonly availableDigest?: string;
	readonly availableRevision?: string;
	readonly installedVersion?: string;
	readonly selectedDigest?: string;
	readonly selectedRevision?: string;
	readonly selectedRoot?: string;
	readonly source?: CodingPluginMarketplaceSource;
	readonly contributions: {
		readonly skills: readonly string[];
		readonly mcpServers: readonly string[];
	};
	readonly trust: "not-required" | "trusted" | "untrusted";
	readonly health?: "disconnected" | "failed-to-start" | "ready";
}

export interface CodingPluginManagementSnapshot {
	readonly version: 1;
	readonly revision: string;
	readonly marketplaces: readonly CodingPluginManagementMarketplace[];
	readonly plugins: readonly CodingPluginManagementPlugin[];
	readonly diagnostics: readonly CodingPluginManagementDiagnostic[];
}

export class CodingPluginAlreadyInstalledError extends Error {
	readonly code = "plugin_already_installed";
	readonly committed = false;
	readonly pluginId: CodingPluginId;

	constructor(pluginId: CodingPluginId) {
		super(
			`Plugin is already installed: ${pluginId}. Use "plugin upgrade ${pluginId}" to update it or "plugin enable ${pluginId}" to enable it.`,
		);
		this.name = "CodingPluginAlreadyInstalledError";
		this.pluginId = pluginId;
	}
}

export class CodingPluginChangeNotificationError extends Error {
	/** The requested mutation is durable; callers should retry notification, not the mutation. */
	readonly committed = true;
	readonly code: "plugin_change_notification_failed" | "plugin_post_commit_failed";
	readonly committedSnapshot: CodingPluginManagementSnapshot;

	constructor(
		committedSnapshot: CodingPluginManagementSnapshot,
		cause: unknown,
		options: {
			readonly code?: "plugin_change_notification_failed" | "plugin_post_commit_failed";
			readonly message?: string;
		} = {},
	) {
		super(options.message ?? "Plugin state committed, but the runtime refresh notification failed", { cause });
		this.name = "CodingPluginChangeNotificationError";
		this.code = options.code ?? "plugin_change_notification_failed";
		this.committedSnapshot = committedSnapshot;
	}
}

export type CodingPluginMarketplaceAddInput =
	| AddCodingPluginMarketplaceInput
	| {
			readonly source: string;
			readonly ref?: string;
			readonly sparse?: readonly string[];
			readonly signal?: AbortSignal;
	  };

export interface CodingPluginManagement {
	/** All reads and mutations are serialized through this interface. */
	snapshot(): Promise<CodingPluginManagementSnapshot>;
	list(): Promise<CodingPluginManagementSnapshot>;
	refresh(): Promise<CodingPluginManagementSnapshot>;
	marketplaceList(): Promise<CodingPluginManagementSnapshot>;
	marketplaceAdd(input: CodingPluginMarketplaceAddInput): Promise<CodingPluginManagementSnapshot>;
	marketplaceUpgrade(
		name?: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<CodingPluginManagementSnapshot>;
	marketplaceRemove(
		name: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<CodingPluginManagementSnapshot>;
	install(selector: string, options?: { readonly signal?: AbortSignal }): Promise<CodingPluginManagementSnapshot>;
	upgrade(selector: string, options?: { readonly signal?: AbortSignal }): Promise<CodingPluginManagementSnapshot>;
	enable(selector: string): Promise<CodingPluginManagementSnapshot>;
	disable(selector: string): Promise<CodingPluginManagementSnapshot>;
	remove(selector: string, options?: { readonly signal?: AbortSignal }): Promise<CodingPluginManagementSnapshot>;
}

export interface CreateCodingPluginManagementOptions {
	readonly marketplaceStore: CodingPluginMarketplaceStore;
	readonly installationStore: CodingPluginInstallationStore;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly idGenerator: IdGenerator;
	readonly stagingRoot: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly marketplaceBaseDirectory?: string;
	readonly loadSettings: () => Promise<UserSettings>;
	/** Preferred atomic read-modify-write seam for Plugin-owned settings. */
	readonly updateSettings?: (mutator: (settings: UserSettings) => UserSettings) => Promise<UserSettings>;
	/** Must reject without changing durable settings when its atomic write cannot commit. */
	readonly saveSettings: (settings: UserSettings) => Promise<void>;
	/** The sole post-commit adapter for publishing Plugin changes to the live runtime. */
	readonly onChanged: (snapshot: CodingPluginManagementSnapshot) => void | Promise<void>;
}

type ProjectedPluginManifest = Pick<PluginManifest, "name" | "version" | "description">;
type RemotePluginSource = Exclude<CodingPluginMarketplaceSource, { readonly source: "local" }>;
type RemoteCatalogMode = "cached-only" | "resolve-missing" | "refresh";

interface ManifestProjection {
	readonly manifest?: ProjectedPluginManifest;
	readonly digest?: string;
	readonly invalid: boolean;
	readonly diagnostics: readonly CodingPluginManagementDiagnostic[];
	readonly skillNames: readonly string[];
	readonly mcpServerNames: readonly string[];
}

interface RemoteCatalogRecord {
	readonly pluginId: CodingPluginId;
	readonly declaredSource: RemotePluginSource;
	readonly resolvedSource: RemotePluginSource;
	readonly digest: string;
	readonly manifest: ProjectedPluginManifest;
	readonly skillNames: readonly string[];
	readonly mcpServerNames: readonly string[];
}

interface RemoteCatalogState {
	readonly version: 1;
	readonly entries: readonly RemoteCatalogRecord[];
}

interface RemoteCatalogProjection {
	readonly entries: ReadonlyMap<CodingPluginId, CodingPluginMarketplaceEntry>;
	readonly manifests: ReadonlyMap<CodingPluginId, ManifestProjection>;
}

interface ResolvedPluginPackage {
	readonly root: string;
	readonly source: CodingPluginMarketplaceSource;
	cleanup(): Promise<void>;
}

interface AvailablePluginSelection {
	readonly entry: CodingPluginMarketplaceEntry;
	readonly declaredSource?: RemotePluginSource;
	readonly advertisedDigest?: string;
}

class ApplicationCodingPluginManagement implements CodingPluginManagement {
	readonly #marketplaceStore: CodingPluginMarketplaceStore;
	readonly #installationStore: CodingPluginInstallationStore;
	readonly #fileSystem: FileSystem;
	readonly #processRunner: ProcessRunner;
	readonly #idGenerator: IdGenerator;
	readonly #stagingRoot: string;
	readonly #environment: Readonly<Record<string, string>>;
	readonly #onChanged: (snapshot: CodingPluginManagementSnapshot) => void | Promise<void>;
	readonly #loadSettings: () => Promise<UserSettings>;
	readonly #saveSettings: (settings: UserSettings) => Promise<void>;
	readonly #updateSettings: (mutator: (settings: UserSettings) => UserSettings) => Promise<UserSettings>;
	readonly #marketplaceBaseDirectory: string;
	readonly #remoteCatalogConfiguredRoot: string;
	#remoteCatalogRoot: string | undefined;
	#serial: Promise<void> = Promise.resolve();

	constructor(options: CreateCodingPluginManagementOptions) {
		this.#marketplaceStore = options.marketplaceStore;
		this.#installationStore = options.installationStore;
		this.#fileSystem = options.fileSystem;
		this.#processRunner = options.processRunner;
		this.#idGenerator = options.idGenerator;
		this.#stagingRoot = options.stagingRoot;
		this.#environment = Object.freeze({ ...options.environment });
		this.#loadSettings = options.loadSettings;
		this.#saveSettings = options.saveSettings;
		this.#updateSettings =
			options.updateSettings ??
			(async (mutator) => {
				const next = mutator(await this.#loadSettings());
				await this.#saveSettings(next);
				return next;
			});
		this.#onChanged = options.onChanged;
		this.#marketplaceBaseDirectory = resolve(options.marketplaceBaseDirectory ?? ".");
		this.#remoteCatalogConfiguredRoot = dirname(options.stagingRoot);
	}

	snapshot(): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(() => this.#project());
	}

	list(): Promise<CodingPluginManagementSnapshot> {
		return this.snapshot();
	}

	refresh(): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			const snapshot = await this.#project({ remoteCatalog: "refresh" });
			await this.#notify(snapshot);
			return snapshot;
		});
	}

	marketplaceList(): Promise<CodingPluginManagementSnapshot> {
		return this.snapshot();
	}

	marketplaceAdd(input: CodingPluginMarketplaceAddInput): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			const before = await this.#project({ remoteCatalog: "cached-only" });
			const added = await this.#marketplaceStore.add(
				await normalizeMarketplaceAddInput(input, this.#marketplaceBaseDirectory, this.#fileSystem),
			);
			try {
				await this.#stripMarketplaceGitMetadata(added);
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError) throw error;
				return this.#throwCommittedPostProcessingFailure(error, before);
			}
		});
	}

	marketplaceUpgrade(
		name?: string,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			options.signal?.throwIfAborted();
			const before = await this.#project({ remoteCatalog: "cached-only" });
			let committed = 0;
			try {
				if (name !== undefined) {
					const upgraded = await this.#marketplaceStore.upgrade(name, options);
					committed++;
					await this.#stripMarketplaceGitMetadata(upgraded);
				} else {
					const gitMarketplaces = (await this.#marketplaceStore.list()).marketplaces
						.filter(({ source }) => source.source === "git")
						.map(({ name: marketplaceName }) => marketplaceName)
						.sort(compareText);
					for (const marketplaceName of gitMarketplaces) {
						const upgraded = await this.#marketplaceStore.upgrade(marketplaceName, options);
						committed++;
						await this.#stripMarketplaceGitMetadata(upgraded);
					}
				}
				const snapshot = await this.#project({ remoteCatalog: "refresh" });
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError || committed === 0) throw error;
				return this.#throwCommittedPostProcessingFailure(error, before);
			}
		});
	}

	marketplaceRemove(
		name: string,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			const before = await this.#project({ remoteCatalog: "cached-only" });
			await this.#marketplaceStore.remove(name, options);
			const fallback = committedMarketplaceRemovalFallback(before, name);
			try {
				await this.#removeRemoteCatalogMarketplace(name);
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				return this.#throwCommittedPostProcessingFailure(error, fallback, {
					message: "Plugin Marketplace removal committed, but its durable projection failed",
				});
			}
		});
	}

	install(selector: string, options: { readonly signal?: AbortSignal } = {}): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			options.signal?.throwIfAborted();
			const available = await this.#resolveAvailable(selector);
			const { entry } = available;
			const before = (await this.#installationStore.list()).installations.find(
				(record) => record.pluginId === entry.pluginId,
			);
			if (before) throw new CodingPluginAlreadyInstalledError(entry.pluginId);
			const beforeSnapshot = await this.#project({ remoteCatalog: "cached-only" });
			const installed = await this.#installEntry(entry, before, options.signal, available, {
				beforeSnapshot,
				message: `Plugin installation post-selection processing failed and installation rollback also failed after a durable change: ${entry.pluginId}`,
			});
			try {
				await this.#updateSettings((settings) => withPluginEnablement(settings, entry.pluginId, true));
			} catch (error) {
				await this.#rollbackInstallation(error, before, entry.pluginId, {
					beforeSnapshot,
					message: `Plugin installation settings failed and installation rollback also failed after a durable change: ${entry.pluginId}`,
				});
			}
			const fallback = committedPluginLifecycleFallback(beforeSnapshot, entry.pluginId, "install", installed);
			try {
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError) throw error;
				return this.#throwCommittedPostProcessingFailure(error, fallback, {
					message: "Plugin state committed, but its durable projection failed",
				});
			}
		});
	}

	upgrade(selector: string, options: { readonly signal?: AbortSignal } = {}): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			options.signal?.throwIfAborted();
			const pluginId = await this.#resolveInstalled(selector);
			const available = await this.#resolveAvailable(pluginId);
			const { entry } = available;
			const beforeSnapshot = await this.#project({ remoteCatalog: "cached-only" });
			const before = (await this.#installationStore.list()).installations.find(
				(record) => record.pluginId === pluginId,
			);
			const installed = await this.#installEntry(entry, before, options.signal, available, {
				beforeSnapshot,
				message: `Plugin upgrade post-selection processing failed and installation rollback also failed after a durable change: ${pluginId}`,
			});
			const fallback = committedPluginLifecycleFallback(beforeSnapshot, pluginId, "upgrade", installed);
			try {
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError) throw error;
				return this.#throwCommittedPostProcessingFailure(error, fallback, {
					message: "Plugin state committed, but its durable projection failed",
				});
			}
		});
	}

	enable(selector: string): Promise<CodingPluginManagementSnapshot> {
		return this.#setEnabled(selector, true);
	}

	disable(selector: string): Promise<CodingPluginManagementSnapshot> {
		return this.#setEnabled(selector, false);
	}

	remove(selector: string, options: { readonly signal?: AbortSignal } = {}): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			options.signal?.throwIfAborted();
			const pluginId = await this.#resolveInstalled(selector);
			const beforeSnapshot = await this.#project({ remoteCatalog: "cached-only" });
			let previousEnablement: { readonly enabled: boolean } | undefined;
			await this.#updateSettings((settings) => {
				previousEnablement = settings.plugins?.[pluginId];
				return withoutPluginEnablement(settings, pluginId);
			});
			try {
				await this.#installationStore.remove(pluginId, { signal: options.signal });
			} catch (error) {
				try {
					await this.#updateSettings((settings) =>
						previousEnablement
							? withPluginEnablement(settings, pluginId, previousEnablement.enabled)
							: withoutPluginEnablement(settings, pluginId),
					);
				} catch (rollbackError) {
					return this.#throwRollbackReconciliationFailure(error, rollbackError, beforeSnapshot, pluginId, {
						message: `Plugin removal failed and settings rollback also failed after a durable change: ${pluginId}`,
					});
				}
				throw error;
			}
			const fallback = committedPluginLifecycleFallback(beforeSnapshot, pluginId, "remove");
			try {
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError) throw error;
				return this.#throwCommittedPostProcessingFailure(error, fallback, {
					message: "Plugin state committed, but its durable projection failed",
				});
			}
		});
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(operation, operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #project(
		options: { readonly remoteCatalog?: RemoteCatalogMode } = {},
	): Promise<CodingPluginManagementSnapshot> {
		const marketplaceState = await this.#marketplaceStore.list();
		const catalog = await this.#marketplaceStore.catalog();
		const remoteCatalog = await this.#projectRemoteCatalog(
			catalog.entries,
			options.remoteCatalog ?? "resolve-missing",
		);
		const installationState = await this.#installationStore.listVerified();
		const settings = await this.#loadSettings();
		const diagnostics: CodingPluginManagementDiagnostic[] = catalog.diagnostics.map((entry) =>
			freezeDiagnostic({
				code: entry.code,
				severity: entry.severity,
				message: entry.message,
				...("pluginId" in entry && entry.pluginId ? { pluginId: entry.pluginId } : {}),
				...("marketplace" in entry && entry.marketplace ? { marketplace: entry.marketplace } : {}),
				...(entry.path ? { path: entry.path } : {}),
			}),
		);
		const availableById = new Map<CodingPluginId, CodingPluginMarketplaceEntry>();
		for (const entry of catalog.entries) {
			availableById.set(entry.pluginId, remoteCatalog.entries.get(entry.pluginId) ?? entry);
		}
		const invalidPluginIds = new Set(
			catalog.diagnostics.flatMap((entry) => ("pluginId" in entry && entry.pluginId ? [entry.pluginId] : [])),
		);
		const installedById = new Map(
			installationState.installations.map((record) => [record.pluginId, record] as const),
		);
		const installedVerificationById = new Map(
			installationState.verifications.map((verification) => [verification.record.pluginId, verification] as const),
		);
		const ids = [...new Set([...availableById.keys(), ...installedById.keys(), ...invalidPluginIds])].sort(
			compareText,
		);
		const plugins: CodingPluginManagementPlugin[] = [];
		for (const pluginId of ids) {
			const available = availableById.get(pluginId);
			const installed = installedById.get(pluginId);
			const availableManifest =
				available?.source.source === "local"
					? await this.#manifest(available.source.root, pluginId)
					: (remoteCatalog.manifests.get(pluginId) ?? emptyManifestProjection());
			const installedVerification = installed ? installedVerificationById.get(pluginId) : undefined;
			const installedManifest = !installed
				? emptyManifestProjection()
				: installedVerification?.status === "verified"
					? await this.#manifest(installed.selectedRoot, pluginId)
					: rejectedInstallationManifest(installedVerification!);
			diagnostics.push(...availableManifest.diagnostics, ...installedManifest.diagnostics);
			plugins.push(
				freezePlugin(
					projectPlugin({
						pluginId,
						available,
						installed,
						availableManifest,
						installedManifest,
						catalogInvalid: invalidPluginIds.has(pluginId),
						enabled: installed ? settings.plugins?.[pluginId]?.enabled !== false : false,
					}),
				),
			);
		}
		const marketplaces = marketplaceState.marketplaces.map((record, index) =>
			Object.freeze({
				name: record.name,
				source: Object.freeze(cloneMarketplaceStoreSource(record.source)),
				root: record.root,
				...(record.revision ? { revision: record.revision } : {}),
				status: catalog.marketplaces[index]?.status === "loaded" ? ("available" as const) : ("invalid" as const),
			}),
		);
		diagnostics.sort(compareDiagnostic);
		const projection = {
			version: 1 as const,
			marketplaces: Object.freeze(marketplaces),
			plugins: Object.freeze(plugins),
			diagnostics: Object.freeze(diagnostics),
		};
		const revision = `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`;
		return Object.freeze({ ...projection, revision });
	}

	async #projectRemoteCatalog(
		entries: readonly CodingPluginMarketplaceEntry[],
		mode: RemoteCatalogMode,
	): Promise<RemoteCatalogProjection> {
		const remoteEntries = entries
			.filter(
				(entry): entry is CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource } =>
					entry.source.source !== "local",
			)
			.sort((left, right) => compareText(left.pluginId, right.pluginId));
		if (remoteEntries.length === 0) {
			return Object.freeze({ entries: new Map(), manifests: new Map() });
		}
		const before = await this.#withRemoteCatalogMutex(() => this.#readRemoteCatalogState());
		const beforeById = new Map(before.entries.map((entry) => [entry.pluginId, entry] as const));
		const updates: RemoteCatalogRecord[] = [];
		const projectedEntries = new Map<CodingPluginId, CodingPluginMarketplaceEntry>();
		const manifests = new Map<CodingPluginId, ManifestProjection>();
		for (const entry of remoteEntries) {
			let declaredSource: RemotePluginSource;
			try {
				declaredSource = validateRemotePluginSource(entry.source);
			} catch (error) {
				manifests.set(entry.pluginId, failedRemoteManifestProjection(entry, error));
				continue;
			}
			const cached = beforeById.get(entry.pluginId);
			const matching =
				cached && remoteSourceIdentity(cached.declaredSource) === remoteSourceIdentity(declaredSource)
					? cached
					: undefined;
			let selected = matching;
			let materialized = false;
			let failure: unknown;
			if (mode === "refresh" || (mode === "resolve-missing" && !matching)) {
				try {
					selected = await this.#materializeRemoteCatalogRecord(entry);
					materialized = true;
				} catch (error) {
					failure = error;
				}
			}
			if (selected) {
				if (materialized) updates.push(selected);
				projectedEntries.set(
					entry.pluginId,
					Object.freeze({ ...entry, source: Object.freeze({ ...selected.resolvedSource }) }),
				);
				manifests.set(entry.pluginId, remoteManifestProjection(selected, failure));
			} else if (failure !== undefined) {
				manifests.set(entry.pluginId, failedRemoteManifestProjection(entry, failure));
			}
		}
		const sorted = updates.sort((left, right) => compareText(left.pluginId, right.pluginId));
		if (sorted.length > 0) await this.#mergeRemoteCatalogRecords(sorted);
		return Object.freeze({ entries: projectedEntries, manifests });
	}

	async #materializeRemoteCatalogRecord(
		entry: CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource },
		signal?: AbortSignal,
	): Promise<RemoteCatalogRecord> {
		let resolved: ResolvedPluginPackage | undefined;
		try {
			resolved = await this.#resolvePackage(entry, signal);
			const projection = await this.#manifest(resolved.root, entry.pluginId);
			return remoteCatalogRecord(entry, resolved.source, projection);
		} finally {
			if (resolved) await resolved.cleanup();
		}
	}

	async #selectRemoteCatalogRecord(
		entry: CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource },
		resolvedSource: CodingPluginMarketplaceSource,
		projection: ManifestProjection,
		declaredSource?: RemotePluginSource,
	): Promise<void> {
		if (resolvedSource.source === "local") throw new Error("Remote Plugin resolution returned a local source");
		const selected = remoteCatalogRecord(entry, resolvedSource, projection, declaredSource);
		await this.#mergeRemoteCatalogRecords([selected]);
	}

	async #mergeRemoteCatalogRecords(records: readonly RemoteCatalogRecord[]): Promise<void> {
		await this.#withRemoteCatalogMutex(async () => {
			const before = await this.#readRemoteCatalogState();
			const entries = new Map(before.entries.map((entry) => [entry.pluginId, entry] as const));
			for (const record of records) entries.set(record.pluginId, record);
			const sorted = [...entries.values()].sort((left, right) => compareText(left.pluginId, right.pluginId));
			if (JSON.stringify(before.entries) !== JSON.stringify(sorted)) await this.#writeRemoteCatalogState(sorted);
		});
	}

	async #removeRemoteCatalogMarketplace(name: string): Promise<void> {
		await this.#withRemoteCatalogMutex(async () => {
			const before = await this.#readRemoteCatalogState();
			const retained = before.entries.filter(
				({ pluginId }) => pluginId.slice(pluginId.lastIndexOf("@") + 1) !== name,
			);
			if (retained.length !== before.entries.length) await this.#writeRemoteCatalogState(retained);
		});
	}

	async #withRemoteCatalogMutex<Result>(operation: () => Promise<Result>): Promise<Result> {
		const root = await this.#remoteCatalogStorageRoot();
		return withFileMutex({
			fileSystem: this.#fileSystem,
			path: join(root, "remote-packages.v1.lock"),
			operation,
		});
	}

	async #remoteCatalogStorageRoot(): Promise<string> {
		if (this.#remoteCatalogRoot) return this.#remoteCatalogRoot;
		await this.#fileSystem.makeDirectory(this.#remoteCatalogConfiguredRoot, { recursive: true, mode: 0o700 });
		if ((await this.#fileSystem.lstat(this.#remoteCatalogConfiguredRoot)).kind !== "directory") {
			throw new Error("Plugin remote catalog root must be a directory");
		}
		const root = await this.#fileSystem.realpath(this.#remoteCatalogConfiguredRoot);
		if ((await this.#fileSystem.stat(root)).kind !== "directory") {
			throw new Error("Plugin remote catalog root must resolve to a directory");
		}
		this.#remoteCatalogRoot = root;
		return root;
	}

	async #readRemoteCatalogState(): Promise<RemoteCatalogState> {
		const root = await this.#remoteCatalogStorageRoot();
		const path = join(root, "remote-packages.v1.json");
		try {
			if ((await this.#fileSystem.lstat(path)).kind !== "file") {
				throw new Error("Plugin remote catalog state must be a regular file");
			}
			const value: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(await this.#fileSystem.readFile(path)),
			);
			return parseRemoteCatalogState(value);
		} catch (error) {
			if (isMissingFile(error)) return freezeRemoteCatalogState([]);
			throw new Error("Plugin remote catalog state is invalid", { cause: error });
		}
	}

	async #writeRemoteCatalogState(entries: readonly RemoteCatalogRecord[]): Promise<void> {
		const root = await this.#remoteCatalogStorageRoot();
		const path = join(root, "remote-packages.v1.json");
		const temporary = `${path}.${safeIdentity(this.#idGenerator.generate("queue_item"))}.tmp`;
		let handle: Awaited<ReturnType<FileSystem["open"]>> | undefined;
		let installed = false;
		try {
			handle = await this.#fileSystem.open(temporary, "wx", 0o600);
			await handle.write(`${JSON.stringify(freezeRemoteCatalogState(entries))}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#fileSystem.rename(temporary, path);
			installed = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!installed)
				await this.#fileSystem.removeFile(temporary).catch((error) => {
					if (!isMissingFile(error)) throw error;
				});
		}
	}

	async #resolveAvailable(selector: string): Promise<AvailablePluginSelection> {
		assertSelector(selector);
		const entries = (await this.#marketplaceStore.catalog()).entries;
		const matches = entries.filter((entry) =>
			selector.includes("@") ? entry.pluginId === selector : entry.name === selector,
		);
		if (matches.length === 0) throw new Error(`Plugin is not available: ${selector}`);
		if (matches.length > 1) {
			throw new Error(
				`Plugin selector "${selector}" is ambiguous: ${matches
					.map(({ pluginId }) => pluginId)
					.sort(compareText)
					.join(", ")}`,
			);
		}
		const entry = matches[0]!;
		if (entry.source.source === "local") return Object.freeze({ entry });
		const remoteCatalog = await this.#projectRemoteCatalog(entries, "resolve-missing");
		const resolved = remoteCatalog.entries.get(entry.pluginId);
		const projection = remoteCatalog.manifests.get(entry.pluginId);
		if (!resolved || !projection || projection.invalid || !projection.digest) {
			throw new Error(projection?.diagnostics[0]?.message ?? `Remote Plugin is unavailable: ${entry.pluginId}`);
		}
		return Object.freeze({
			entry: resolved,
			declaredSource: validateRemotePluginSource(entry.source),
			advertisedDigest: projection.digest,
		});
	}

	async #resolveInstalled(selector: string): Promise<CodingPluginId> {
		assertSelector(selector);
		const installations = (await this.#installationStore.list()).installations;
		const matches = installations.filter((entry) =>
			selector.includes("@") ? entry.pluginId === selector : entry.name === selector,
		);
		if (matches.length === 0) throw new Error(`Plugin is not installed: ${selector}`);
		if (matches.length > 1) {
			throw new Error(
				`Plugin selector "${selector}" is ambiguous: ${matches
					.map(({ pluginId }) => pluginId)
					.sort(compareText)
					.join(", ")}`,
			);
		}
		return matches[0]!.pluginId;
	}

	#setEnabled(selector: string, enabled: boolean): Promise<CodingPluginManagementSnapshot> {
		return this.#enqueue(async () => {
			const pluginId = await this.#resolveInstalled(selector);
			const beforeSnapshot = await this.#project({ remoteCatalog: "cached-only" });
			let changed = false;
			await this.#updateSettings((settings) => {
				changed = settings.plugins?.[pluginId]?.enabled !== enabled;
				return changed ? withPluginEnablement(settings, pluginId, enabled) : settings;
			});
			try {
				const snapshot = await this.#project();
				await this.#notify(snapshot);
				return snapshot;
			} catch (error) {
				if (error instanceof CodingPluginChangeNotificationError || !changed) throw error;
				const fallback = committedPluginLifecycleFallback(beforeSnapshot, pluginId, enabled ? "enable" : "disable");
				return this.#throwCommittedPostProcessingFailure(error, fallback, {
					message: "Plugin state committed, but its durable projection failed",
				});
			}
		});
	}

	async #notify(snapshot: CodingPluginManagementSnapshot): Promise<void> {
		try {
			await this.#onChanged(snapshot);
		} catch (error) {
			throw new CodingPluginChangeNotificationError(snapshot, error);
		}
	}

	async #throwCommittedPostProcessingFailure(
		failure: unknown,
		fallback: CodingPluginManagementSnapshot,
		options: {
			readonly message?: string;
		} = {},
	): Promise<never> {
		const failures = [failure];
		let snapshot = fallback;
		let projected = false;
		try {
			snapshot = await this.#project({ remoteCatalog: "cached-only" });
			projected = true;
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#onChanged(snapshot);
		} catch (error) {
			failures.push(error);
		}
		if (!projected) {
			try {
				snapshot = await this.#project({ remoteCatalog: "cached-only" });
			} catch (error) {
				failures.push(error);
			}
		}
		const cause =
			failures.length === 1
				? failure
				: new AggregateError(failures, "Plugin post-commit processing and convergence failed");
		throw new CodingPluginChangeNotificationError(snapshot, cause, {
			code: "plugin_post_commit_failed",
			message: options.message ?? "Plugin state committed, but post-commit Marketplace processing failed",
		});
	}

	async #throwRollbackReconciliationFailure(
		failure: unknown,
		rollbackFailure: unknown,
		before: CodingPluginManagementSnapshot,
		pluginId: CodingPluginId,
		options: { readonly message: string },
	): Promise<never> {
		const failures = [failure, rollbackFailure];
		let durableInstallation: CodingPluginInstallationRecord | null | undefined;
		let durableSettings: UserSettings | undefined;
		try {
			const installations = await this.#installationStore.list();
			durableInstallation = installations.installations.find((record) => record.pluginId === pluginId) ?? null;
		} catch (error) {
			failures.push(error);
		}
		try {
			durableSettings = await this.#loadSettings();
		} catch (error) {
			failures.push(error);
		}
		let snapshot = reconciledPluginLifecycleFallback(before, pluginId, durableInstallation, durableSettings);
		try {
			snapshot = await this.#project({ remoteCatalog: "cached-only" });
		} catch (error) {
			failures.push(error);
		}
		snapshot = committedSnapshotWithDiagnostic(
			snapshot,
			freezeDiagnostic({
				code: "plugin-rollback-failed",
				severity: "error",
				message:
					"Plugin mutation and rollback both failed; this snapshot is the best available projection of the observed durable state",
				pluginId,
				component: "plugin",
			}),
			pluginId,
		);
		try {
			await this.#onChanged(snapshot);
		} catch (error) {
			failures.push(error);
		}
		throw new CodingPluginChangeNotificationError(
			snapshot,
			new AggregateError(failures, "Plugin mutation and rollback failed; durable state was reconciled"),
			{
				code: "plugin_post_commit_failed",
				message: options.message,
			},
		);
	}

	async #installEntry(
		entry: CodingPluginMarketplaceEntry,
		before: CodingPluginInstallationRecord | undefined,
		signal: AbortSignal | undefined,
		selection: AvailablePluginSelection | undefined,
		reconciliation: {
			readonly beforeSnapshot: CodingPluginManagementSnapshot;
			readonly message: string;
		},
	): Promise<CodingPluginInstallationRecord> {
		let installed = false;
		let selected: CodingPluginInstallationRecord | undefined;
		let resolved: ResolvedPluginPackage | undefined;
		try {
			resolved = await this.#resolvePackage(entry, signal);
			let remoteProjection: ManifestProjection | undefined;
			if (entry.source.source !== "local") {
				remoteProjection = await this.#manifest(resolved.root, entry.pluginId);
				remoteCatalogRecord(
					entry as CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource },
					resolved.source,
					remoteProjection,
					selection?.declaredSource,
				);
				if (selection?.advertisedDigest && remoteProjection.digest !== selection.advertisedDigest) {
					throw new Error("Remote Plugin package no longer matches the selected catalog digest");
				}
			}
			selected = await this.#installationStore.install({
				entry: Object.freeze({ ...entry, source: resolved.source }),
				packageRoot: resolved.root,
				signal,
			});
			installed = true;
			if (remoteProjection) {
				if (remoteProjection.digest !== selected.digest) {
					throw new Error("Remote Plugin package changed while it was being selected");
				}
				await this.#selectRemoteCatalogRecord(
					entry as CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource },
					resolved.source,
					remoteProjection,
					selection?.declaredSource,
				);
			}
			await resolved.cleanup();
			resolved = undefined;
		} catch (error) {
			if (installed) await this.#rollbackInstallation(error, before, entry.pluginId, reconciliation);
			throw error;
		} finally {
			await resolved?.cleanup().catch(() => undefined);
		}
		if (!selected) throw new Error("Plugin installation did not select a durable revision");
		return selected;
	}

	async #restoreInstallation(
		before: CodingPluginInstallationRecord | undefined,
		pluginId: CodingPluginId,
	): Promise<void> {
		if (!before) {
			await this.#installationStore.remove(pluginId);
			return;
		}
		await this.#installationStore.install({
			entry: Object.freeze({
				pluginId: before.pluginId,
				name: before.name,
				marketplace: before.marketplace,
				source: before.source,
			}),
			packageRoot: before.selectedRoot,
		});
	}

	async #rollbackInstallation(
		failure: unknown,
		before: CodingPluginInstallationRecord | undefined,
		pluginId: CodingPluginId,
		reconciliation: {
			readonly beforeSnapshot: CodingPluginManagementSnapshot;
			readonly message: string;
		},
	): Promise<never> {
		try {
			await this.#restoreInstallation(before, pluginId);
		} catch (rollbackError) {
			return this.#throwRollbackReconciliationFailure(
				failure,
				rollbackError,
				reconciliation.beforeSnapshot,
				pluginId,
				{ message: reconciliation.message },
			);
		}
		throw failure;
	}

	async #resolvePackage(entry: CodingPluginMarketplaceEntry, signal?: AbortSignal): Promise<ResolvedPluginPackage> {
		if (entry.source.source === "local") {
			assertNonLegacyPath(entry.source.root, "Plugin package root");
			return Object.freeze({
				root: entry.source.root,
				source: Object.freeze({ ...entry.source }),
				cleanup: async () => undefined,
			});
		}
		const source = validateRemotePluginSource(entry.source);
		const operationSignal = signal ?? new AbortController().signal;
		operationSignal.throwIfAborted();
		const stagingRoot = await this.#ensureStagingRoot();
		const checkoutRoot = join(stagingRoot, safeIdentity(this.#idGenerator.generate("queue_item")));
		let cleanupPending = true;
		const cleanup = async (): Promise<void> => {
			if (!cleanupPending) return;
			await this.#removeTreeIfPresent(checkoutRoot);
			cleanupPending = false;
		};
		try {
			await this.#runGit(
				["clone", "--no-checkout", "--filter=blob:none", "--", source.url, checkoutRoot],
				stagingRoot,
				operationSignal,
				"clone",
			);
			if ((await this.#fileSystem.lstat(checkoutRoot)).kind !== "directory") {
				throw new Error("Git Plugin clone did not create a directory");
			}
			const canonicalCheckout = await this.#fileSystem.realpath(checkoutRoot);
			if (!isContained(stagingRoot, canonicalCheckout) || relative(checkoutRoot, canonicalCheckout) !== "") {
				throw new Error("Git Plugin checkout escaped its staging location");
			}
			await this.#runGit(
				["-C", canonicalCheckout, "sparse-checkout", "init", "--no-cone"],
				stagingRoot,
				operationSignal,
				"sparse-checkout init",
			);
			await this.#runGit(
				[
					"-C",
					canonicalCheckout,
					"sparse-checkout",
					"set",
					"--no-cone",
					"--",
					"/*",
					"!**/.codex-plugin/",
					`!**/${LEGACY_PLUGIN_DIRECTORY_CASE_FOLD_GLOB}/`,
				],
				stagingRoot,
				operationSignal,
				"sparse-checkout set",
			);
			const target = source.sha ?? source.ref ?? "HEAD";
			await this.#runGit(
				["-C", canonicalCheckout, "checkout", "--detach", target, "--"],
				stagingRoot,
				operationSignal,
				"checkout",
			);
			const headResult = await this.#runGit(
				["-C", canonicalCheckout, "rev-parse", "--verify", "HEAD"],
				stagingRoot,
				operationSignal,
				"revision discovery",
			);
			const head = headResult.stdout.trim().toLowerCase();
			if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) {
				throw new Error("Git Plugin HEAD is not a full object revision");
			}
			if (source.sha && head !== source.sha) {
				throw new Error(`Git Plugin HEAD ${head} does not match declared SHA ${source.sha}`);
			}
			await this.#removeTreeIfPresent(join(canonicalCheckout, ".git"));
			const lexicalPackageRoot = source.path
				? resolve(canonicalCheckout, ...source.path.split("/"))
				: canonicalCheckout;
			if (!isContained(canonicalCheckout, lexicalPackageRoot)) {
				throw new Error("Git Plugin package path escapes its checkout");
			}
			if ((await this.#fileSystem.lstat(lexicalPackageRoot)).kind !== "directory") {
				throw new Error("Git Plugin package root is not a directory");
			}
			const packageRoot = await this.#fileSystem.realpath(lexicalPackageRoot);
			if (!isContained(canonicalCheckout, packageRoot)) {
				throw new Error("Git Plugin package root resolves outside its checkout");
			}
			assertNonLegacyPath(packageRoot, "Git Plugin package root");
			return Object.freeze({
				root: packageRoot,
				source: Object.freeze({ ...source, sha: head }),
				cleanup,
			});
		} catch (error) {
			await cleanup().catch(() => undefined);
			throw error;
		}
	}

	async #ensureStagingRoot(): Promise<string> {
		await this.#fileSystem.makeDirectory(this.#stagingRoot, { recursive: true, mode: 0o700 });
		if ((await this.#fileSystem.lstat(this.#stagingRoot)).kind !== "directory") {
			throw new Error("Plugin staging root must be a directory");
		}
		const root = await this.#fileSystem.realpath(this.#stagingRoot);
		if ((await this.#fileSystem.stat(root)).kind !== "directory") {
			throw new Error("Plugin staging root must resolve to a directory");
		}
		return root;
	}

	async #runGit(args: readonly string[], cwd: string, signal: AbortSignal, operation: string) {
		signal.throwIfAborted();
		const result = await this.#processRunner.run({
			executable: "git",
			args: Object.freeze([...args]),
			cwd,
			environment: this.#environment,
			signal,
			timeoutMs: 120_000,
			maxOutputBytes: 1024 * 1024,
			maxOutputLines: 10_000,
		});
		signal.throwIfAborted();
		if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.truncated) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`;
			throw new Error(`Git Plugin ${operation} failed: ${detail}`);
		}
		return result;
	}

	async #removeTreeIfPresent(path: string): Promise<void> {
		let kind: "directory" | "file" | "other" | "symbolic-link";
		try {
			kind = (await this.#fileSystem.lstat(path)).kind;
		} catch (error) {
			if (isMissingFile(error)) return;
			throw error;
		}
		if (kind !== "directory") {
			await this.#fileSystem.removeFile(path);
			return;
		}
		for (const entry of await this.#fileSystem.readDirectory(path)) {
			assertSafeEntryName(entry.name);
			const child = join(path, entry.name);
			if (isLegacyPluginDirectoryName(entry.name)) {
				await this.#fileSystem.removeTree(child);
				continue;
			}
			await this.#removeTreeIfPresent(child);
		}
		await this.#fileSystem.removeDirectory(path);
	}

	async #stripMarketplaceGitMetadata(record: CodingPluginMarketplaceStoreRecord): Promise<void> {
		if (record.source.source === "git") await this.#removeTreeIfPresent(join(record.root, ".git"));
	}

	async #manifest(root: string, pluginId: CodingPluginId): Promise<ManifestProjection> {
		const snapshot = await createPlugins<CodingPluginId>({ fileSystem: this.#fileSystem }).load({
			root,
			origin: pluginId,
		});
		if (snapshot.status === "loaded") {
			return Object.freeze({
				manifest: snapshot.manifest,
				digest: await this.#installationStore.digestPackage(root),
				invalid: false,
				diagnostics: Object.freeze(
					snapshot.diagnostics
						.slice(0, 64)
						.map((entry) => portableManagementDiagnostic(entry, pluginId, snapshot.manifest.name)),
				),
				skillNames: Object.freeze(
					snapshot.skills.candidates
						.map(({ metadata }) => `${snapshot.manifest.name}:${metadata.name}`)
						.sort(compareText),
				),
				mcpServerNames: Object.freeze(
					snapshot.mcpServers.map(({ name }) => `${snapshot.manifest.name}:${name}`).sort(compareText),
				),
			});
		}
		return Object.freeze({
			invalid: true,
			skillNames: Object.freeze([]),
			mcpServerNames: Object.freeze([]),
			diagnostics: Object.freeze(snapshot.diagnostics.map((entry) => portableManagementDiagnostic(entry, pluginId))),
		});
	}
}

export function createCodingPluginManagement(options: CreateCodingPluginManagementOptions): CodingPluginManagement {
	if (!options || typeof options !== "object") throw new TypeError("Plugin management options are required");
	if (!options.marketplaceStore) throw new TypeError("marketplaceStore is required");
	if (!options.installationStore) throw new TypeError("installationStore is required");
	if (!options.fileSystem) throw new TypeError("fileSystem is required");
	if (!options.processRunner) throw new TypeError("processRunner is required");
	if (!options.idGenerator) throw new TypeError("idGenerator is required");
	if (!isAbsolute(options.stagingRoot)) throw new TypeError("Plugin staging root must be absolute");
	if (!options.environment || typeof options.environment !== "object") throw new TypeError("environment is required");
	if (typeof options.loadSettings !== "function") throw new TypeError("loadSettings is required");
	if (typeof options.saveSettings !== "function") throw new TypeError("saveSettings is required");
	if (typeof options.onChanged !== "function") throw new TypeError("onChanged is required");
	return new ApplicationCodingPluginManagement(options);
}

function projectPlugin(input: {
	readonly pluginId: CodingPluginId;
	readonly available?: CodingPluginMarketplaceEntry;
	readonly installed?: CodingPluginInstallationRecord;
	readonly availableManifest: ManifestProjection;
	readonly installedManifest: ManifestProjection;
	readonly catalogInvalid: boolean;
	readonly enabled: boolean;
}): CodingPluginManagementPlugin {
	const { pluginId, available, installed, availableManifest, installedManifest, catalogInvalid, enabled } = input;
	const separator = pluginId.lastIndexOf("@");
	const name = available?.name ?? installed?.name ?? pluginId.slice(0, separator);
	const marketplace = available?.marketplace ?? installed?.marketplace ?? pluginId.slice(separator + 1);
	const invalid = installed ? installedManifest.invalid : catalogInvalid || availableManifest.invalid;
	const availableVersion = availableManifest.manifest?.version;
	const availableRevision = available?.source.source === "local" ? availableManifest.digest : available?.source.sha;
	const installedVersion = installed?.version ?? installedManifest.manifest?.version;
	const updateAvailable = Boolean(
		installed &&
			available &&
			((availableVersion !== undefined && installedVersion !== undefined && availableVersion !== installedVersion) ||
				(availableManifest.digest !== undefined && availableManifest.digest !== installed.digest) ||
				remoteSourceChanged(installed.source, available.source)),
	);
	const state: CodingPluginManagementState = invalid
		? "invalid"
		: updateAvailable
			? "update-available"
			: enabled
				? "enabled"
				: installed
					? "installed"
					: "available";
	const manifest = installedManifest.manifest ?? availableManifest.manifest;
	const contributions = installed ? installedManifest : available ? availableManifest : emptyManifestProjection();
	return {
		pluginId,
		name,
		namespace: name,
		marketplace,
		scope: "user",
		displayName: manifest?.name ?? name,
		...(manifest?.description ? { description: manifest.description } : {}),
		state,
		available: available !== undefined,
		installed: installed !== undefined,
		enabled,
		updateAvailable,
		invalid,
		...(availableVersion ? { availableVersion } : {}),
		...(availableManifest.digest ? { availableDigest: availableManifest.digest } : {}),
		...(availableRevision ? { availableRevision } : {}),
		...(installedVersion ? { installedVersion } : {}),
		...(installed ? { selectedDigest: installed.digest, selectedRevision: installed.revision } : {}),
		...(installed ? { selectedRoot: installed.selectedRoot } : {}),
		...(available || installed ? { source: Object.freeze({ ...(installed?.source ?? available!.source) }) } : {}),
		contributions: Object.freeze({
			skills: contributions.skillNames,
			mcpServers: contributions.mcpServerNames,
		}),
		trust: "not-required",
		...(contributions.mcpServerNames.length > 0 ? { health: "disconnected" as const } : {}),
	};
}

function remoteSourceChanged(
	installed: CodingPluginMarketplaceSource,
	available: CodingPluginMarketplaceSource,
): boolean {
	if (installed.source === "local" || available.source === "local") {
		return JSON.stringify(installed) !== JSON.stringify(available);
	}
	return (
		installed.source !== available.source ||
		installed.url !== available.url ||
		installed.path !== available.path ||
		installed.ref !== available.ref ||
		(available.sha !== undefined && installed.sha !== available.sha)
	);
}

function emptyManifestProjection(): ManifestProjection {
	return Object.freeze({
		invalid: false,
		diagnostics: Object.freeze([]),
		skillNames: Object.freeze([]),
		mcpServerNames: Object.freeze([]),
	});
}

function rejectedInstallationManifest(
	verification: Extract<CodingPluginInstallationVerification, { readonly status: "rejected" }>,
): ManifestProjection {
	return Object.freeze({
		invalid: true,
		diagnostics: Object.freeze([
			freezeDiagnostic({
				code: verification.code,
				severity: "error",
				message: verification.message,
				pluginId: verification.record.pluginId,
				path: verification.record.selectedRoot,
			}),
		]),
		skillNames: Object.freeze([]),
		mcpServerNames: Object.freeze([]),
	});
}

function remoteCatalogRecord(
	entry: CodingPluginMarketplaceEntry & { readonly source: RemotePluginSource },
	resolvedSource: CodingPluginMarketplaceSource,
	projection: ManifestProjection,
	declaredSourceOverride?: RemotePluginSource,
): RemoteCatalogRecord {
	if (resolvedSource.source === "local") throw new Error("Remote Plugin resolution returned a local source");
	if (projection.invalid || !projection.manifest || !projection.digest) {
		throw new Error(projection.diagnostics[0]?.message ?? "Remote Agent Plugin package is invalid");
	}
	if (projection.manifest.name !== entry.name) {
		throw new Error(
			`Remote Agent Plugin manifest name "${projection.manifest.name}" does not match PluginId name "${entry.name}"`,
		);
	}
	const declaredSource = validateRemotePluginSource(declaredSourceOverride ?? entry.source);
	const resolved = validateRemotePluginSource(resolvedSource);
	if (!resolved.sha) throw new Error("Remote Plugin resolution did not produce an exact Git revision");
	if (
		declaredSource.source !== resolved.source ||
		declaredSource.url !== resolved.url ||
		declaredSource.path !== resolved.path ||
		declaredSource.ref !== resolved.ref ||
		(declaredSource.sha !== undefined && declaredSource.sha !== resolved.sha)
	) {
		throw new Error("Remote Plugin resolution changed its declared source identity");
	}
	return freezeRemoteCatalogRecord({
		pluginId: entry.pluginId,
		declaredSource,
		resolvedSource: resolved,
		digest: projection.digest,
		manifest: Object.freeze({
			name: projection.manifest.name,
			...(projection.manifest.version ? { version: projection.manifest.version } : {}),
			...(projection.manifest.description ? { description: projection.manifest.description } : {}),
		}),
		skillNames: projection.skillNames,
		mcpServerNames: projection.mcpServerNames,
	});
}

function remoteManifestProjection(record: RemoteCatalogRecord, failure?: unknown): ManifestProjection {
	return Object.freeze({
		manifest: record.manifest,
		digest: record.digest,
		invalid: false,
		diagnostics: Object.freeze(
			failure === undefined
				? []
				: [
						freezeDiagnostic({
							code: "plugin-remote-refresh-failed",
							severity: "warning",
							message: `Could not refresh remote Plugin; retained revision ${record.resolvedSource.sha}: ${errorMessage(failure)}`,
							pluginId: record.pluginId,
							component: "plugin",
						}),
					],
		),
		skillNames: record.skillNames,
		mcpServerNames: record.mcpServerNames,
	});
}

function failedRemoteManifestProjection(entry: CodingPluginMarketplaceEntry, failure: unknown): ManifestProjection {
	return Object.freeze({
		invalid: true,
		diagnostics: Object.freeze([
			freezeDiagnostic({
				code: "plugin-remote-refresh-failed",
				severity: "error",
				message: `Could not resolve remote Agent Plugin package: ${errorMessage(failure)}`,
				pluginId: entry.pluginId,
				marketplace: entry.marketplace,
				component: "plugin",
			}),
		]),
		skillNames: Object.freeze([]),
		mcpServerNames: Object.freeze([]),
	});
}

function remoteSourceIdentity(source: RemotePluginSource): string {
	return JSON.stringify(validateRemotePluginSource(source));
}

function parseRemoteCatalogState(value: unknown): RemoteCatalogState {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "entries"]) || value.version !== 1) {
		throw new Error("invalid remote Plugin catalog state");
	}
	if (!Array.isArray(value.entries)) throw new Error("invalid remote Plugin catalog entries");
	const entries = value.entries.map(parseRemoteCatalogRecord);
	const sorted = [...entries].sort((left, right) => compareText(left.pluginId, right.pluginId));
	if (
		new Set(entries.map(({ pluginId }) => pluginId)).size !== entries.length ||
		entries.some((entry, index) => entry.pluginId !== sorted[index]?.pluginId)
	) {
		throw new Error("remote Plugin catalog entries are duplicated or unsorted");
	}
	return freezeRemoteCatalogState(entries);
}

function parseRemoteCatalogRecord(value: unknown): RemoteCatalogRecord {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			"pluginId",
			"declaredSource",
			"resolvedSource",
			"digest",
			"manifest",
			"skillNames",
			"mcpServerNames",
		]) ||
		typeof value.pluginId !== "string" ||
		!value.pluginId.includes("@") ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.digest) ||
		!Array.isArray(value.skillNames) ||
		!Array.isArray(value.mcpServerNames)
	) {
		throw new Error("invalid remote Plugin catalog record");
	}
	assertSelector(value.pluginId);
	const declaredSource = parseRemoteCatalogSource(value.declaredSource, false);
	const resolvedSource = parseRemoteCatalogSource(value.resolvedSource, true);
	if (
		declaredSource.source !== resolvedSource.source ||
		declaredSource.url !== resolvedSource.url ||
		declaredSource.path !== resolvedSource.path ||
		declaredSource.ref !== resolvedSource.ref ||
		(declaredSource.sha !== undefined && declaredSource.sha !== resolvedSource.sha)
	) {
		throw new Error("remote Plugin catalog source identity changed");
	}
	if (!isRecord(value.manifest) || !hasOnlyKeys(value.manifest, ["name", "version", "description"])) {
		throw new Error("invalid remote Plugin catalog manifest");
	}
	const manifest = value.manifest;
	if (
		typeof manifest.name !== "string" ||
		!validPluginName(manifest.name) ||
		(manifest.version !== undefined && typeof manifest.version !== "string") ||
		(manifest.description !== undefined && typeof manifest.description !== "string") ||
		!value.pluginId.startsWith(`${manifest.name}@`)
	) {
		throw new Error("invalid remote Plugin catalog manifest identity");
	}
	const skillNames = parseSortedStrings(value.skillNames, "Skill");
	const mcpServerNames = parseSortedStrings(value.mcpServerNames, "MCP Server");
	return freezeRemoteCatalogRecord({
		pluginId: value.pluginId as CodingPluginId,
		declaredSource,
		resolvedSource,
		digest: value.digest,
		manifest: Object.freeze({
			name: manifest.name,
			...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
			...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
		}),
		skillNames,
		mcpServerNames,
	});
}

function parseRemoteCatalogSource(value: unknown, exact: boolean): RemotePluginSource {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, ["source", "url", "path", "ref", "sha"]) ||
		(value.source !== "url" && value.source !== "git-subdir") ||
		typeof value.url !== "string" ||
		(value.path !== undefined && typeof value.path !== "string") ||
		(value.ref !== undefined && typeof value.ref !== "string") ||
		(value.sha !== undefined && typeof value.sha !== "string") ||
		(exact && typeof value.sha !== "string")
	) {
		throw new Error("invalid remote Plugin catalog source");
	}
	return validateRemotePluginSource({
		source: value.source,
		url: value.url,
		...(typeof value.path === "string" ? { path: value.path } : {}),
		...(typeof value.ref === "string" ? { ref: value.ref } : {}),
		...(typeof value.sha === "string" ? { sha: value.sha } : {}),
	});
}

function parseSortedStrings(value: readonly unknown[], label: string): readonly string[] {
	if (value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		throw new Error(`invalid remote Plugin catalog ${label} names`);
	}
	const entries = value as readonly string[];
	const sorted = [...new Set(entries)].sort(compareText);
	if (entries.length !== sorted.length || entries.some((entry, index) => entry !== sorted[index])) {
		throw new Error(`remote Plugin catalog ${label} names are duplicated or unsorted`);
	}
	return Object.freeze(sorted);
}

function freezeRemoteCatalogRecord(record: RemoteCatalogRecord): RemoteCatalogRecord {
	return Object.freeze({
		...record,
		declaredSource: Object.freeze({ ...record.declaredSource }),
		resolvedSource: Object.freeze({ ...record.resolvedSource }),
		manifest: Object.freeze({ ...record.manifest }),
		skillNames: Object.freeze([...record.skillNames]),
		mcpServerNames: Object.freeze([...record.mcpServerNames]),
	});
}

function freezeRemoteCatalogState(entries: readonly RemoteCatalogRecord[]): RemoteCatalogState {
	return Object.freeze({
		version: 1 as const,
		entries: Object.freeze(entries.map(freezeRemoteCatalogRecord)),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const MAX_COMMITTED_FALLBACK_PLUGINS = 1_024;
const MAX_COMMITTED_FALLBACK_DIAGNOSTICS = 512;

function committedSnapshotWithDiagnostic(
	snapshot: CodingPluginManagementSnapshot,
	diagnostic: CodingPluginManagementDiagnostic,
	pluginId: CodingPluginId,
): CodingPluginManagementSnapshot {
	const diagnostics = [
		...snapshot.diagnostics
			.filter(
				(entry) =>
					entry.code !== diagnostic.code ||
					entry.pluginId !== diagnostic.pluginId ||
					entry.message !== diagnostic.message,
			)
			.slice(0, Math.max(0, MAX_COMMITTED_FALLBACK_DIAGNOSTICS - 1)),
		diagnostic,
	].sort(compareDiagnostic);
	const projection = {
		version: 1 as const,
		marketplaces: Object.freeze(snapshot.marketplaces.slice(0, MAX_COMMITTED_FALLBACK_PLUGINS)),
		plugins: Object.freeze(boundedPluginsWithTarget(snapshot.plugins, pluginId, MAX_COMMITTED_FALLBACK_PLUGINS)),
		diagnostics: Object.freeze(diagnostics),
	};
	return Object.freeze({
		...projection,
		revision: `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
	});
}

function reconciledPluginLifecycleFallback(
	before: CodingPluginManagementSnapshot,
	pluginId: CodingPluginId,
	installation: CodingPluginInstallationRecord | null | undefined,
	settings: UserSettings | undefined,
): CodingPluginManagementSnapshot {
	const previous = before.plugins.find((plugin) => plugin.pluginId === pluginId);
	let snapshot =
		installation === null
			? committedPluginLifecycleFallback(before, pluginId, "remove")
			: installation
				? committedPluginLifecycleFallback(
						before,
						pluginId,
						previous?.installed ? "upgrade" : "install",
						installation,
					)
				: committedPluginLifecycleFallback(
						before,
						pluginId,
						previous?.installed ? (previous.enabled ? "enable" : "disable") : "remove",
					);
	if (installation && settings) {
		const enabled = settings.plugins?.[pluginId]?.enabled !== false;
		snapshot = committedPluginLifecycleFallback(snapshot, pluginId, enabled ? "enable" : "disable");
	}
	return snapshot;
}

function committedMarketplaceRemovalFallback(
	before: CodingPluginManagementSnapshot,
	marketplace: string,
): CodingPluginManagementSnapshot {
	const plugins = before.plugins.flatMap((plugin): readonly CodingPluginManagementPlugin[] => {
		if (plugin.marketplace !== marketplace) return [plugin];
		if (!plugin.installed) return [];
		const {
			availableVersion: _availableVersion,
			availableDigest: _availableDigest,
			availableRevision: _availableRevision,
			...selected
		} = plugin;
		return [
			freezePlugin({
				...selected,
				state: plugin.invalid ? "invalid" : plugin.enabled ? "enabled" : "installed",
				available: false,
				updateAvailable: false,
			}),
		];
	});
	plugins.sort((left, right) => compareText(left.pluginId, right.pluginId));
	const diagnostics = [
		...before.diagnostics.slice(0, Math.max(0, MAX_COMMITTED_FALLBACK_DIAGNOSTICS - 1)),
		freezeDiagnostic({
			code: "plugin-post-commit-projection-failed",
			severity: "error",
			message: "Plugin Marketplace state is durable, but its complete projection is temporarily unavailable",
			marketplace,
			component: "plugin",
		}),
	].sort(compareDiagnostic);
	const projection = {
		version: 1 as const,
		marketplaces: Object.freeze(
			before.marketplaces.filter(({ name }) => name !== marketplace).slice(0, MAX_COMMITTED_FALLBACK_PLUGINS),
		),
		plugins: Object.freeze(plugins.slice(0, MAX_COMMITTED_FALLBACK_PLUGINS)),
		diagnostics: Object.freeze(diagnostics),
	};
	return Object.freeze({
		...projection,
		revision: `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
	});
}

function committedPluginLifecycleFallback(
	before: CodingPluginManagementSnapshot,
	pluginId: CodingPluginId,
	operation: "install" | "upgrade" | "enable" | "disable" | "remove",
	selected?: CodingPluginInstallationRecord,
): CodingPluginManagementSnapshot {
	const existing = before.plugins.find((plugin) => plugin.pluginId === pluginId);
	const plugins = before.plugins.flatMap((plugin): readonly CodingPluginManagementPlugin[] => {
		if (plugin.pluginId !== pluginId) return [plugin];
		if (operation === "remove" && !plugin.available) return [];
		if (operation === "remove") {
			const {
				installedVersion: _installedVersion,
				selectedDigest: _selectedDigest,
				selectedRevision: _selectedRevision,
				selectedRoot: _selectedRoot,
				health: _health,
				...retained
			} = plugin;
			return [
				freezePlugin({
					...retained,
					state: plugin.invalid ? "invalid" : "available",
					installed: false,
					enabled: false,
					updateAvailable: false,
				}),
			];
		}
		if (operation === "enable" || operation === "disable") {
			const enabled = operation === "enable";
			return [
				freezePlugin({
					...plugin,
					state: plugin.invalid ? "invalid" : enabled ? "enabled" : "installed",
					enabled,
				}),
			];
		}
		const enabled = operation === "install" ? true : plugin.enabled;
		return [
			freezePlugin({
				...plugin,
				state: plugin.invalid ? "invalid" : enabled ? "enabled" : "installed",
				installed: true,
				enabled,
				updateAvailable: false,
				...((selected?.version ?? plugin.availableVersion)
					? { installedVersion: selected?.version ?? plugin.availableVersion }
					: {}),
				...(selected
					? {
							selectedDigest: selected.digest,
							selectedRevision: selected.revision,
							selectedRoot: selected.selectedRoot,
							source: selected.source,
						}
					: {}),
			}),
		];
	});
	if (!existing && selected && (operation === "install" || operation === "upgrade")) {
		plugins.push(
			freezePlugin({
				pluginId,
				name: selected.name,
				namespace: selected.name,
				marketplace: selected.marketplace,
				scope: "user",
				displayName: selected.name,
				state: "enabled",
				available: false,
				installed: true,
				enabled: true,
				updateAvailable: false,
				invalid: false,
				...(selected.version ? { installedVersion: selected.version } : {}),
				selectedDigest: selected.digest,
				selectedRevision: selected.revision,
				selectedRoot: selected.selectedRoot,
				source: selected.source,
				contributions: Object.freeze({ skills: Object.freeze([]), mcpServers: Object.freeze([]) }),
				trust: "not-required",
			}),
		);
	}
	plugins.sort((left, right) => compareText(left.pluginId, right.pluginId));
	const fallbackDiagnostic = freezeDiagnostic({
		code: "plugin-post-commit-projection-failed",
		severity: "error",
		message: "Plugin state is durable, but its complete projection is temporarily unavailable",
		pluginId,
		component: "plugin",
	});
	const diagnostics = [
		...before.diagnostics.slice(0, Math.max(0, MAX_COMMITTED_FALLBACK_DIAGNOSTICS - 1)),
		fallbackDiagnostic,
	].sort(compareDiagnostic);
	const projection = {
		version: 1 as const,
		marketplaces: Object.freeze(before.marketplaces.slice(0, MAX_COMMITTED_FALLBACK_PLUGINS)),
		plugins: Object.freeze(boundedPluginsWithTarget(plugins, pluginId, MAX_COMMITTED_FALLBACK_PLUGINS)),
		diagnostics: Object.freeze(diagnostics),
	};
	return Object.freeze({
		...projection,
		revision: `plugins:${createHash("sha256").update(JSON.stringify(projection)).digest("hex")}`,
	});
}

function boundedPluginsWithTarget(
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

function freezeDiagnostic(diagnostic: CodingPluginManagementDiagnostic): CodingPluginManagementDiagnostic {
	return Object.freeze({ ...diagnostic });
}

function portableManagementDiagnostic(
	diagnostic: PluginDiagnostic<CodingPluginId>,
	pluginId: CodingPluginId,
	pluginName?: string,
): CodingPluginManagementDiagnostic {
	const componentName =
		diagnostic.componentName !== undefined && pluginName !== undefined
			? `${pluginName}:${diagnostic.componentName}`
			: undefined;
	return freezeDiagnostic({
		code: diagnostic.code,
		severity: diagnostic.severity,
		message: diagnostic.message,
		pluginId,
		...(diagnostic.path ? { path: diagnostic.path } : {}),
		component: diagnostic.phase === "skill" ? "skill" : diagnostic.phase === "mcp" ? "mcp" : "plugin",
		...(componentName !== undefined ? { componentName } : {}),
	});
}

function freezePlugin(plugin: CodingPluginManagementPlugin): CodingPluginManagementPlugin {
	return Object.freeze({
		...plugin,
		...(plugin.source ? { source: Object.freeze({ ...plugin.source }) } : {}),
		contributions: Object.freeze({
			skills: Object.freeze([...plugin.contributions.skills]),
			mcpServers: Object.freeze([...plugin.contributions.mcpServers]),
		}),
	});
}

function cloneMarketplaceStoreSource(source: CodingPluginMarketplaceStoreSource): CodingPluginMarketplaceStoreSource {
	return source.source === "local"
		? { ...source }
		: { ...source, ...(source.sparse ? { sparse: Object.freeze([...source.sparse]) } : {}) };
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostic(left: CodingPluginManagementDiagnostic, right: CodingPluginManagementDiagnostic): number {
	return (
		compareText(left.pluginId ?? "", right.pluginId ?? "") ||
		compareText(left.componentName ?? "", right.componentName ?? "") ||
		compareText(left.code, right.code) ||
		compareText(left.message, right.message) ||
		compareText(left.path ?? "", right.path ?? "")
	);
}

function assertSelector(selector: string): void {
	if (typeof selector !== "string" || selector.length === 0 || selector.trim() !== selector) {
		throw new TypeError("Plugin selector is invalid");
	}
	if (selector.includes("@")) {
		const separator = selector.lastIndexOf("@");
		if (
			separator <= 0 ||
			!validPluginName(selector.slice(0, separator)) ||
			!validMarketplaceName(selector.slice(separator + 1))
		) {
			throw new TypeError("Plugin selector is invalid");
		}
		return;
	}
	if (!validPluginName(selector)) throw new TypeError("Plugin selector is invalid");
}

function validPluginName(value: string): boolean {
	return value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value);
}

function validMarketplaceName(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/u.test(value);
}

function withPluginEnablement(settings: UserSettings, pluginId: CodingPluginId, enabled: boolean): UserSettings {
	const entries = pluginEnablementEntries(settings).filter(([id]) => id !== pluginId);
	entries.push([pluginId, { enabled }]);
	entries.sort(([left], [right]) => compareText(left, right));
	return Object.freeze({
		...settings,
		plugins: Object.freeze(
			Object.fromEntries(entries.map(([id, entry]) => [id, Object.freeze({ enabled: entry.enabled })])),
		),
	});
}

function withoutPluginEnablement(settings: UserSettings, pluginId: CodingPluginId): UserSettings {
	const entries = pluginEnablementEntries(settings)
		.filter(([id]) => id !== pluginId)
		.sort(([left], [right]) => compareText(left, right));
	return Object.freeze({
		...settings,
		plugins: Object.freeze(
			Object.fromEntries(entries.map(([id, entry]) => [id, Object.freeze({ enabled: entry.enabled })])),
		),
	});
}

function pluginEnablementEntries(settings: UserSettings): [string, { readonly enabled: boolean }][] {
	const entries: [string, { readonly enabled: boolean }][] = [];
	for (const [pluginId, entry] of Object.entries(settings.plugins ?? {})) {
		if (entry) entries.push([pluginId, entry]);
	}
	return entries;
}

async function normalizeMarketplaceAddInput(
	input: CodingPluginMarketplaceAddInput,
	baseDirectory: string,
	fileSystem: FileSystem,
): Promise<AddCodingPluginMarketplaceInput> {
	if (!input || typeof input !== "object" || typeof input.source !== "string") {
		throw new TypeError("Plugin Marketplace source is required");
	}
	if (input.source === "local" && "root" in input) {
		await assertNonLegacyCanonicalPath(fileSystem, input.root, "Plugin Marketplace root");
		return input as AddCodingPluginMarketplaceInput;
	}
	if (input.source === "git" && "url" in input) {
		return protectMarketplaceGitSource(input as Extract<AddCodingPluginMarketplaceInput, { source: "git" }>);
	}
	const location = input.source;
	const ref = "ref" in input ? input.ref : undefined;
	const sparse = "sparse" in input ? input.sparse : undefined;
	const signal = "signal" in input ? input.signal : undefined;
	if (/^npm(?::|:\/\/)/iu.test(location)) {
		throw new Error("npm Plugin Marketplace sources are unsupported");
	}
	if (isAbsolute(location) || location.startsWith("./") || location.startsWith("../")) {
		if (ref !== undefined || (sparse?.length ?? 0) > 0) {
			throw new Error("Local Plugin Marketplace sources do not accept Git ref or sparse options");
		}
		const root = resolve(baseDirectory, location);
		await assertNonLegacyCanonicalPath(fileSystem, root, "Plugin Marketplace root");
		return { source: "local", root, ...(signal ? { signal } : {}) };
	}
	if (/^(?:https|ssh):\/\//u.test(location)) {
		return protectMarketplaceGitSource({
			source: "git",
			url: location,
			...(ref !== undefined ? { ref } : {}),
			...(sparse !== undefined ? { sparse } : {}),
			...(signal ? { signal } : {}),
		});
	}
	const localCandidate = resolve(baseDirectory, location);
	try {
		if ((await fileSystem.lstat(localCandidate)).kind === "directory") {
			await assertNonLegacyCanonicalPath(fileSystem, localCandidate, "Plugin Marketplace root");
			if (ref !== undefined || (sparse?.length ?? 0) > 0) {
				throw new Error("Local Plugin Marketplace sources do not accept Git ref or sparse options");
			}
			return { source: "local", root: localCandidate, ...(signal ? { signal } : {}) };
		}
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	const repository =
		/^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)(?:@(.+))?$/u.exec(
			location,
		);
	if (!repository?.[1] || !repository[2]) {
		throw new Error("Plugin Marketplace source must be a local path, owner/repository, HTTPS URL, or SSH URL");
	}
	const embeddedRef = repository[3];
	if (embeddedRef && ref && embeddedRef !== ref) {
		throw new Error("Plugin Marketplace source ref conflicts with the explicit ref option");
	}
	const repositoryName = repository[2].endsWith(".git") ? repository[2] : `${repository[2]}.git`;
	const resolvedRef = embeddedRef ?? ref;
	return protectMarketplaceGitSource({
		source: "git",
		url: `https://github.com/${repository[1]}/${repositoryName}`,
		...(resolvedRef !== undefined ? { ref: resolvedRef } : {}),
		...(sparse !== undefined ? { sparse } : {}),
		...(signal ? { signal } : {}),
	});
}

function protectMarketplaceGitSource(
	input: Extract<AddCodingPluginMarketplaceInput, { source: "git" }>,
): Extract<AddCodingPluginMarketplaceInput, { source: "git" }> {
	const requested = input.sparse ?? [];
	for (const path of requested) {
		if (hasLegacyPluginDirectoryComponent(path)) {
			throw new Error('Plugin Marketplace sparse paths must not select ".codex-plugin" content');
		}
	}
	const sparse = [...requested];
	if (sparse.length === 0) sparse.push("*");
	for (const exclusion of [
		"!**/.codex-plugin",
		"!**/.codex-plugin/**",
		`!**/${LEGACY_PLUGIN_DIRECTORY_CASE_FOLD_GLOB}`,
		`!**/${LEGACY_PLUGIN_DIRECTORY_CASE_FOLD_GLOB}/**`,
	] as const) {
		if (!sparse.includes(exclusion)) sparse.push(exclusion);
	}
	return {
		...input,
		sparse: Object.freeze(sparse),
	};
}

const LEGACY_PLUGIN_DIRECTORY = ".codex-plugin";
const LEGACY_PLUGIN_DIRECTORY_CASE_FOLD_GLOB = ".[cC][oO][dD][eE][xX]-[pP][lL][uU][gG][iI][nN]";

function isLegacyPluginDirectoryName(name: string): boolean {
	return name.toLowerCase() === LEGACY_PLUGIN_DIRECTORY;
}

function hasLegacyPluginDirectoryComponent(path: string): boolean {
	return path.split(/[\\/]/u).some(isLegacyPluginDirectoryName);
}

function assertNonLegacyPath(path: string, label: string): void {
	if (hasLegacyPluginDirectoryComponent(resolve(path))) {
		throw new Error(`${label} must not resolve through a reserved .codex-plugin path`);
	}
}

async function assertNonLegacyCanonicalPath(fileSystem: FileSystem, path: string, label: string): Promise<void> {
	assertNonLegacyPath(path, label);
	assertNonLegacyPath(await fileSystem.realpath(path), label);
}

function validateRemotePluginSource(
	source: Exclude<CodingPluginMarketplaceSource, { readonly source: "local" }>,
): Exclude<CodingPluginMarketplaceSource, { readonly source: "local" }> {
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		throw new Error("Remote Plugin Git URL is invalid");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "ssh:") ||
		!url.hostname ||
		url.password ||
		(url.protocol === "https:" && url.username) ||
		url.search ||
		url.hash ||
		url.pathname === "/"
	) {
		throw new Error("Remote Plugin Git URL is invalid");
	}
	for (const segment of url.pathname.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			throw new Error("Remote Plugin Git URL is invalid");
		}
		if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
			throw new Error("Remote Plugin Git URL is invalid");
		}
	}
	let path: string | undefined;
	if (source.path !== undefined) {
		if (
			typeof source.path !== "string" ||
			source.path.length === 0 ||
			source.path.trim() !== source.path ||
			source.path.includes("\\") ||
			posix.isAbsolute(source.path)
		) {
			throw new Error("Remote Plugin package path is invalid");
		}
		path = posix.normalize(source.path);
		if (path === "." || path === ".." || path.startsWith("../") || hasLegacyPluginDirectoryComponent(path)) {
			throw new Error("Remote Plugin package path is invalid");
		}
	}
	if (source.source === "git-subdir" && !path) throw new Error("Remote Plugin git-subdir path is required");
	if (source.ref !== undefined && !validGitRef(source.ref)) throw new Error("Remote Plugin Git ref is invalid");
	if (source.sha !== undefined && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u.test(source.sha)) {
		throw new Error("Remote Plugin Git SHA is invalid");
	}
	url.pathname = url.pathname.replace(/\/+$/u, "");
	return Object.freeze({
		source: source.source,
		url: url.toString(),
		...(path ? { path } : {}),
		...(source.ref ? { ref: source.ref } : {}),
		...(source.sha ? { sha: source.sha.toLowerCase() } : {}),
	});
}

function validGitRef(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 255 &&
		value.trim() === value &&
		!value.startsWith("-") &&
		![...value].some((character) => character.charCodeAt(0) <= 0x20 || "~^:?*[\\".includes(character)) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.includes("//") &&
		!value.endsWith("/") &&
		!value.endsWith(".") &&
		!value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))
	);
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "-");
	if (!safe || safe === "." || safe === ".." || safe.length > 128) {
		throw new Error("IdGenerator returned an invalid Plugin staging identity");
	}
	return safe;
}

function assertSafeEntryName(name: string): void {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`Plugin staging contains an unsafe path entry: ${JSON.stringify(name)}`);
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === "ENOENT";
}
