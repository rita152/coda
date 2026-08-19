import {
	type ImageContent,
	resolveToolObservation,
	type TextContent,
	type ToolObservation,
	type ToolResultMessage,
	validateToolArguments,
} from "@coda/ai";
import { cloneFrozen } from "./immutable.ts";
import type {
	AgentMessage,
	AgentTool,
	Clock,
	RunId,
	ToolExecutionContext,
	ToolExecutionOutcome,
	ToolExecutionOutput,
	ToolExecutionProgress,
	ToolExecutionSettlement,
	ToolInvocation,
	ToolRejectionReason,
	TurnId,
} from "./types.ts";

export type SettledToolInvocation =
	| {
			readonly kind: "executed";
			readonly settlement: ToolExecutionSettlement;
			readonly outcome: ToolExecutionOutcome;
			readonly result: AgentMessage<ToolResultMessage>;
			readonly error?: unknown;
	  }
	| {
			readonly kind: "rejected";
			readonly reason: Extract<ToolRejectionReason, "missing" | "invalid" | "aborted">;
			readonly result: AgentMessage<ToolResultMessage>;
	  };

export interface SettleToolInvocationInput {
	readonly tools: readonly AgentTool[];
	readonly invocation: ToolInvocation;
	readonly context: {
		readonly signal: AbortSignal;
		readonly runId: string;
		readonly turnId: string;
		readonly clock: Clock;
		readonly reportProgress?: (progress: ToolExecutionProgress) => void;
	};
	readonly beforeExecute?: () => Promise<void> | void;
}

export async function settleToolInvocation(input: SettleToolInvocationInput): Promise<SettledToolInvocation> {
	const { invocation, context } = input;
	const tool = input.tools.find((candidate) => candidate.name === invocation.toolName);
	if (!tool) {
		return rejectedSettlement(invocation, "missing", `Tool "${invocation.toolName}" is not available`, context.clock);
	}

	let arguments_: Record<string, unknown>;
	try {
		arguments_ = validateToolArguments(tool, {
			type: "toolCall",
			id: invocation.providerToolCallId,
			name: invocation.toolName,
			arguments: structuredClone(invocation.arguments) as Record<string, unknown>,
		}) as Record<string, unknown>;
	} catch (error) {
		return rejectedSettlement(invocation, "invalid", errorMessage(error), context.clock);
	}

	if (context.signal.aborted) {
		return rejectedSettlement(invocation, "aborted", `Tool "${invocation.toolName}" was not started`, context.clock);
	}

	await input.beforeExecute?.();
	return executePreparedToolInvocation({
		tool,
		arguments: arguments_,
		invocation,
		context,
	});
}

export async function executePreparedToolInvocation(input: {
	readonly tool: AgentTool;
	readonly arguments: Record<string, unknown>;
	readonly invocation: ToolInvocation;
	readonly context: SettleToolInvocationInput["context"];
}): Promise<Extract<SettledToolInvocation, { kind: "executed" }>> {
	const { tool, invocation, context } = input;
	if (context.signal.aborted) return abortedSettlement(invocation, context.clock);

	let acceptsProgress = true;
	const reportProgress = (progress: ToolExecutionProgress): void => {
		if (!acceptsProgress || context.signal.aborted) return;
		context.reportProgress?.(cloneFrozen(progress));
	};
	try {
		const output = await tool.execute(input.arguments, executionContext(invocation, context, reportProgress));
		acceptsProgress = false;
		if (context.signal.aborted) return abortedSettlement(invocation, context.clock);
		const result = toolResultMessage(invocation, output, context.clock);
		return {
			kind: "executed",
			settlement: "returned",
			outcome: toolExecutionOutcome(resolveToolObservation(result.message).status),
			result,
		};
	} catch (error) {
		acceptsProgress = false;
		if (context.signal.aborted) return abortedSettlement(invocation, context.clock);
		return {
			kind: "executed",
			settlement: "threw",
			outcome: "error",
			error,
			result: toolResultMessage(
				invocation,
				{
					content: `Tool "${invocation.toolName}" failed: ${errorMessage(error)}`,
					observation: { status: "error", truncated: false },
					details: { status: "failed", error: { message: errorMessage(error) } },
				},
				context.clock,
			),
		};
	}
}

export function toolResultMessage(
	invocation: ToolInvocation,
	output: ToolExecutionOutput,
	clock: Clock,
): AgentMessage<ToolResultMessage> {
	const observation = resolveToolObservation(output);
	return cloneFrozen({
		id: invocation.resultMessageId,
		message: {
			role: "toolResult",
			toolCallId: invocation.providerToolCallId,
			toolName: invocation.toolName,
			content: normalizedToolContent(output.content),
			observation,
			details: structuredClone(output.details),
			timestamp: clock.now(),
		},
	});
}

export function rejectedToolResult(
	invocation: ToolInvocation,
	reason: ToolRejectionReason,
	message: string,
	clock: Clock,
): AgentMessage<ToolResultMessage> {
	return toolResultMessage(
		invocation,
		{
			content: message,
			observation: {
				status: reason === "aborted" || reason === "not_started" ? "aborted" : "error",
				truncated: false,
				facts: { reason },
			},
			details: { status: "rejected", reason },
		},
		clock,
	);
}

function rejectedSettlement(
	invocation: ToolInvocation,
	reason: Extract<ToolRejectionReason, "missing" | "invalid" | "aborted">,
	message: string,
	clock: Clock,
): Extract<SettledToolInvocation, { kind: "rejected" }> {
	return {
		kind: "rejected",
		reason,
		result: rejectedToolResult(invocation, reason, message, clock),
	};
}

function abortedSettlement(
	invocation: ToolInvocation,
	clock: Clock,
): Extract<SettledToolInvocation, { kind: "executed" }> {
	return {
		kind: "executed",
		settlement: "aborted",
		outcome: "aborted",
		result: toolResultMessage(
			invocation,
			{
				content: `Tool "${invocation.toolName}" was aborted`,
				observation: { status: "aborted", truncated: false },
				details: { status: "aborted" },
			},
			clock,
		),
	};
}

function executionContext(
	invocation: ToolInvocation,
	context: SettleToolInvocationInput["context"],
	reportProgress: (progress: ToolExecutionProgress) => void,
): ToolExecutionContext {
	return {
		signal: context.signal,
		runId: context.runId as RunId,
		turnId: context.turnId as TurnId,
		invocationId: invocation.id,
		resultMessageId: invocation.resultMessageId,
		providerToolCallId: invocation.providerToolCallId,
		reportProgress,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toolExecutionOutcome(status: ToolObservation["status"]): ToolExecutionOutcome {
	if (status === "ok") return "success";
	if (status === "aborted") return "aborted";
	return "error";
}

function normalizedToolContent(content: ToolExecutionOutput["content"]): readonly (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) throw new Error("Tool output content must be a string or content block array");
	return structuredClone(content) as (TextContent | ImageContent)[];
}
