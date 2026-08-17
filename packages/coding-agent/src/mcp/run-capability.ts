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
import type { RunCapabilitySource } from "@coda/runtime";

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
	readonly remoteToolName: string;
	readonly contentTypes: readonly string[];
	readonly hasStructuredContent: boolean;
	readonly truncated: boolean;
}

function createMcpTools(options: {
	readonly lease: McpToolLease;
	readonly elicit?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}): readonly AgentTool[] {
	const servers = new Map(options.lease.servers.map((server) => [server.id, server]));
	return Object.freeze(
		options.lease.tools.map((descriptor) => {
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

export function createMcpCapabilitySource(options: {
	readonly acquire: (signal: AbortSignal) => McpToolLease | Promise<McpToolLease>;
	readonly elicit?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}): RunCapabilitySource {
	return Object.freeze({
		id: "mcp",
		acquire: async ({ signal }: Parameters<RunCapabilitySource["acquire"]>[0]) => {
			const lease = await options.acquire(signal);
			try {
				const tools = createMcpTools({ lease, ...(options.elicit ? { elicit: options.elicit } : {}) });
				return Object.freeze({
					revision: String(lease.revision),
					tools: Object.freeze(tools.map((tool) => Object.freeze({ tool, effect: "unknown" as const }))),
					promptFragments: Object.freeze([]),
					dispose: () => lease.dispose(),
				});
			} catch (error) {
				await lease.dispose().catch(() => undefined);
				throw error;
			}
		},
	});
}
