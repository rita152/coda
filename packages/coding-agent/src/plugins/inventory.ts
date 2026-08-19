import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { createPlugins, type PluginSnapshot } from "@coda/plugins";
import type { FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import type {
	CodingPlugin,
	CodingPluginDiagnostic,
	CodingPluginMcpDefinitionEntry,
	CodingPluginMcpDefinitionsSnapshot,
	CodingPluginMcpDiagnostic,
	CodingPluginMcpSource,
	CodingPluginOrigin,
	CodingPluginScope,
	CodingPluginsManager,
	CodingPluginsSnapshot,
} from "./types.ts";

const WORKSPACE_SKILL_PRIORITY = 1;
const USER_SKILL_PRIORITY = 3;
export const DEFAULT_MAX_CODING_PLUGIN_SLOTS = 256;

export interface DiscoverCodingPluginsOptions {
	readonly workspace: string;
	readonly userHome: string;
	readonly dataRoot: string;
	readonly fileSystem: FileSystem;
	readonly maxPluginSlots?: number;
	readonly signal?: AbortSignal;
}

export interface MaterializeCodingPluginMcpDefinitionsOptions {
	readonly sources: readonly CodingPluginMcpSource[];
	readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
	readonly reservedServerIds?: readonly string[];
	readonly signal?: AbortSignal;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
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

async function installedSlots(fileSystem: FileSystem, root: string): Promise<readonly string[]> {
	try {
		return Object.freeze(
			(await fileSystem.readDirectory(root))
				.filter(({ kind }) => kind === "directory" || kind === "symbolic-link")
				.map(({ name }) => name)
				.sort(compareText),
		);
	} catch (error) {
		if (["ENOENT", "ENOTDIR", "EACCES"].some((code) => isFileSystemError(error, code))) return Object.freeze([]);
		throw error;
	}
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

function dataDirectoryFor(dataRoot: string, origin: CodingPluginOrigin): string {
	const identity = `${origin.scope}\0${origin.root}`;
	const installedInstance = createHash("sha256").update(identity).digest("hex").slice(0, 24);
	return join(dataRoot, installedInstance);
}

function mcpServerId(origin: CodingPluginOrigin, serverName: string): string {
	const identity = `${origin.scope}\0${origin.root}\0${serverName}`;
	return `plugin_${createHash("sha256").update(identity).digest("hex").slice(0, 56)}`;
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
					id: mcpServerId(plugin.origin, server.name),
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
	const [workspaceSlots, userSlots] = await Promise.all([
		installedSlots(options.fileSystem, workspaceRoot),
		installedSlots(options.fileSystem, userRoot),
	]);
	const workspaceSet = new Set(workspaceSlots);
	const userSet = new Set(userSlots);
	const allSlots = [...new Set([...workspaceSlots, ...userSlots])].sort(compareText);
	const slots = allSlots.slice(0, maxPluginSlots);
	const inventoryDiagnostics: CodingPluginDiagnostic[] = [];
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
	const plugins: CodingPlugin[] = [];
	const snapshots: Awaited<ReturnType<typeof loader.load>>[] = [];
	for (const slot of slots) {
		options.signal?.throwIfAborted();
		let selected: Awaited<ReturnType<typeof loader.load>> | undefined;
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
			const origin = originFor("workspace", slot, root, pluginRoot);
			if (outsideWorkspace) {
				selected = outsideWorkspaceSnapshot(root, origin);
			} else {
				selected = await loader.load({
					root: pluginRoot,
					origin,
					...(options.signal ? { signal: options.signal } : {}),
				});
				if (
					selected.status === "loaded" &&
					(!isContained(canonicalWorkspace, selected.root) || relative(pluginRoot, selected.root) !== "")
				) {
					selected = outsideWorkspaceSnapshot(root, origin);
				}
			}
			snapshots.push(selected);
		}
		if ((!selected || selected.status === "rejected") && userSet.has(slot)) {
			const root = join(userRoot, slot);
			let pluginRoot = root;
			try {
				pluginRoot = await options.fileSystem.realpath(root);
			} catch {
				// The portable loader owns the diagnostic for missing, broken, or invalid Plugin roots.
			}
			selected = await loader.load({
				root: pluginRoot,
				origin: originFor("user", slot, root, pluginRoot),
				...(options.signal ? { signal: options.signal } : {}),
			});
			snapshots.push(selected);
		}
		if (selected?.status !== "loaded") continue;
		plugins.push(
			Object.freeze({
				slot,
				origin: selected.origin,
				dataDirectory: dataDirectoryFor(options.dataRoot, selected.origin),
				snapshot: selected,
			}),
		);
	}
	const mcpSources = plugins.flatMap((plugin) => {
		const source = mcpSourceFor(plugin, options.workspace);
		return source ? [source] : [];
	});
	return Object.freeze({
		plugins: Object.freeze(plugins),
		snapshots: Object.freeze(snapshots),
		skills: Object.freeze(plugins.map(({ snapshot }) => snapshot.skills)),
		mcpSources: Object.freeze(mcpSources),
		diagnostics: Object.freeze([...inventoryDiagnostics, ...snapshots.flatMap(({ diagnostics }) => diagnostics)]),
	});
}

/** Serializes rescans so a later trigger can never be overwritten by an older completion. */
export function createCodingPluginsManager(options: DiscoverCodingPluginsOptions): CodingPluginsManager {
	let current: CodingPluginsSnapshot | undefined;
	let tail: Promise<void> = Promise.resolve();
	return Object.freeze({
		get current() {
			return current;
		},
		refresh: () => {
			const operation = tail
				.then(() => discoverCodingPlugins(options))
				.then((snapshot) => {
					current = snapshot;
					return snapshot;
				});
			tail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	});
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
