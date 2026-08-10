import type { ToolExecutionContext } from "@coda/agent";
import type { McpElicitationRequest, McpToolCallRequest, McpToolSnapshot } from "@coda/mcp";
import { describe, expect, it } from "vitest";
import { createMcpAgentTools } from "../../src/mcp/tools.ts";

const executionContext: ToolExecutionContext = {
	signal: new AbortController().signal,
	runId: "run:1" as never,
	turnId: "turn:1" as never,
	invocationId: "tool:1" as never,
	resultMessageId: "message:1" as never,
	providerToolCallId: "provider-call-1",
};

describe("MCP Agent Tools", () => {
	it("projects a frozen MCP Tool Snapshot into sequential, non-replayable Agent Tools", async () => {
		const calls: McpToolCallRequest[] = [];
		const progress: unknown[] = [];
		const execution = {
			...executionContext,
			reportProgress: (value: unknown) => progress.push(value),
		} satisfies ToolExecutionContext;
		const snapshot: McpToolSnapshot = {
			revision: 7,
			servers: [
				{
					id: "docs",
					status: "ready",
					protocolEra: "modern",
					protocolVersion: "2026-07-28",
					server: { name: "Reference Docs", version: "1.0.0" },
					toolCount: 1,
				},
			],
			tools: [
				{
					id: "mcp:docs:search",
					serverId: "docs",
					remoteName: "search",
					name: "mcp__docs__search",
					description: "Search documentation",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			],
			callTool: async (request) => {
				calls.push(request);
				request.onProgress?.({ progress: 1, total: 1, message: "done" });
				return {
					isError: false,
					content: [
						{ type: "text", text: "one result" },
						{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
					],
					structuredContent: { count: 1 },
				};
			},
		};

		const [tool] = createMcpAgentTools({ snapshot });

		expect(tool).toMatchObject({
			name: "mcp__docs__search",
			description: "Search documentation",
			replaySafety: "never",
			parallelSafe: false,
			parameters: snapshot.tools[0]!.inputSchema,
		});
		const output = await tool!.execute({ query: "MCP" }, execution);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			toolId: "mcp:docs:search",
			arguments: { query: "MCP" },
			signal: execution.signal,
		});
		expect(progress).toEqual([{ progress: 1, total: 1, message: "done" }]);
		expect(output).toEqual({
			content: [
				{ type: "text", text: "one result" },
				{ type: "text", text: "[MCP audio: audio/wav, 5 bytes; binary payload omitted from model content]" },
				{ type: "text", text: '[MCP structured content]\n{\n  "count": 1\n}' },
			],
			isError: false,
			details: {
				kind: "mcp",
				catalogRevision: 7,
				serverId: "docs",
				remoteToolName: "search",
				contentTypes: ["text", "audio"],
				hasStructuredContent: true,
				truncated: false,
			},
		});
	});

	it("identifies the Server and Tool when delegating an Elicitation", async () => {
		const elicitation: McpElicitationRequest = {
			mode: "form",
			message: "Choose a region",
			requestedSchema: {
				type: "object",
				properties: { region: { type: "string", enum: ["eu", "us"] } },
				required: ["region"],
			},
		};
		const observed: unknown[] = [];
		const snapshot: McpToolSnapshot = {
			revision: 3,
			servers: [
				{
					id: "deploy",
					status: "ready",
					server: { name: "Deployments", version: "2.0.0" },
					toolCount: 1,
				},
			],
			tools: [
				{
					id: "mcp:deploy:release",
					serverId: "deploy",
					remoteName: "release",
					name: "mcp__deploy__release",
					description: "Release",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async (request) => {
				const answer = await request.elicit?.(elicitation);
				return {
					isError: answer?.action !== "accept",
					content: [{ type: "text", text: answer?.action ?? "missing" }],
				};
			},
		};
		const [tool] = createMcpAgentTools({
			snapshot,
			elicit: async (request) => {
				observed.push(request);
				return { action: "accept", content: { region: "eu" } };
			},
		});

		await expect(tool!.execute({}, executionContext)).resolves.toMatchObject({ isError: false });
		expect(observed).toEqual([
			expect.objectContaining({
				server: snapshot.servers[0],
				tool: snapshot.tools[0],
				request: elicitation,
				execution: expect.objectContaining({
					runId: executionContext.runId,
					turnId: executionContext.turnId,
					invocationId: executionContext.invocationId,
				}),
			}),
		]);
	});

	it("aborts a delegated Elicitation when the MCP call settles early", async () => {
		let delegatedExecution: ToolExecutionContext | undefined;
		const snapshot: McpToolSnapshot = {
			revision: 1,
			servers: [{ id: "slow", status: "ready", toolCount: 1 }],
			tools: [
				{
					id: "mcp:slow:wait",
					serverId: "slow",
					remoteName: "wait",
					name: "mcp__slow__wait",
					description: "Wait",
					inputSchema: { type: "object", properties: {} },
				},
			],
			callTool: async (request) => {
				void request.elicit?.({
					mode: "form",
					message: "Confirm",
					requestedSchema: { type: "object", properties: {} },
				});
				throw new Error("absolute deadline exceeded");
			},
		};
		const [tool] = createMcpAgentTools({
			snapshot,
			elicit: async (request) => {
				delegatedExecution = request.execution;
				return new Promise((resolve) => {
					request.execution.signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true });
				});
			},
		});

		await expect(tool!.execute({}, executionContext)).rejects.toThrow("absolute deadline exceeded");
		expect(delegatedExecution?.signal.aborted).toBe(true);
		expect(executionContext.signal.aborted).toBe(false);
	});
});
