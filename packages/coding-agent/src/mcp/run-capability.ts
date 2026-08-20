import type { AgentTool, ToolExecutionContext } from "@coda/agent";
import type { TSchema } from "@coda/ai";
import type {
	McpElicitationRequest,
	McpElicitationResult,
	McpProgress,
	McpServerSnapshot,
	McpToolDescriptor,
	McpToolLease,
	McpToolResult,
} from "@coda/mcp";
import { projectMcpToolResult } from "@coda/mcp";
import type { RunCapabilitySelections, RunCapabilitySelectionValue, RunCapabilitySource } from "@coda/runtime";
import {
	acquireScopedProjectMcpRunExposure,
	type McpRunExposureDiagnostic,
	projectMcpRunExposure,
} from "../host/project-capability-acquisition.ts";
import type { AcquireProjectRunCapabilityBundle } from "../runtime/project-capability-bundle.ts";

export type { McpRunExposureDiagnostic } from "../host/project-capability-acquisition.ts";
export {
	MAX_AGENT_PLUGIN_MCP_TOOL_SPEC_BYTES,
	MAX_AGENT_PLUGIN_MCP_TOTAL_SPEC_BYTES,
} from "../host/project-capability-acquisition.ts";

export const MCP_RUN_CAPABILITY_SOURCE_ID = "mcp";

export function mcpRunCapabilitySelections(toolIds: readonly string[]): RunCapabilitySelections {
	return Object.freeze({
		[MCP_RUN_CAPABILITY_SOURCE_ID]: Object.freeze({
			toolIds: Object.freeze([...new Set(toolIds)].sort()),
		}),
	});
}

export interface McpAgentElicitation {
	readonly server: McpServerSnapshot;
	readonly tool: McpToolDescriptor;
	readonly request: McpElicitationRequest;
	readonly execution: ToolExecutionContext;
}

interface McpAgentToolDetails {
	readonly kind: "mcp";
	readonly catalogRevision: number;
	readonly serverId: string;
	readonly serverSemanticName: string;
	readonly remoteToolName: string;
	readonly contentTypes: readonly string[];
	readonly hasStructuredContent: boolean;
	readonly truncated: boolean;
}

function createMcpTools(options: {
	readonly lease: McpToolLease;
	readonly tools: readonly McpToolDescriptor[];
	readonly elicit?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}): readonly AgentTool[] {
	const servers = new Map(options.lease.servers.map((server) => [server.id, server]));
	return Object.freeze(
		[...options.tools].sort(compareTools).map((descriptor) => {
			const server = servers.get(descriptor.serverId);
			if (!server) throw new Error(`MCP Tool references an unknown Server: ${descriptor.serverId}`);
			return Object.freeze({
				name: descriptor.name,
				description: descriptor.description,
				parameters: descriptor.inputSchema as TSchema,
				replaySafety: "never" as const,
				parallelSafe: false,
				execute: async (arguments_: Readonly<Record<string, unknown>>, execution: ToolExecutionContext) => {
					const elicitationController = options.elicit ? new AbortController() : undefined;
					const abortElicitation = () => elicitationController?.abort(execution.signal.reason);
					if (elicitationController) {
						if (execution.signal.aborted) abortElicitation();
						else execution.signal.addEventListener("abort", abortElicitation, { once: true });
					}
					const elicitationExecution = elicitationController
						? Object.freeze({ ...execution, signal: elicitationController.signal })
						: execution;
					let result: McpToolResult;
					try {
						result = await options.lease.callTool({
							toolId: descriptor.id,
							arguments: structuredClone(arguments_),
							signal: execution.signal,
							...(execution.reportProgress
								? { onProgress: (progress: McpProgress) => execution.reportProgress?.(progress) }
								: {}),
							...(options.elicit
								? {
										elicit: (request: McpElicitationRequest) =>
											options.elicit!({
												server,
												tool: descriptor,
												request,
												execution: elicitationExecution,
											}),
									}
								: {}),
						});
					} finally {
						execution.signal.removeEventListener("abort", abortElicitation);
						elicitationController?.abort(new DOMException("MCP Tool execution settled", "AbortError"));
					}
					const projection = projectMcpToolResult(result);
					return {
						content:
							projection.content.length > 0
								? projection.content
								: [{ type: "text" as const, text: "[MCP Tool completed with no model-visible content]" }],
						observation: {
							status: projection.isError ? "error" : "ok",
							truncated: projection.details.truncated,
							facts: {
								contentTypes: [...projection.details.contentTypes],
								hasStructuredContent: projection.details.hasStructuredContent,
							},
						},
						details: Object.freeze({
							kind: "mcp" as const,
							catalogRevision: options.lease.revision,
							serverId: descriptor.serverId,
							serverSemanticName: descriptor.serverSemanticName,
							remoteToolName: descriptor.remoteName,
							contentTypes: projection.details.contentTypes,
							hasStructuredContent: projection.details.hasStructuredContent,
							truncated: projection.details.truncated,
						}),
					};
				},
			} as AgentTool<TSchema, McpAgentToolDetails>);
		}),
	);
}

function selectedToolIds(selection: Parameters<RunCapabilitySource["acquire"]>[0]["selection"]): ReadonlySet<string> {
	if (selection === undefined) return new Set();
	if (
		typeof selection !== "object" ||
		selection === null ||
		Array.isArray(selection) ||
		Object.keys(selection).length !== 1 ||
		!("toolIds" in selection) ||
		!Array.isArray(selection.toolIds) ||
		selection.toolIds.some((id) => typeof id !== "string" || id.length === 0)
	) {
		throw new Error("Invalid MCP Run capability selection");
	}
	return new Set(selection.toolIds as readonly string[]);
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

function revision(
	catalogRevision: number,
	selectedToolIds: ReadonlySet<string>,
	visibleToolIds: ReadonlySet<string>,
	agentPluginServerIds: readonly string[],
): string {
	return `catalog:${catalogRevision};selected:${JSON.stringify([...selectedToolIds].sort(compareText))};visible:${JSON.stringify([...visibleToolIds].sort(compareText))};agentPlugins:${JSON.stringify(agentPluginServerIds)}`;
}

export function createMcpCapabilitySource(options: {
	readonly acquire?: (signal: AbortSignal) => McpToolLease | Promise<McpToolLease>;
	readonly acquireProjectBundle?: AcquireProjectRunCapabilityBundle;
	readonly elicit?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly diagnostic?: (diagnostic: McpRunExposureDiagnostic) => void | Promise<void>;
}): RunCapabilitySource {
	if (
		(typeof options.acquire !== "function" && typeof options.acquireProjectBundle !== "function") ||
		(options.acquire && options.acquireProjectBundle)
	) {
		throw new TypeError("Exactly one MCP lease or Project bundle acquisition source is required");
	}
	return Object.freeze({
		id: MCP_RUN_CAPABILITY_SOURCE_ID,
		mergeSelection: (
			parent: RunCapabilitySelectionValue | undefined,
			child: RunCapabilitySelectionValue | undefined,
		) =>
			Object.freeze({
				toolIds: Object.freeze([...new Set([...selectedToolIds(parent), ...selectedToolIds(child)])].sort()),
			}),
		acquire: async ({ signal, selection, scope }: Parameters<RunCapabilitySource["acquire"]>[0]) => {
			const selectionIds = selectedToolIds(selection);
			const scoped = options.acquireProjectBundle
				? await acquireScopedProjectMcpRunExposure(scope, options.acquireProjectBundle, signal)
				: undefined;
			const bundle = scoped?.bundle;
			const lease = bundle ? bundle.mcp : await options.acquire!(signal);
			const ownsLease = bundle === undefined;
			try {
				const available = new Set(lease.tools.map(({ id }) => id));
				const missing = [...selectionIds].filter((id) => !available.has(id)).sort();
				if (missing.length > 0) {
					throw new Error(`Selected MCP Tool is no longer available: ${missing.join(", ")}`);
				}
				const exposure = scoped?.exposure ?? projectMcpRunExposure(lease);
				for (const diagnostic of exposure.diagnostics) {
					try {
						await options.diagnostic?.(diagnostic);
					} catch {
						// Diagnostic projection cannot make Run capability acquisition fail.
					}
				}
				const visibleToolIds = new Set(exposure.descriptors.map(({ id }) => id));
				const tools = createMcpTools({
					lease,
					tools: exposure.descriptors,
					...(options.elicit ? { elicit: options.elicit } : {}),
				});
				return Object.freeze({
					revision: bundle
						? `${bundle.revision};mcp:${revision(lease.revision, selectionIds, visibleToolIds, exposure.agentPluginServerIds)}`
						: revision(lease.revision, selectionIds, visibleToolIds, exposure.agentPluginServerIds),
					tools: Object.freeze(tools.map((tool) => Object.freeze({ tool, effect: "unknown" as const }))),
					promptFragments: Object.freeze([]),
					dispose: () => (ownsLease ? lease.dispose() : undefined),
				});
			} catch (error) {
				if (ownsLease) await lease.dispose().catch(() => undefined);
				throw error;
			}
		},
	});
}
