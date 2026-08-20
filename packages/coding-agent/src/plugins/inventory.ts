import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { createPlugins, type LoadedPluginSnapshot, type PluginDiagnostic, type PluginSnapshot } from "@coda/plugins";
import type {
	SkillActivationOptions,
	SkillActivationResult,
	SkillCandidate,
	SkillDiagnostic,
	SkillId,
	SkillsSnapshot,
} from "@coda/skills";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type {
	CodingPluginInstallationRecord,
	CodingPluginInstallationStore,
	CodingPluginInstallationVerification,
} from "./installation-store.ts";
import { pathHasComponent, resolvePluginTreeEntry } from "./package-tree.ts";
import type {
	CodingPlugin,
	CodingPluginDiagnostic,
	CodingPluginId,
	CodingPluginLocalSource,
	CodingPluginMcpDefinitionEntry,
	CodingPluginMcpDefinitionsSnapshot,
	CodingPluginMcpDiagnostic,
	CodingPluginMcpSource,
	CodingPluginOrigin,
	CodingPluginScope,
	CodingPluginsManager,
	CodingPluginsRefreshOptions,
	CodingPluginsSnapshot,
	PluginEnablementSettings,
} from "./types.ts";
import { isCodingPluginLocalSource } from "./types.ts";

const WORKSPACE_SKILL_PRIORITY = 1;
const USER_SKILL_PRIORITY = 3;
const MAX_DIRECT_PLUGIN_FILES = 10_000;
const MAX_DIRECT_PLUGIN_BYTES = 100 * 1024 * 1024;
const MAX_DIRECT_PLUGIN_DEPTH = 32;
export const DEFAULT_MAX_CODING_PLUGIN_SLOTS = 256;

export interface DiscoverCodingPluginsOptions {
	readonly workspace: string;
	readonly userHome: string;
	readonly dataRoot: string;
	readonly fileSystem: FileSystem;
	readonly enablement?: PluginEnablementSettings;
	readonly managedInstallations?: readonly CodingPluginInstallationRecord[];
	readonly managedInstallationVerifications?: readonly CodingPluginInstallationVerification[];
	readonly verifyManagedInstallation?: CodingPluginInstallationStore["verify"];
	readonly maxPluginSlots?: number;
	readonly signal?: AbortSignal;
}

export interface MaterializeCodingPluginMcpDefinitionsOptions {
	readonly sources: readonly CodingPluginMcpSource[];
	readonly dataRoot?: string;
	readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
	readonly reservedServerIds?: readonly string[];
	readonly signal?: AbortSignal;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameInstallationRecord(left: CodingPluginInstallationRecord, right: CodingPluginInstallationRecord): boolean {
	return (
		left.pluginId === right.pluginId &&
		left.name === right.name &&
		left.marketplace === right.marketplace &&
		left.version === right.version &&
		left.digest === right.digest &&
		left.revision === right.revision &&
		left.selectedRoot === right.selectedRoot &&
		JSON.stringify(left.source) === JSON.stringify(right.source)
	);
}

function comparePluginPrecedence(left: CodingPlugin, right: CodingPlugin): number {
	return (
		pluginPrecedence(left) - pluginPrecedence(right) ||
		compareText(left.installationId, right.installationId) ||
		compareText(left.slot, right.slot)
	);
}

function pluginPrecedence(plugin: CodingPlugin): number {
	if (plugin.origin.scope === "workspace") return 0;
	if (plugin.source === "user-local") return 1;
	return 2;
}

function comparePluginPresentation(left: CodingPlugin, right: CodingPlugin): number {
	return (
		compareText(left.snapshot.manifest.name, right.snapshot.manifest.name) ||
		compareText(left.installationId, right.installationId) ||
		compareText(left.slot, right.slot)
	);
}

function compareInstallationCandidate(left: CodingPlugin, right: CodingPlugin): number {
	return compareText(left.installationId, right.installationId) || compareText(left.slot, right.slot);
}

function isContained(root: string, target: string): boolean {
	const fromRoot = relative(root, target);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function outsideWorkspaceSnapshot(root: string, origin: CodingPluginOrigin): PluginSnapshot<CodingPluginOrigin> {
	const entry = Object.freeze({
		code: "workspace-plugin-root-outside-boundary",
		severity: "error" as const,
		phase: "discover" as const,
		message: "Workspace Plugin root resolves outside the Workspace boundary",
		path: root,
		pluginRoot: root,
		origin,
	});
	return Object.freeze({
		status: "rejected" as const,
		requestedRoot: root,
		origin,
		diagnostics: Object.freeze([entry]),
	});
}

function rejectedDirectContentSnapshot(
	snapshot: LoadedPluginSnapshot<CodingPluginOrigin>,
	failure: unknown,
): PluginSnapshot<CodingPluginOrigin> {
	return Object.freeze({
		status: "rejected" as const,
		requestedRoot: snapshot.requestedRoot,
		origin: snapshot.origin,
		diagnostics: Object.freeze([
			Object.freeze({
				code: "plugin-content-digest-failed",
				severity: "error" as const,
				phase: "discover" as const,
				message: `Could not identify direct Plugin content safely: ${failure instanceof Error ? failure.message : String(failure)}`,
				path: snapshot.root,
				pluginRoot: snapshot.root,
				origin: snapshot.origin,
			}),
		]),
	});
}

interface InstalledSlotsSnapshot {
	readonly slots: readonly string[];
	readonly unsupportedCanonicalRoot?: string;
}

async function installedSlots(fileSystem: FileSystem, root: string): Promise<InstalledSlotsSnapshot> {
	if (isLegacyCodexPluginRoot(root)) {
		return Object.freeze({ slots: Object.freeze([]), unsupportedCanonicalRoot: root });
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = await fileSystem.realpath(root);
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EACCES"].some((code) => isFileSystemError(error, code))) {
			return Object.freeze({ slots: Object.freeze([]) });
		}
		throw error;
	}
	if (isLegacyCodexPluginRoot(canonicalRoot)) {
		return Object.freeze({ slots: Object.freeze([]), unsupportedCanonicalRoot: canonicalRoot });
	}
	try {
		return Object.freeze({
			slots: Object.freeze(
				(await fileSystem.readDirectory(canonicalRoot))
					.filter(({ kind }) => kind === "directory" || kind === "symbolic-link")
					.map(({ name }) => name)
					.filter((name) => name.toLowerCase() !== ".codex-plugin")
					.sort(compareText),
			),
		});
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EACCES"].some((code) => isFileSystemError(error, code))) {
			return Object.freeze({ slots: Object.freeze([]) });
		}
		throw error;
	}
}

function isLegacyCodexPluginRoot(path: string): boolean {
	return pathHasComponent(path, ".codex-plugin");
}

function originFor(scope: CodingPluginScope, slot: string, root: string, pluginRoot: string): CodingPluginOrigin {
	return Object.freeze({
		scope,
		slot,
		root,
		pluginRoot,
		priority: scope === "workspace" ? WORKSPACE_SKILL_PRIORITY : USER_SKILL_PRIORITY,
		sourceLabel: scope === "workspace" ? `./.agents/plugins/${slot}` : `~/.agents/plugins/${slot}`,
		kind: "plugin" as const,
	});
}

function managedOriginFor(installation: CodingPluginInstallationRecord, pluginRoot: string): CodingPluginOrigin {
	return Object.freeze({
		scope: "user" as const,
		slot: installation.pluginId,
		installationId: installation.pluginId,
		pluginName: installation.name,
		root: installation.selectedRoot,
		pluginRoot,
		priority: USER_SKILL_PRIORITY,
		sourceLabel: installation.pluginId,
		kind: "plugin" as const,
	});
}

function rejectedManagedInstallation(
	installation: CodingPluginInstallationRecord,
	origin: CodingPluginOrigin,
	code: string,
	message: string,
): PluginSnapshot<CodingPluginOrigin> {
	return Object.freeze({
		status: "rejected" as const,
		requestedRoot: installation.selectedRoot,
		origin,
		diagnostics: Object.freeze([
			Object.freeze({
				code,
				severity: "error" as const,
				phase: "discover" as const,
				message,
				path: installation.selectedRoot,
				pluginRoot: origin.pluginRoot,
				origin,
			}),
		]),
	});
}

function localSourceFor(scope: CodingPluginScope): CodingPluginLocalSource {
	return scope === "workspace" ? "workspace-local" : "user-local";
}

function installationIdFor(pluginName: string, source: CodingPluginLocalSource): CodingPluginId {
	return `${pluginName}@${source}`;
}

function dataDirectoryFor(dataRoot: string, instanceKey: string): string {
	const installedInstance = createHash("sha256").update(instanceKey).digest("hex").slice(0, 24);
	return join(dataRoot, installedInstance);
}

async function directPluginContentDigest(fileSystem: FileSystem, root: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	const accounting = { files: 0, bytes: 0 };
	await hashDirectPluginDirectory(fileSystem, root, root, "", 0, accounting, hash, new Set([root]), signal);
	return hash.digest("hex");
}

async function hashDirectPluginDirectory(
	fileSystem: FileSystem,
	canonicalRoot: string,
	root: string,
	relativeDirectory: string,
	depth: number,
	accounting: { files: number; bytes: number },
	hash: ReturnType<typeof createHash>,
	ancestorDirectories: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<void> {
	const entries = [...(await fileSystem.readDirectory(root))].sort((left, right) =>
		compareText(left.name, right.name),
	);
	for (const entry of entries) {
		signal?.throwIfAborted();
		// Reserved legacy content is outside the Agent Plugins package and must never be probed.
		if (entry.name.toLowerCase() === ".codex-plugin") continue;
		if (
			!entry.name ||
			entry.name === "." ||
			entry.name === ".." ||
			entry.name.includes("/") ||
			entry.name.includes("\\")
		) {
			throw new Error(`Plugin package contains an unsafe path entry: ${JSON.stringify(entry.name)}`);
		}
		const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
		if (depth + 1 > MAX_DIRECT_PLUGIN_DEPTH) {
			throw new Error(`Plugin package exceeds the maximum content depth of ${MAX_DIRECT_PLUGIN_DEPTH}`);
		}
		const path = join(root, entry.name);
		const resolved = await resolvePluginTreeEntry({
			fileSystem,
			canonicalRoot,
			path,
			relativePath,
			ancestorDirectories,
			followSymbolicLinks: true,
			reservedCanonicalComponents: new Set([".codex-plugin"]),
		});
		const { status } = resolved;
		if (status.kind === "directory") {
			updateDirectPluginDigest(hash, "directory", relativePath, new Uint8Array(), status.mode);
			await hashDirectPluginDirectory(
				fileSystem,
				canonicalRoot,
				resolved.path,
				relativePath,
				depth + 1,
				accounting,
				hash,
				new Set([...ancestorDirectories, resolved.path]),
				signal,
			);
			continue;
		}
		if (status.kind !== "file") throw new Error(`Plugin package contains an unsafe entry: ${relativePath}`);
		accounting.files++;
		if (accounting.files > MAX_DIRECT_PLUGIN_FILES) {
			throw new Error(`Plugin package exceeds the maximum file count of ${MAX_DIRECT_PLUGIN_FILES}`);
		}
		if (status.size > MAX_DIRECT_PLUGIN_BYTES - accounting.bytes) {
			throw new Error(`Plugin package exceeds the maximum byte count of ${MAX_DIRECT_PLUGIN_BYTES}`);
		}
		const bytes = await fileSystem.readFile(resolved.path);
		accounting.bytes += bytes.byteLength;
		if (accounting.bytes > MAX_DIRECT_PLUGIN_BYTES) {
			throw new Error(`Plugin package exceeds the maximum byte count of ${MAX_DIRECT_PLUGIN_BYTES}`);
		}
		updateDirectPluginDigest(hash, "file", relativePath, bytes, status.mode);
	}
}

function updateDirectPluginDigest(
	hash: ReturnType<typeof createHash>,
	kind: "directory" | "file",
	path: string,
	bytes: Uint8Array = new Uint8Array(),
	mode = 0,
): void {
	const encodedPath = new TextEncoder().encode(path);
	hash.update(Uint8Array.of(kind === "directory" ? 0 : 1));
	const encodedMode = new Uint8Array(2);
	new DataView(encodedMode.buffer).setUint16(0, mode & 0o777, false);
	hash.update(encodedMode);
	hash.update(digestLengthBytes(encodedPath.byteLength));
	hash.update(encodedPath);
	hash.update(digestLengthBytes(bytes.byteLength));
	hash.update(bytes);
}

function digestLengthBytes(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function workspacePluginInstanceKey(canonicalWorkspace: string, installationId: CodingPluginId): string {
	return `workspace-local\0${canonicalWorkspace}\0${installationId}`;
}

function mcpServerId(pluginName: string, serverName: string): string {
	const rawIdentity = `plugin_${pluginName}_${serverName}`;
	const identity = rawIdentity.toLowerCase();
	if (rawIdentity === identity && identity.length <= 64 && /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u.test(identity)) {
		return identity;
	}
	// Raw identities always begin with `plugin_`, so the `p_` domain cannot be
	// occupied by a valid raw sibling. Hash the original case-sensitive tuple,
	// not its display normalization, to preserve distinct semantic identities.
	const hash = createHash("sha256")
		.update(`coda-agent-plugin-mcp-server-id-v2\0${pluginName}\0${serverName}`)
		.digest("hex")
		.slice(0, 62);
	return `p_${hash}`;
}

function identifiedSkillDiagnostic(
	diagnostic: SkillDiagnostic<CodingPluginOrigin>,
	origin: CodingPluginOrigin,
): SkillDiagnostic<CodingPluginOrigin> {
	return Object.freeze({ ...diagnostic, ...(diagnostic.origin ? { origin } : {}) });
}

function identifiedPluginDiagnostic(
	diagnostic: PluginDiagnostic<CodingPluginOrigin>,
	origin: CodingPluginOrigin,
): PluginDiagnostic<CodingPluginOrigin> {
	return Object.freeze({ ...diagnostic, origin });
}

function identifiedSkillCandidate(
	candidate: SkillCandidate<CodingPluginOrigin>,
	origin: CodingPluginOrigin,
): SkillCandidate<CodingPluginOrigin> {
	return Object.freeze({
		...candidate,
		id: stablePluginSkillId(origin.pluginName!, candidate.metadata.name),
		provenance: Object.freeze(candidate.provenance.map((entry) => Object.freeze({ ...entry, origin }))),
		diagnostics: Object.freeze(candidate.diagnostics.map((entry) => identifiedSkillDiagnostic(entry, origin))),
	});
}

function stablePluginSkillId(pluginName: string, skillName: string): SkillId {
	const identity = `coda-agent-plugin-skill-id-v1\0${pluginName}\0${skillName}`;
	return `skill:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}` as SkillId;
}

function identifyLoadedPlugin(
	snapshot: LoadedPluginSnapshot<CodingPluginOrigin>,
): LoadedPluginSnapshot<CodingPluginOrigin> {
	const origin = Object.freeze({
		...snapshot.origin,
		installationId:
			snapshot.origin.installationId ??
			installationIdFor(snapshot.manifest.name, localSourceFor(snapshot.origin.scope)),
		pluginName: snapshot.manifest.name,
	});
	const identifiedCandidates = snapshot.skills.candidates.map((candidate) =>
		Object.freeze({ originalId: candidate.id, candidate: identifiedSkillCandidate(candidate, origin) }),
	);
	const candidates = Object.freeze(identifiedCandidates.map(({ candidate }) => candidate));
	const originalIdByStableId = new Map(
		identifiedCandidates.map(({ originalId, candidate }) => [candidate.id, originalId] as const),
	);
	const candidateByOriginalId = new Map(
		identifiedCandidates.map(({ originalId, candidate }) => [originalId, candidate] as const),
	);
	const skills: SkillsSnapshot<CodingPluginOrigin> = Object.freeze({
		candidates,
		diagnostics: Object.freeze(snapshot.skills.diagnostics.map((entry) => identifiedSkillDiagnostic(entry, origin))),
		activate: async (
			id: SkillId,
			options?: SkillActivationOptions,
		): Promise<SkillActivationResult<CodingPluginOrigin>> => {
			const result = await snapshot.skills.activate(originalIdByStableId.get(id) ?? id, options);
			const diagnostics = Object.freeze(result.diagnostics.map((entry) => identifiedSkillDiagnostic(entry, origin)));
			if (!result.ok) {
				return Object.freeze({
					ok: false as const,
					diagnostic: identifiedSkillDiagnostic(result.diagnostic, origin),
					diagnostics,
				});
			}
			return Object.freeze({
				ok: true as const,
				activation: Object.freeze({
					...result.activation,
					candidate:
						candidateByOriginalId.get(result.activation.candidate.id) ??
						identifiedSkillCandidate(result.activation.candidate, origin),
					diagnostics: Object.freeze(
						result.activation.diagnostics.map((entry) => identifiedSkillDiagnostic(entry, origin)),
					),
				}),
				diagnostics,
			});
		},
	});
	return Object.freeze({
		...snapshot,
		origin,
		skills,
		mcpServers: Object.freeze(snapshot.mcpServers.map((server) => Object.freeze({ ...server, origin }))),
		diagnostics: Object.freeze(snapshot.diagnostics.map((entry) => identifiedPluginDiagnostic(entry, origin))),
		materializeMcp: async (options: Parameters<typeof snapshot.materializeMcp>[0]) => {
			const materialized = await snapshot.materializeMcp(options);
			return Object.freeze({
				servers: Object.freeze(materialized.servers.map((server) => Object.freeze({ ...server, origin }))),
				diagnostics: Object.freeze(
					materialized.diagnostics.map((entry) => identifiedPluginDiagnostic(entry, origin)),
				),
			});
		},
	});
}

function mcpSourceFor(plugin: CodingPlugin, workspace: string): CodingPluginMcpSource | undefined {
	const configuration = plugin.snapshot.mcpConfiguration;
	if (!configuration) return undefined;
	return Object.freeze({
		plugin,
		path: configuration.path,
		sha256: configuration.sha256,
		requiresWorkspaceTrust: plugin.origin.scope === "workspace",
		...(plugin.origin.scope === "workspace"
			? {
					trustSource: Object.freeze({
						workspace,
						path: configuration.path,
						sha256: configuration.sha256,
					}),
				}
			: {}),
		servers: Object.freeze(
			plugin.snapshot.mcpServers.map((server) =>
				Object.freeze({
					id: mcpServerId(plugin.snapshot.manifest.name, server.name),
					name: server.name,
					type: server.configuration.type,
				}),
			),
		),
	});
}

export async function discoverCodingPlugins(options: DiscoverCodingPluginsOptions): Promise<CodingPluginsSnapshot> {
	if (!options || !options.fileSystem) throw new TypeError("fileSystem is required");
	if (![options.workspace, options.userHome, options.dataRoot].every(isAbsolute)) {
		throw new TypeError("Workspace, user home, and Plugin data root must be absolute");
	}
	options.signal?.throwIfAborted();
	const maxPluginSlots = options.maxPluginSlots ?? DEFAULT_MAX_CODING_PLUGIN_SLOTS;
	if (!Number.isSafeInteger(maxPluginSlots) || maxPluginSlots <= 0) {
		throw new TypeError("maxPluginSlots must be a positive safe integer");
	}
	const workspaceRoot = join(options.workspace, ".agents", "plugins");
	const userRoot = join(options.userHome, ".agents", "plugins");
	const canonicalWorkspace = await options.fileSystem.realpath(options.workspace);
	const [workspaceSlotDiscovery, userSlotDiscovery] = await Promise.all([
		installedSlots(options.fileSystem, workspaceRoot),
		installedSlots(options.fileSystem, userRoot),
	]);
	const workspaceSlots = workspaceSlotDiscovery.slots;
	const userSlots = userSlotDiscovery.slots;
	const workspaceSet = new Set(workspaceSlots);
	const userSet = new Set(userSlots);
	const allSlots = [...new Set([...workspaceSlots, ...userSlots])].sort(compareText);
	const slots = allSlots.slice(0, maxPluginSlots);
	const inventoryDiagnostics: CodingPluginDiagnostic[] = [];
	for (const [scope, root, discovery] of [
		["Workspace", workspaceRoot, workspaceSlotDiscovery],
		["User", userRoot, userSlotDiscovery],
	] as const) {
		if (!discovery.unsupportedCanonicalRoot) continue;
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-discovery-root-unsupported" as const,
				severity: "warning" as const,
				phase: "discover" as const,
				message: `${scope} Agent Plugin discovery was skipped because its root resolves through reserved ".codex-plugin" content; replace the alias or move the root outside that reserved directory`,
				path: root,
			}),
		);
	}
	if (allSlots.length > slots.length) {
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-slot-limit-exceeded" as const,
				severity: "error" as const,
				phase: "discover" as const,
				message: `Plugin discovery exceeds ${maxPluginSlots} installation slots; remaining slots were skipped`,
				path: `${workspaceRoot}; ${userRoot}`,
			}),
		);
	}
	const loader = createPlugins<CodingPluginOrigin>({ fileSystem: options.fileSystem });
	const candidates: CodingPlugin[] = [];
	const snapshots: PluginSnapshot<CodingPluginOrigin>[] = [];
	for (const slot of slots) {
		options.signal?.throwIfAborted();
		if (workspaceSet.has(slot)) {
			const root = join(workspaceRoot, slot);
			let pluginRoot = root;
			let outsideWorkspace = false;
			try {
				pluginRoot = await options.fileSystem.realpath(root);
				outsideWorkspace = !isContained(canonicalWorkspace, pluginRoot);
			} catch {
				// The portable loader owns the diagnostic for missing, broken, or invalid Plugin roots.
			}
			if (isLegacyCodexPluginRoot(pluginRoot)) continue;
			const origin = originFor("workspace", slot, root, pluginRoot);
			let snapshot: Awaited<ReturnType<typeof loader.load>>;
			let contentDigest: string | undefined;
			if (outsideWorkspace) {
				snapshot = outsideWorkspaceSnapshot(root, origin);
			} else {
				snapshot = await loader.load({
					root: pluginRoot,
					origin,
					...(options.signal ? { signal: options.signal } : {}),
				});
				if (
					snapshot.status === "loaded" &&
					(!isContained(canonicalWorkspace, snapshot.root) || relative(pluginRoot, snapshot.root) !== "")
				) {
					snapshot = outsideWorkspaceSnapshot(root, origin);
				}
				if (snapshot.status === "loaded") {
					snapshot = identifyLoadedPlugin(snapshot);
					try {
						contentDigest = await directPluginContentDigest(options.fileSystem, snapshot.root, options.signal);
					} catch (error) {
						options.signal?.throwIfAborted();
						snapshot = rejectedDirectContentSnapshot(snapshot, error);
					}
				}
			}
			snapshots.push(snapshot);
			if (snapshot.status === "loaded" && contentDigest) {
				const source = localSourceFor("workspace");
				const installationId = installationIdFor(snapshot.manifest.name, source);
				candidates.push(
					Object.freeze({
						installationId,
						source,
						enabled: options.enablement?.[installationId]?.enabled ?? true,
						contentDigest,
						slot,
						origin: snapshot.origin,
						dataDirectory: dataDirectoryFor(
							options.dataRoot,
							workspacePluginInstanceKey(canonicalWorkspace, installationId),
						),
						snapshot,
					}),
				);
			}
		}
		if (userSet.has(slot)) {
			const root = join(userRoot, slot);
			let pluginRoot = root;
			try {
				pluginRoot = await options.fileSystem.realpath(root);
			} catch {
				// The portable loader owns the diagnostic for missing, broken, or invalid Plugin roots.
			}
			if (isLegacyCodexPluginRoot(pluginRoot)) continue;
			let snapshot = await loader.load({
				root: pluginRoot,
				origin: originFor("user", slot, root, pluginRoot),
				...(options.signal ? { signal: options.signal } : {}),
			});
			let contentDigest: string | undefined;
			if (snapshot.status === "loaded") {
				snapshot = identifyLoadedPlugin(snapshot);
				try {
					contentDigest = await directPluginContentDigest(options.fileSystem, snapshot.root, options.signal);
				} catch (error) {
					options.signal?.throwIfAborted();
					snapshot = rejectedDirectContentSnapshot(snapshot, error);
				}
			}
			snapshots.push(snapshot);
			if (snapshot.status === "loaded" && contentDigest) {
				const source = localSourceFor("user");
				const installationId = installationIdFor(snapshot.manifest.name, source);
				candidates.push(
					Object.freeze({
						installationId,
						source,
						enabled: options.enablement?.[installationId]?.enabled ?? true,
						contentDigest,
						slot,
						origin: snapshot.origin,
						dataDirectory: dataDirectoryFor(options.dataRoot, installationId),
						snapshot,
					}),
				);
			}
		}
	}
	const allManagedInstallations = [...(options.managedInstallations ?? [])].sort(
		(left, right) => compareText(left.pluginId, right.pluginId) || compareText(left.selectedRoot, right.selectedRoot),
	);
	const managedInstallations = allManagedInstallations.slice(0, maxPluginSlots);
	const managedVerifications = new Map(
		(options.managedInstallationVerifications ?? []).map(
			(verification) => [verification.record.pluginId, verification] as const,
		),
	);
	if (allManagedInstallations.length > managedInstallations.length) {
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-slot-limit-exceeded" as const,
				severity: "error" as const,
				phase: "discover" as const,
				message: `Managed Plugin discovery exceeds ${maxPluginSlots} installations; remaining installations were skipped`,
				path: options.dataRoot,
			}),
		);
	}
	for (const installation of managedInstallations) {
		options.signal?.throwIfAborted();
		const origin = managedOriginFor(installation, installation.selectedRoot);
		let snapshot: PluginSnapshot<CodingPluginOrigin> | undefined;
		if (
			!isAbsolute(installation.selectedRoot) ||
			installation.pluginId !== `${installation.name}@${installation.marketplace}`
		) {
			snapshot = rejectedManagedInstallation(
				installation,
				origin,
				"plugin-installation-identity-invalid",
				`Managed Plugin installation "${installation.pluginId}" has inconsistent identity metadata`,
			);
		} else if (isCodingPluginLocalSource(installation.marketplace)) {
			snapshot = rejectedManagedInstallation(
				installation,
				origin,
				"plugin-installation-identity-reserved",
				`Managed Plugin installation "${installation.pluginId}" uses a Marketplace identity reserved for direct installations`,
			);
		} else if (!managedVerifications.has(installation.pluginId) && !options.verifyManagedInstallation) {
			snapshot = rejectedManagedInstallation(
				installation,
				origin,
				"plugin-installation-unverified",
				`Managed Plugin installation "${installation.pluginId}" has no installation-store integrity verifier`,
			);
		} else {
			let verification: Awaited<ReturnType<CodingPluginInstallationStore["verify"]>> | undefined;
			const atomicVerification = managedVerifications.get(installation.pluginId);
			if (atomicVerification && sameInstallationRecord(atomicVerification.record, installation)) {
				verification = atomicVerification;
			} else if (options.verifyManagedInstallation) {
				try {
					verification = await options.verifyManagedInstallation(
						installation,
						options.signal ? { signal: options.signal } : undefined,
					);
				} catch (error) {
					options.signal?.throwIfAborted();
					snapshot = rejectedManagedInstallation(
						installation,
						origin,
						"plugin-installation-verification-failed",
						`Could not verify managed Plugin installation "${installation.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			} else {
				snapshot = rejectedManagedInstallation(
					installation,
					origin,
					"plugin-installation-unverified",
					`Managed Plugin installation "${installation.pluginId}" has no matching installation-store verification`,
				);
			}
			if (snapshot === undefined) {
				if (!verification) throw new Error("Managed Plugin verification returned no result");
				if (verification.status === "rejected") {
					snapshot = rejectedManagedInstallation(installation, origin, verification.code, verification.message);
				} else {
					snapshot = await loader.load({
						root: installation.selectedRoot,
						origin,
						...(options.signal ? { signal: options.signal } : {}),
					});
					if (snapshot.status === "loaded" && snapshot.manifest.name !== installation.name) {
						snapshot = rejectedManagedInstallation(
							installation,
							origin,
							"plugin-installation-manifest-mismatch",
							`Managed Plugin installation "${installation.pluginId}" selected a package declaring manifest name "${snapshot.manifest.name}"`,
						);
					} else if (snapshot.status === "loaded") {
						snapshot = identifyLoadedPlugin(snapshot);
					}
				}
			}
		}
		if (!snapshot) throw new Error("Managed Plugin verification produced no snapshot");
		snapshots.push(snapshot);
		if (snapshot.status !== "loaded") continue;
		candidates.push(
			Object.freeze({
				installationId: installation.pluginId,
				source: installation.marketplace,
				enabled: options.enablement?.[installation.pluginId]?.enabled ?? true,
				contentDigest: installation.digest,
				slot: installation.pluginId,
				origin: snapshot.origin,
				dataDirectory: dataDirectoryFor(options.dataRoot, installation.pluginId),
				snapshot,
			}),
		);
	}
	const installationsById = new Map<CodingPluginId, CodingPlugin>();
	for (const plugin of [...candidates].sort(compareInstallationCandidate)) {
		const selected = installationsById.get(plugin.installationId);
		if (!selected) {
			installationsById.set(plugin.installationId, plugin);
			continue;
		}
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-installation-collision" as const,
				severity: "warning" as const,
				phase: "discover" as const,
				message: `Plugin installation "${plugin.installationId}" is provided by multiple slots; selected ${selected.origin.sourceLabel} and ignored ${plugin.origin.sourceLabel}`,
				path: `${selected.origin.root}; ${plugin.origin.root}`,
				pluginName: plugin.snapshot.manifest.name,
				installationId: plugin.installationId,
			}),
		);
	}
	const installations = [...installationsById.values()].sort(comparePluginPresentation);
	for (const installation of installations) {
		if (installation.enabled) continue;
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-disabled" as const,
				severity: "info" as const,
				phase: "discover" as const,
				message: `Plugin installation "${installation.installationId}" is disabled`,
				path: installation.origin.root,
				pluginName: installation.snapshot.manifest.name,
				installationId: installation.installationId,
			}),
		);
	}
	const selectedByNamespace = new Map<string, CodingPlugin>();
	for (const plugin of [...installations].sort(comparePluginPrecedence)) {
		const pluginName = plugin.snapshot.manifest.name;
		const selected = selectedByNamespace.get(pluginName);
		if (!selected) {
			selectedByNamespace.set(pluginName, plugin);
			continue;
		}
		inventoryDiagnostics.push(
			Object.freeze({
				code: "plugin-namespace-collision" as const,
				severity: "warning" as const,
				phase: "discover" as const,
				message: `Plugin namespace "${pluginName}" is provided by multiple installations; selected ${selected.origin.sourceLabel} and ignored ${plugin.origin.sourceLabel}`,
				path: `${selected.origin.root}; ${plugin.origin.root}`,
				pluginName,
			}),
		);
	}
	const selectedPlugins = [...selectedByNamespace.values()]
		.filter((plugin) => plugin.enabled)
		.sort(comparePluginPresentation);
	const mcpSources = selectedPlugins.flatMap((plugin) => {
		const source = mcpSourceFor(plugin, options.workspace);
		return source ? [source] : [];
	});
	return Object.freeze({
		installations: Object.freeze(installations),
		plugins: Object.freeze(selectedPlugins),
		snapshots: Object.freeze(snapshots),
		skills: Object.freeze(selectedPlugins.map(({ snapshot }) => snapshot.skills)),
		mcpSources: Object.freeze(mcpSources),
		diagnostics: Object.freeze([...inventoryDiagnostics, ...snapshots.flatMap(({ diagnostics }) => diagnostics)]),
	});
}

/** Serializes rescans so a later trigger can never be overwritten by an older completion. */
export function createCodingPluginsManager(options: DiscoverCodingPluginsOptions): CodingPluginsManager {
	let current: CodingPluginsSnapshot | undefined;
	const lastKnownInstallationIds = new Map<string, CodingPluginId>();
	let enablement = options.enablement;
	let managedInstallations = options.managedInstallations;
	let managedInstallationVerifications = options.managedInstallationVerifications;
	const {
		enablement: _initialEnablement,
		managedInstallations: _initialManagedInstallations,
		managedInstallationVerifications: _initialManagedInstallationVerifications,
		...baseOptions
	} = options;
	let tail: Promise<void> = Promise.resolve();
	return Object.freeze({
		get current() {
			return current;
		},
		refresh: (refreshOptions: CodingPluginsRefreshOptions = {}) => {
			if (Object.hasOwn(refreshOptions, "enablement")) enablement = refreshOptions.enablement;
			if (Object.hasOwn(refreshOptions, "managedInstallations")) {
				managedInstallations = refreshOptions.managedInstallations;
			}
			if (Object.hasOwn(refreshOptions, "managedInstallationVerifications")) {
				managedInstallationVerifications = refreshOptions.managedInstallationVerifications;
			}
			const operation = tail
				.then(() =>
					discoverCodingPlugins({
						...baseOptions,
						...(enablement === undefined ? {} : { enablement }),
						...(managedInstallations === undefined ? {} : { managedInstallations }),
						...(managedInstallationVerifications === undefined ? {} : { managedInstallationVerifications }),
					}),
				)
				.then((snapshot) => {
					const identified = retainLastKnownDirectPluginIdentities(snapshot, lastKnownInstallationIds);
					current = identified;
					return identified;
				});
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	});
}

function retainLastKnownDirectPluginIdentities(
	snapshot: CodingPluginsSnapshot,
	lastKnown: Map<string, CodingPluginId>,
): CodingPluginsSnapshot {
	for (const candidate of snapshot.snapshots) {
		if (candidate.origin.installationId) {
			lastKnown.set(directOriginIdentityKey(candidate.origin), candidate.origin.installationId);
		}
	}
	let changed = false;
	const snapshots = snapshot.snapshots.map((candidate) => {
		if (candidate.status !== "rejected" || candidate.origin.installationId) return candidate;
		const installationId = lastKnown.get(directOriginIdentityKey(candidate.origin));
		if (!installationId) return candidate;
		changed = true;
		const separator = installationId.lastIndexOf("@");
		const origin = Object.freeze({
			...candidate.origin,
			installationId,
			pluginName: installationId.slice(0, separator),
		});
		return Object.freeze({
			...candidate,
			origin,
			diagnostics: Object.freeze(
				candidate.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic, origin })),
			),
		});
	});
	if (!changed) return snapshot;
	return Object.freeze({
		...snapshot,
		snapshots: Object.freeze(snapshots),
		diagnostics: Object.freeze([
			...snapshot.diagnostics.filter((diagnostic) => !("origin" in diagnostic)),
			...snapshots.flatMap(({ diagnostics }) => diagnostics),
		]),
	});
}

function directOriginIdentityKey(origin: CodingPluginOrigin): string {
	return `${origin.scope}\0${origin.slot}\0${origin.root}`;
}

export async function materializeCodingPluginMcpDefinitions(
	options: MaterializeCodingPluginMcpDefinitionsOptions,
): Promise<CodingPluginMcpDefinitionsSnapshot> {
	const entries: CodingPluginMcpDefinitionEntry[] = [];
	const diagnostics: CodingPluginMcpDiagnostic[] = [];
	const usedServerIds = new Set(options.reservedServerIds ?? []);
	for (const source of options.sources) {
		options.signal?.throwIfAborted();
		let materialized: Awaited<ReturnType<typeof source.plugin.snapshot.materializeMcp>>;
		try {
			materialized = await source.plugin.snapshot.materializeMcp({
				...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
				dataDirectory: source.plugin.dataDirectory,
				...(options.baseEnvironment ? { baseEnvironment: options.baseEnvironment } : {}),
				platform: options.platform,
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (error) {
			options.signal?.throwIfAborted();
			diagnostics.push(
				Object.freeze({
					code: "plugin-mcp-source-materialization-failed",
					severity: "warning" as const,
					phase: "mcp" as const,
					message: `Could not materialize Plugin MCP source "${source.plugin.snapshot.manifest.name}": ${error instanceof Error ? error.message : String(error)}`,
					pluginRoot: source.plugin.snapshot.root,
					origin: source.plugin.origin,
				}),
			);
			continue;
		}
		diagnostics.push(...materialized.diagnostics);
		for (const server of materialized.servers) {
			const candidate = source.servers.find(({ name }) => name === server.name);
			if (!candidate) continue;
			if (usedServerIds.has(candidate.id)) {
				diagnostics.push(
					Object.freeze({
						code: "plugin-mcp-server-id-collision",
						severity: "warning" as const,
						phase: "mcp" as const,
						message: `Skipped Plugin MCP Server "${server.name}" because id "${candidate.id}" is already in use`,
						pluginRoot: source.plugin.snapshot.root,
						origin: source.plugin.origin,
						serverId: candidate.id,
						serverName: server.name,
					}),
				);
				continue;
			}
			usedServerIds.add(candidate.id);
			const definition = Object.freeze({
				id: candidate.id,
				semanticName: `${source.plugin.snapshot.manifest.name}:${server.name}`,
				// Agent Plugins declares the transport but has no MCP wire-version field.
				// Negotiate across Coda's supported revisions instead of imposing the
				// native stdio default on a portable package.
				protocol: "auto" as const,
				transport: server.transport,
			});
			entries.push(Object.freeze({ source, serverName: server.name, definition }));
		}
	}
	return Object.freeze({
		entries: Object.freeze(entries),
		definitions: Object.freeze(entries.map(({ definition }) => definition)),
		diagnostics: Object.freeze(diagnostics),
	});
}

export type * from "./types.ts";
