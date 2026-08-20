import type { McpServerDefinition } from "@coda/mcp";
import type { LoadedPluginSnapshot, PluginDiagnostic, PluginSnapshot } from "@coda/plugins";
import type { SkillsSnapshot } from "@coda/skills";
import type { CodingPluginInstallationRecord, CodingPluginInstallationVerification } from "./installation-store.ts";

export type CodingPluginScope = "workspace" | "user";
export const CODING_PLUGIN_LOCAL_SOURCES = Object.freeze(["workspace-local", "user-local"] as const);
export type CodingPluginLocalSource = (typeof CODING_PLUGIN_LOCAL_SOURCES)[number];
export type CodingPluginSource = CodingPluginLocalSource | (string & {});
export type CodingPluginId = `${string}@${string}`;

export function isCodingPluginLocalSource(value: unknown): value is CodingPluginLocalSource {
	return value === "workspace-local" || value === "user-local";
}

export interface CodingPluginEnablement {
	readonly enabled: boolean;
}

export type PluginEnablementSettings = Readonly<Partial<Record<CodingPluginId, CodingPluginEnablement>>>;

export interface CodingPluginOrigin {
	readonly scope: CodingPluginScope;
	readonly slot: string;
	readonly installationId?: CodingPluginId;
	readonly pluginName?: string;
	readonly root: string;
	readonly pluginRoot: string;
	readonly priority: number;
	readonly sourceLabel: string;
	readonly kind: "plugin";
}

export interface CodingPlugin {
	readonly installationId: CodingPluginId;
	readonly source: CodingPluginSource;
	readonly enabled: boolean;
	/** Exact, location-independent package content identity, including executable-bit semantics. */
	readonly contentDigest: string;
	readonly slot: string;
	readonly origin: CodingPluginOrigin;
	readonly dataDirectory: string;
	readonly snapshot: LoadedPluginSnapshot<CodingPluginOrigin>;
}

export interface CodingPluginMcpServer {
	readonly id: string;
	readonly name: string;
	readonly type: "stdio" | "streamable-http";
}

export interface CodingPluginMcpTrustSource {
	readonly workspace: string;
	readonly path: string;
	readonly sha256: string;
}

export interface CodingPluginMcpSource {
	readonly plugin: CodingPlugin;
	readonly path: string;
	readonly sha256: string;
	readonly requiresWorkspaceTrust: boolean;
	readonly trustSource?: CodingPluginMcpTrustSource;
	readonly servers: readonly CodingPluginMcpServer[];
}

export interface CodingPluginMcpAdapterDiagnostic {
	readonly code: string;
	readonly severity: "warning" | "error";
	readonly phase: "mcp";
	readonly message: string;
	readonly pluginRoot: string;
	readonly origin: CodingPluginOrigin;
	readonly serverId?: string;
	readonly serverName?: string;
}

export type CodingPluginMcpDiagnostic = PluginDiagnostic<CodingPluginOrigin> | CodingPluginMcpAdapterDiagnostic;

export interface CodingPluginInventoryDiagnostic {
	readonly code: "plugin-slot-limit-exceeded";
	readonly severity: "error";
	readonly phase: "discover";
	readonly message: string;
	readonly path: string;
}

export interface CodingPluginUnsupportedDiscoveryRootDiagnostic {
	readonly code: "plugin-discovery-root-unsupported";
	readonly severity: "warning";
	readonly phase: "discover";
	readonly message: string;
	readonly path: string;
}

export interface CodingPluginNamespaceCollisionDiagnostic {
	readonly code: "plugin-namespace-collision";
	readonly severity: "warning";
	readonly phase: "discover";
	readonly message: string;
	readonly path: string;
	readonly pluginName: string;
}

export interface CodingPluginInstallationCollisionDiagnostic {
	readonly code: "plugin-installation-collision";
	readonly severity: "warning";
	readonly phase: "discover";
	readonly message: string;
	readonly path: string;
	readonly pluginName: string;
	readonly installationId: CodingPluginId;
}

export interface CodingPluginDisabledDiagnostic {
	readonly code: "plugin-disabled";
	readonly severity: "info";
	readonly phase: "discover";
	readonly message: string;
	readonly path: string;
	readonly pluginName: string;
	readonly installationId: CodingPluginId;
}

export type CodingPluginDiagnostic =
	| PluginDiagnostic<CodingPluginOrigin>
	| CodingPluginInventoryDiagnostic
	| CodingPluginUnsupportedDiscoveryRootDiagnostic
	| CodingPluginNamespaceCollisionDiagnostic
	| CodingPluginInstallationCollisionDiagnostic
	| CodingPluginDisabledDiagnostic;

export interface CodingPluginMcpDefinitionEntry {
	readonly source: CodingPluginMcpSource;
	readonly serverName: string;
	readonly definition: McpServerDefinition;
}

export interface CodingPluginMcpDefinitionsSnapshot {
	readonly entries: readonly CodingPluginMcpDefinitionEntry[];
	readonly definitions: readonly McpServerDefinition[];
	readonly diagnostics: readonly CodingPluginMcpDiagnostic[];
}

export interface CodingPluginsSnapshot {
	readonly installations: readonly CodingPlugin[];
	readonly plugins: readonly CodingPlugin[];
	readonly snapshots: readonly PluginSnapshot<CodingPluginOrigin>[];
	readonly skills: readonly SkillsSnapshot<CodingPluginOrigin>[];
	readonly mcpSources: readonly CodingPluginMcpSource[];
	readonly diagnostics: readonly CodingPluginDiagnostic[];
}

export interface CodingPluginsManager {
	readonly current: CodingPluginsSnapshot | undefined;
	refresh(options?: CodingPluginsRefreshOptions): Promise<CodingPluginsSnapshot>;
}

export interface CodingPluginsRefreshOptions {
	readonly enablement?: PluginEnablementSettings;
	readonly managedInstallations?: readonly CodingPluginInstallationRecord[];
	/** Store-owned results computed atomically with managedInstallations. */
	readonly managedInstallationVerifications?: readonly CodingPluginInstallationVerification[];
}
