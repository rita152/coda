import type { AgentTool, ToolExecutionContext } from "@coda/agent";
import type { TSchema } from "@coda/ai";
import {
	type McpElicitationRequest,
	type McpElicitationResult,
	type McpProgress,
	type McpServerSnapshot,
	type McpToolDescriptor,
	type McpToolResult,
	type McpToolSnapshot,
	projectMcpToolResult,
} from "@coda/mcp";

export interface McpAgentToolDetails {
	readonly kind: "mcp";
	readonly catalogRevision: number;
	readonly serverId: string;
	readonly remoteToolName: string;
	readonly contentTypes: readonly string[];
	readonly hasStructuredContent: boolean;
	readonly truncated: boolean;
}

export interface McpAgentElicitation {
	readonly server: McpServerSnapshot;
	readonly tool: McpToolDescriptor;
	readonly request: McpElicitationRequest;
	readonly execution: ToolExecutionContext;
}

export interface McpAgentProgress {
	readonly server: McpServerSnapshot;
	readonly tool: McpToolDescriptor;
	readonly progress: McpProgress;
	readonly execution: ToolExecutionContext;
}

export interface CreateMcpAgentToolsOptions {
	readonly snapshot: McpToolSnapshot;
	readonly elicit?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
	readonly onProgress?: (progress: McpAgentProgress) => void;
}

export function createMcpAgentTools(options: CreateMcpAgentToolsOptions): readonly AgentTool[] {
	const servers = new Map(options.snapshot.servers.map((server) => [server.id, server]));
	return Object.freeze(
		options.snapshot.tools.map((descriptor) => {
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
						result = await options.snapshot.callTool({
							toolId: descriptor.id,
							arguments: structuredClone(arguments_),
							signal: execution.signal,
							...(execution.reportProgress || options.onProgress
								? {
										onProgress: (progress: McpProgress) => {
											execution.reportProgress?.(progress);
											options.onProgress?.({ server, tool: descriptor, progress, execution });
										},
									}
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
					const content =
						projection.content.length > 0
							? projection.content
							: [{ type: "text" as const, text: "[MCP Tool completed with no model-visible content]" }];
					return {
						content,
						isError: projection.isError,
						details: Object.freeze({
							kind: "mcp" as const,
							catalogRevision: options.snapshot.revision,
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
