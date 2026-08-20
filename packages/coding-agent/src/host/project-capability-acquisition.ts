import type { McpToolDescriptor, McpToolLease } from "@coda/mcp";
import type { RunCapabilityAcquisitionScope } from "@coda/runtime";
import type {
	AcquireProjectRunCapabilityBundle,
	ProjectRunCapabilityBundle,
} from "../runtime/project-capability-bundle.ts";

const bundleKeyByProvider = new WeakMap<AcquireProjectRunCapabilityBundle, object>();
const mcpExposureKeyByProvider = new WeakMap<AcquireProjectRunCapabilityBundle, object>();

export const MAX_AGENT_PLUGIN_MCP_TOOL_SPEC_BYTES = 8_000;
export const MAX_AGENT_PLUGIN_MCP_TOTAL_SPEC_BYTES = 64_000;

export interface McpRunExposureDiagnostic {
	readonly code: "mcp.agent-plugin-tool-budget-exceeded" | "mcp.agent-plugin-total-budget-exceeded";
	readonly message: string;
	readonly serverId: string;
	readonly serverSemanticName: string;
	readonly toolId: string;
	readonly toolName: string;
	readonly specBytes: number;
	readonly limitBytes: number;
}

export interface ProjectMcpRunExposure {
	readonly descriptors: readonly McpToolDescriptor[];
	/** Agent Plugin Servers that retain at least one Tool in `descriptors`. */
	readonly agentPluginServerIds: readonly string[];
	readonly diagnostics: readonly McpRunExposureDiagnostic[];
}

function bundleKey(acquire: AcquireProjectRunCapabilityBundle): object {
	let key = bundleKeyByProvider.get(acquire);
	if (!key) {
		key = Object.freeze({ kind: "coding-project-capability-bundle" });
		bundleKeyByProvider.set(acquire, key);
	}
	return key;
}

function mcpExposureKey(acquire: AcquireProjectRunCapabilityBundle): object {
	let key = mcpExposureKeyByProvider.get(acquire);
	if (!key) {
		key = Object.freeze({ kind: "coding-project-mcp-run-exposure" });
		mcpExposureKeyByProvider.set(acquire, key);
	}
	return key;
}

/** Retains one coherent Project bundle across every contributor in a Prepared Run. */
export function acquireScopedProjectRunCapabilityBundle(
	scope: RunCapabilityAcquisitionScope | undefined,
	acquire: AcquireProjectRunCapabilityBundle,
	signal: AbortSignal,
): Promise<ProjectRunCapabilityBundle> {
	if (!scope) throw new Error("Project capability bundles require host-driven Run acquisition");
	return scope.getOrCreate(
		bundleKey(acquire),
		() => acquire(signal),
		(bundle) => bundle.dispose(),
	);
}

/**
 * Freezes the one model-visible MCP projection shared by Tool admission and
 * Plugin guidance for a Prepared Run.
 */
export function projectMcpRunExposure(lease: McpToolLease): ProjectMcpRunExposure {
	const declaredPluginServerIds = pluginServerIds(lease);
	const pluginServers = new Set(declaredPluginServerIds);
	const exposedPluginServers = new Set<string>();
	const diagnostics: McpRunExposureDiagnostic[] = [];
	const descriptors: McpToolDescriptor[] = [];
	let agentPluginBytes = 0;
	for (const tool of [...lease.tools].sort(compareTools)) {
		if (!toolIsModelVisible(tool)) continue;
		const descriptor = Object.freeze({ ...tool });
		if (!pluginServers.has(tool.serverId)) {
			descriptors.push(descriptor);
			continue;
		}
		const modelTool = Object.freeze({
			...descriptor,
			description: `Agent Plugin MCP Server ${descriptor.serverSemanticName} — ${descriptor.description}`,
		});
		const specBytes = modelSpecBytes(modelTool);
		if (specBytes > MAX_AGENT_PLUGIN_MCP_TOOL_SPEC_BYTES) {
			diagnostics.push(
				Object.freeze({
					code: "mcp.agent-plugin-tool-budget-exceeded" as const,
					message: `Agent Plugin MCP Tool "${descriptor.serverSemanticName}/${descriptor.remoteName}" was hidden because its model spec is ${specBytes} bytes (limit ${MAX_AGENT_PLUGIN_MCP_TOOL_SPEC_BYTES})`,
					serverId: descriptor.serverId,
					serverSemanticName: descriptor.serverSemanticName,
					toolId: descriptor.id,
					toolName: descriptor.name,
					specBytes,
					limitBytes: MAX_AGENT_PLUGIN_MCP_TOOL_SPEC_BYTES,
				}),
			);
			continue;
		}
		if (agentPluginBytes + specBytes > MAX_AGENT_PLUGIN_MCP_TOTAL_SPEC_BYTES) {
			diagnostics.push(
				Object.freeze({
					code: "mcp.agent-plugin-total-budget-exceeded" as const,
					message: `Agent Plugin MCP Tool "${descriptor.serverSemanticName}/${descriptor.remoteName}" was hidden because Agent Plugin model specs would exceed ${MAX_AGENT_PLUGIN_MCP_TOTAL_SPEC_BYTES} bytes`,
					serverId: descriptor.serverId,
					serverSemanticName: descriptor.serverSemanticName,
					toolId: descriptor.id,
					toolName: descriptor.name,
					specBytes,
					limitBytes: MAX_AGENT_PLUGIN_MCP_TOTAL_SPEC_BYTES,
				}),
			);
			continue;
		}
		agentPluginBytes += specBytes;
		descriptors.push(modelTool);
		exposedPluginServers.add(descriptor.serverId);
	}
	return Object.freeze({
		descriptors: Object.freeze(descriptors),
		agentPluginServerIds: Object.freeze([...exposedPluginServers].sort(compareText)),
		diagnostics: Object.freeze(diagnostics),
	});
}

/** Acquires the exact Project bundle and its once-per-Run MCP exposure projection. */
export async function acquireScopedProjectMcpRunExposure(
	scope: RunCapabilityAcquisitionScope | undefined,
	acquire: AcquireProjectRunCapabilityBundle,
	signal: AbortSignal,
): Promise<Readonly<{ bundle: ProjectRunCapabilityBundle; exposure: ProjectMcpRunExposure }>> {
	const bundle = await acquireScopedProjectRunCapabilityBundle(scope, acquire, signal);
	if (!scope) throw new Error("Project capability bundles require host-driven Run acquisition");
	const exposure = await scope.getOrCreate(mcpExposureKey(acquire), () => projectMcpRunExposure(bundle.mcp));
	return Object.freeze({ bundle, exposure });
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareTools(left: McpToolDescriptor, right: McpToolDescriptor): number {
	return (
		compareText(left.serverId, right.serverId) ||
		compareText(left.remoteName, right.remoteName) ||
		compareText(left.id, right.id)
	);
}

function toolIsModelVisible(tool: McpToolDescriptor): boolean {
	const ui = tool.meta?.ui;
	if (!ui || typeof ui !== "object" || Array.isArray(ui)) return true;
	const visibility = (ui as Readonly<Record<string, unknown>>).visibility;
	if (!Array.isArray(visibility)) return true;
	return visibility.some((entry) => entry === "model");
}

function modelSpecBytes(tool: McpToolDescriptor): number {
	return new TextEncoder().encode(
		JSON.stringify({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
			strict: false,
		}),
	).byteLength;
}

function pluginServerIds(lease: McpToolLease): readonly string[] {
	const value = (lease as McpToolLease & { readonly agentPluginServerIds?: unknown }).agentPluginServerIds;
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
		throw new Error("Invalid Agent Plugin MCP provenance");
	}
	const ids = [...new Set(value as readonly string[])].sort(compareText);
	if (ids.length !== value.length) throw new Error("Invalid Agent Plugin MCP provenance");
	const servers = new Set(lease.servers.map(({ id }) => id));
	if (ids.some((id) => !servers.has(id))) {
		throw new Error("Agent Plugin MCP provenance references an unknown Server");
	}
	return Object.freeze(ids);
}
