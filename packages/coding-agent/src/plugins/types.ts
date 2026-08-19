import type { McpServerDefinition } from "@coda/mcp";
import type { LoadedPluginSnapshot, PluginDiagnostic, PluginSnapshot } from "@coda/plugins";
import type { SkillsSnapshot } from "@coda/skills";

export type CodingPluginScope = "workspace" | "user";

export interface CodingPluginOrigin {
	readonly scope: CodingPluginScope;
	readonly slot: string;
	readonly root: string;
	readonly pluginRoot: string;
	readonly priority: number;
	readonly sourceLabel: string;
	readonly kind: "plugin";
}

export interface CodingPlugin {
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

export type CodingPluginDiagnostic = PluginDiagnostic<CodingPluginOrigin> | CodingPluginInventoryDiagnostic;

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
	readonly plugins: readonly CodingPlugin[];
	readonly snapshots: readonly PluginSnapshot<CodingPluginOrigin>[];
	readonly skills: readonly SkillsSnapshot<CodingPluginOrigin>[];
	readonly mcpSources: readonly CodingPluginMcpSource[];
	readonly diagnostics: readonly CodingPluginDiagnostic[];
}

export interface CodingPluginsManager {
	readonly current: CodingPluginsSnapshot | undefined;
	refresh(): Promise<CodingPluginsSnapshot>;
}
