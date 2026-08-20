import type { McpHttpTransportDefinition, McpStdioTransportDefinition } from "@coda/mcp";
import type { SkillFileSystem, SkillsSnapshot } from "@coda/skills";
import { DEFAULT_SKILL_LIMITS } from "@coda/skills";

export const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export interface PluginLimits {
	readonly maxManifestBytes: number;
	readonly maxMcpConfigurationBytes: number;
	readonly maxSkillComponents: number;
	readonly maxSkillScanEntries: number;
}

export const DEFAULT_PLUGIN_LIMITS: Readonly<PluginLimits> = Object.freeze({
	maxManifestBytes: 256 * 1024,
	maxMcpConfigurationBytes: 1024 * 1024,
	maxSkillComponents: DEFAULT_SKILL_LIMITS.maxSkills,
	maxSkillScanEntries: DEFAULT_SKILL_LIMITS.maxEntries,
});

export interface PluginAuthor {
	readonly name?: string;
	readonly email?: string;
	readonly url?: string;
}

export interface PluginManifest {
	readonly $schema: typeof AGENT_PLUGIN_SCHEMA;
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly author?: PluginAuthor;
	readonly homepage?: string;
	readonly repository?: string;
	readonly license?: string;
	readonly keywords?: readonly string[];
}

export type PluginDiagnosticSeverity = "info" | "warning" | "error";
export type PluginDiagnosticPhase = "manifest" | "discover" | "skill" | "mcp";

export interface PluginDiagnostic<Origin = unknown> {
	readonly code: string;
	readonly severity: PluginDiagnosticSeverity;
	readonly phase: PluginDiagnosticPhase;
	readonly message: string;
	/** Package-local Skill or MCP Server member name, when known structurally. */
	readonly componentName?: string;
	readonly path?: string;
	readonly field?: string;
	readonly pluginRoot: string;
	readonly origin: Origin;
}

export interface PluginMcpStdioConfiguration {
	readonly type: "stdio";
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

export interface PluginMcpHttpConfiguration {
	readonly type: "streamable-http";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface PluginMcpServer<Origin = unknown> {
	readonly name: string;
	readonly pluginName: string;
	readonly pluginRoot: string;
	readonly origin: Origin;
	readonly configuration: PluginMcpStdioConfiguration | PluginMcpHttpConfiguration;
}

export interface PluginMcpConfiguration {
	readonly path: string;
	readonly sha256: string;
}

export interface MaterializedPluginMcpServer<Origin = unknown> {
	readonly name: string;
	readonly pluginName: string;
	readonly pluginRoot: string;
	readonly origin: Origin;
	readonly transport: McpStdioTransportDefinition | McpHttpTransportDefinition;
}

export interface PluginMcpMaterialization<Origin = unknown> {
	readonly servers: readonly MaterializedPluginMcpServer<Origin>[];
	readonly diagnostics: readonly PluginDiagnostic<Origin>[];
}

export interface PluginMcpMaterializeOptions {
	/** Canonical client-owned directory that contains this installed Plugin instance's dataDirectory. */
	readonly dataRoot?: string;
	readonly dataDirectory?: string;
	readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
	readonly signal?: AbortSignal;
}

export interface LoadedPluginSnapshot<Origin = unknown> {
	readonly status: "loaded";
	readonly requestedRoot: string;
	readonly root: string;
	readonly origin: Origin;
	readonly manifest: PluginManifest;
	readonly skills: SkillsSnapshot<Origin>;
	readonly mcpServers: readonly PluginMcpServer<Origin>[];
	readonly mcpConfiguration?: PluginMcpConfiguration;
	readonly diagnostics: readonly PluginDiagnostic<Origin>[];
	materializeMcp(options: PluginMcpMaterializeOptions): Promise<PluginMcpMaterialization<Origin>>;
}

export interface RejectedPluginSnapshot<Origin = unknown> {
	readonly status: "rejected";
	readonly requestedRoot: string;
	readonly origin: Origin;
	readonly diagnostics: readonly PluginDiagnostic<Origin>[];
}

export type PluginSnapshot<Origin = unknown> = LoadedPluginSnapshot<Origin> | RejectedPluginSnapshot<Origin>;

export interface PluginLoadRequest<Origin = unknown> {
	readonly root: string;
	readonly origin: Origin;
	readonly signal?: AbortSignal;
}

export interface CreatePluginsOptions {
	readonly fileSystem: SkillFileSystem;
	readonly limits?: Partial<PluginLimits>;
}

export interface Plugins<Origin = unknown> {
	load(request: PluginLoadRequest<Origin>): Promise<PluginSnapshot<Origin>>;
}
