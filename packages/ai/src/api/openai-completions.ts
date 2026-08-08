// Portions derived from Pi:
// /packages/ai/src/api/openai-completions.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions.js";
import { parse } from "partial-json";

import { AssistantMessageEventStream } from "../event-stream.ts";
import { retryProviderRequest } from "../provider-retry.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	OpenAICompletionsOptions,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import {
	calculateCost,
	createOutput,
	mergeProviderHeaders,
	requestHeaders,
	requireApiKey,
	responseMetadata,
	terminateStream,
} from "./shared.ts";
import { buildBaseOptions, clampThinkingLevel } from "./simple-options.ts";

export type { OpenAICompletionsOptions } from "../types.ts";

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

type TextBlock = TextContent & { ended?: boolean };
type ThinkingBlock = ThinkingContent & { ended?: boolean };
type StreamingToolCall = ToolCall & { partialJson: string; ended?: boolean; providerIndex: number };

function resolvedCompat(model: Model<"openai-completions">): OpenAICompletionsCompat {
	return {
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		maxTokensField: "max_completion_tokens",
		...model.compat,
	};
}

function completionHeaders(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: OpenAICompletionsCompat,
) {
	const affinity: Record<string, string> = {};
	if (options?.sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			affinity["x-session-id"] = options.sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") affinity.session_id = options.sessionId;
			affinity["x-client-request-id"] = options.sessionId;
			affinity["x-session-affinity"] = options.sessionId;
		}
	}
	return mergeProviderHeaders(affinity, model.headers, options?.headers);
}

function userContent(
	message: Extract<Context["messages"][number], { role: "user" }>,
): string | ChatCompletionContentPart[] {
	if (typeof message.content === "string") return message.content;
	return message.content.map(
		(block): ChatCompletionContentPart =>
			block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } },
	);
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: OpenAICompletionsCompat = resolvedCompat(model),
	_options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];
	if (context.systemPrompt) {
		messages.push({
			role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
			content: context.systemPrompt,
		});
	}
	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: userContent(message) });
			continue;
		}
		if (message.role === "toolResult") {
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content
					.map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
					.join("\n"),
				...(compat.requiresToolResultName ? { name: message.toolName } : {}),
			});
			continue;
		}
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
		const toolCalls = message.content
			.filter((block): block is ToolCall => block.type === "toolCall")
			.map((block) => ({
				id: block.id,
				type: "function" as const,
				function: { name: block.name, arguments: JSON.stringify(block.arguments) },
			}));
		const assistant: ChatCompletionAssistantMessageParam = {
			role: "assistant",
			content: text || null,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		};
		const thinkingBlocks = message.content.filter((block): block is ThinkingContent => block.type === "thinking");
		if (thinkingBlocks.length) {
			if (compat.requiresThinkingAsText) {
				assistant.content = [...thinkingBlocks.map((block) => block.thinking), text].filter(Boolean).join("\n\n");
			} else {
				let signature = thinkingBlocks.find((block) => block.thinkingSignature)?.thinkingSignature;
				if (model.provider === "opencode-go" && signature === "reasoning") signature = "reasoning_content";
				if (signature) {
					(assistant as unknown as Record<string, unknown>)[signature] = thinkingBlocks
						.map((block) => block.thinking)
						.join("\n");
				}
			}
		}
		const reasoningDetails = message.content
			.filter((block): block is ToolCall => block.type === "toolCall" && block.thoughtSignature !== undefined)
			.flatMap((block) => {
				try {
					return [JSON.parse(block.thoughtSignature!) as unknown];
				} catch {
					return [];
				}
			});
		if (reasoningDetails.length) {
			(assistant as unknown as Record<string, unknown>).reasoning_details = reasoningDetails;
		}
		if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning) {
			const dynamic = assistant as unknown as { reasoning_content?: string };
			dynamic.reasoning_content ??= "";
		}
		messages.push(assistant);
	}
	return messages;
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	compat: OpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
	const maximumField = compat.maxTokensField ?? "max_completion_tokens";
	const params: Record<string, unknown> = {
		model: model.id,
		messages: convertMessages(model, context, compat),
		stream: true,
		stream_options: compat.supportsUsageInStreaming === false ? undefined : { include_usage: true },
		...(options?.maxTokens ? { [maximumField]: options.maxTokens } : {}),
		...(context.tools?.length
			? {
					tools: context.tools.map((tool) => ({
						type: "function",
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.parameters,
						},
					})),
				}
			: {}),
		...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options?.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
		...options?.samplingParams,
	};
	if (compat.thinkingFormat === "qwen" && model.reasoning) {
		params.enable_thinking = options?.reasoningEffort !== undefined;
		if (options?.reasoningEffort && compat.supportsReasoningEffort !== false) {
			params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort !== false) {
			params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort !== false) {
		params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort !== false) {
		const off = model.thinkingLevelMap?.off;
		if (typeof off === "string") params.reasoning_effort = off;
	}
	if (params.stream_options === undefined) delete params.stream_options;
	return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

function partialArguments(value: string): Record<string, any> {
	if (!value) return {};
	try {
		const result = parse(value);
		return result && typeof result === "object" && !Array.isArray(result) ? result : {};
	} catch {
		return {};
	}
}

function finalArguments(value: string): Record<string, any> {
	if (!value) return {};
	const result: unknown = JSON.parse(value);
	if (!result || typeof result !== "object" || Array.isArray(result))
		throw new Error("Tool arguments must be an object");
	return result as Record<string, any>;
}

function mapStopReason(reason: string | null | undefined): AssistantMessage["stopReason"] {
	if (reason === "tool_calls" || reason === "function_call") return "toolUse";
	if (reason === "length") return "length";
	if (reason === "stop") return "stop";
	return reason ? "error" : "pending";
}

function endTextOrThinking(output: AssistantMessage, events: AssistantMessageEventStream): void {
	for (let index = 0; index < output.content.length; index++) {
		const block = output.content[index] as TextBlock | ThinkingBlock | StreamingToolCall;
		if (block.ended || block.type === "toolCall") continue;
		block.ended = true;
		if (block.type === "text") {
			events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
		} else {
			events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
		}
	}
}

function endToolCalls(output: AssistantMessage, events: AssistantMessageEventStream): void {
	for (let index = 0; index < output.content.length; index++) {
		const block = output.content[index] as TextBlock | ThinkingBlock | StreamingToolCall;
		if (block.type !== "toolCall" || block.ended) continue;
		block.arguments = finalArguments(block.partialJson);
		block.ended = true;
		const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
		events.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
	}
}

function stripStreamingState(output: AssistantMessage): void {
	for (const block of output.content) {
		delete (block as { ended?: boolean }).ended;
		delete (block as { partialJson?: string }).partialJson;
		delete (block as { providerIndex?: number }).providerIndex;
	}
}

function findLastOpenBlock(output: AssistantMessage, type: "text" | "thinking"): number {
	for (let index = output.content.length - 1; index >= 0; index--) {
		const block = output.content[index] as TextBlock | ThinkingBlock | StreamingToolCall;
		if (block.type === type && !block.ended) return index;
	}
	return -1;
}

function appendText(output: AssistantMessage, events: AssistantMessageEventStream, delta: string): void {
	let index = findLastOpenBlock(output, "text");
	if (index < 0) {
		index = output.content.push({ type: "text", text: "" } as TextBlock) - 1;
		events.push({ type: "text_start", contentIndex: index, partial: output });
	}
	(output.content[index] as TextBlock).text += delta;
	events.push({ type: "text_delta", contentIndex: index, delta, partial: output });
}

function appendThinking(
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	delta: string,
	signature: string,
): void {
	let index = findLastOpenBlock(output, "thinking");
	if (index < 0) {
		index =
			output.content.push({ type: "thinking", thinking: "", thinkingSignature: signature } as ThinkingBlock) - 1;
		events.push({ type: "thinking_start", contentIndex: index, partial: output });
	}
	(output.content[index] as ThinkingBlock).thinking += delta;
	events.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
}

function appendToolDelta(
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	delta: NonNullable<ChatCompletionChunk.Choice.Delta["tool_calls"]>[number],
): void {
	endTextOrThinking(output, events);
	let contentIndex = output.content.findIndex(
		(block) => block.type === "toolCall" && (block as StreamingToolCall).providerIndex === delta.index,
	);
	if (contentIndex < 0) {
		contentIndex =
			output.content.push({
				type: "toolCall",
				id: delta.id ?? `tool-${delta.index}`,
				name: "",
				arguments: {},
				partialJson: "",
				providerIndex: delta.index,
			} as StreamingToolCall) - 1;
		events.push({ type: "toolcall_start", contentIndex, partial: output });
	}
	const block = output.content[contentIndex] as StreamingToolCall;
	if (delta.id) block.id = delta.id;
	if (delta.function?.name) block.name += delta.function.name;
	const argumentsDelta = delta.function?.arguments ?? "";
	if (argumentsDelta) {
		block.partialJson += argumentsDelta;
		block.arguments = partialArguments(block.partialJson);
		events.push({ type: "toolcall_delta", contentIndex, delta: argumentsDelta, partial: output });
	}
}

function processChunk(
	chunk: ChatCompletionChunk,
	model: Model<"openai-completions">,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
): void {
	output.responseId ||= chunk.id;
	if (chunk.model && chunk.model !== model.id) output.responseModel ||= chunk.model;
	const choice = chunk.choices[0];
	if (choice) {
		const dynamicDelta = choice.delta as typeof choice.delta & {
			reasoning_content?: string;
			reasoning?: string;
			reasoning_text?: string;
		};
		const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;
		const found = reasoningFields.find((field) => Boolean(dynamicDelta[field]));
		if (found) {
			const signature = model.provider === "opencode-go" && found === "reasoning" ? "reasoning_content" : found;
			appendThinking(output, events, dynamicDelta[found]!, signature);
		}
		if (choice.delta.content) appendText(output, events, choice.delta.content);
		for (const toolDelta of choice.delta.tool_calls ?? []) appendToolDelta(output, events, toolDelta);
		if (choice.finish_reason) {
			output.rawStopReason = choice.finish_reason;
			output.stopReason = mapStopReason(choice.finish_reason);
		}
	}
	if (chunk.usage) {
		const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
		output.usage.input = Math.max(0, chunk.usage.prompt_tokens - cached);
		output.usage.cacheRead = cached;
		output.usage.output = chunk.usage.completion_tokens;
		output.usage.reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined;
		output.usage.totalTokens = chunk.usage.total_tokens;
		calculateCost(model, output.usage);
	}
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (model, context, options) => {
	const events = new AssistantMessageEventStream();
	const output = createOutput(model, options.runtime.clock);
	void (async () => {
		let phase = "request";
		try {
			options?.signal?.throwIfAborted();
			const apiKey = requireApiKey(model.provider, options?.apiKey);
			const compat = resolvedCompat(model);
			const client = new OpenAI({
				apiKey,
				baseURL: model.baseUrl,
				fetch: options?.fetch,
				defaultHeaders: requestHeaders(completionHeaders(model, options, compat)),
				maxRetries: 0,
			});
			let params = buildParams(model, context, options, compat);
			const transformed = await options?.onPayload?.(params, model);
			if (transformed !== undefined) {
				params = transformed as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			const response = await retryProviderRequest(
				() =>
					client.chat.completions
						.create(params, {
							...(options?.signal ? { signal: options.signal } : {}),
							...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
							maxRetries: 0,
						})
						.withResponse(),
				options,
			);
			await options?.onResponse?.(responseMetadata(response.response), model);
			events.push({ type: "start", partial: output });
			phase = "stream";
			for await (const chunk of response.data) processChunk(chunk, model, output, events);
			options?.signal?.throwIfAborted();
			endTextOrThinking(output, events);
			endToolCalls(output, events);
			if (output.stopReason === "pending") throw new Error("OpenAI Completions stream ended without a stop reason");
			if (output.stopReason === "error")
				throw new Error(`OpenAI finish reason: ${output.rawStopReason ?? "unknown"}`);
			stripStreamingState(output);
			const reason = output.stopReason;
			if (reason !== "stop" && reason !== "length" && reason !== "toolUse" && reason !== "deferred") {
				throw new Error(`Unexpected OpenAI Completions stop reason: ${reason}`);
			}
			events.push({ type: "done", reason, message: output });
		} catch (error) {
			stripStreamingState(output);
			terminateStream(events, output, model, error, options, phase);
		}
	})();
	return events;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
		thinkingBudgets: options?.thinkingBudgets,
	});
};
