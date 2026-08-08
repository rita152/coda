// Portions derived from Pi:
// /packages/ai/src/api/anthropic-messages.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import Anthropic from "@anthropic-ai/sdk";
import type {
	Tool as AnthropicTool,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages.js";
import { parse } from "partial-json";

import { AssistantMessageEventStream } from "../event-stream.ts";
import { retryProviderRequest } from "../provider-retry.ts";
import type {
	AnthropicOptions,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
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
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";

export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "../types.ts";

type StreamingToolCall = ToolCall & { providerIndex: number; partialJson: string };
type StreamingBlock = (TextContent | ThinkingContent | StreamingToolCall) & { providerIndex: number };

function anthropicHeaders(model: Model<"anthropic-messages">, options?: AnthropicOptions) {
	const affinity: Record<string, string> = {};
	if (options?.sessionId && model.compat?.sendSessionAffinityHeaders) {
		affinity["x-session-affinity"] = options.sessionId;
	}
	return mergeProviderHeaders(affinity, model.headers, options?.headers);
}

function userContent(content: string | (TextContent | ImageContent)[]): MessageParam["content"] {
	if (typeof content === "string") return content;
	return content.map((block) =>
		block.type === "text"
			? { type: "text" as const, text: block.text }
			: {
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
						data: block.data,
					},
				},
	);
}

function assistantContent(message: AssistantMessage): ContentBlockParam[] {
	return message.content.flatMap((block): ContentBlockParam[] => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		if (block.type === "toolCall") {
			return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
		}
		if (!block.thinkingSignature) return [];
		return [{ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature }];
	});
}

function toolResultContent(message: ToolResultMessage): ContentBlockParam[] {
	return [
		{
			type: "tool_result",
			tool_use_id: message.toolCallId,
			is_error: message.isError,
			content: message.content.map((block) =>
				block.type === "text"
					? { type: "text" as const, text: block.text }
					: {
							type: "image" as const,
							source: {
								type: "base64" as const,
								media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: block.data,
							},
						},
			),
		},
	];
}

function convertMessages(context: Context): MessageParam[] {
	const converted = context.messages.map((message): MessageParam => {
		if (message.role === "user") return { role: "user", content: userContent(message.content) };
		if (message.role === "assistant") return { role: "assistant", content: assistantContent(message) };
		return { role: "user", content: toolResultContent(message) };
	});
	const merged: MessageParam[] = [];
	for (const message of converted) {
		const previous = merged.at(-1);
		if (previous?.role !== message.role) {
			merged.push(message);
			continue;
		}
		const prior =
			typeof previous.content === "string" ? [{ type: "text" as const, text: previous.content }] : previous.content;
		const next =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		previous.content = [...prior, ...next];
	}
	return merged;
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(context.systemPrompt ? { system: context.systemPrompt } : {}),
		...(context.tools?.length
			? {
					tools: context.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						input_schema: tool.parameters as unknown as AnthropicTool["input_schema"],
					})),
				}
			: {}),
		...(options?.temperature !== undefined && !options.thinkingEnabled && model.compat?.supportsTemperature !== false
			? { temperature: options.temperature }
			: {}),
		...(options?.toolChoice
			? {
					tool_choice:
						typeof options.toolChoice === "string"
							? { type: options.toolChoice }
							: { type: "tool", name: options.toolChoice.name },
				}
			: {}),
	};
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			if (model.compat?.forceAdaptiveThinking) {
				params.thinking = { type: "adaptive", display: options.thinkingDisplay ?? "summarized" };
				if (options.effort) {
					params.output_config = { effort: options.effort } as NonNullable<
						MessageCreateParamsStreaming["output_config"]
					>;
				}
			} else {
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens ?? 1_024,
					display: options.thinkingDisplay ?? "summarized",
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}
	return params;
}

function partialArguments(value: string): Record<string, any> {
	if (!value) return {};
	const parsed = parse(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function finalArguments(value: string): Record<string, any> {
	if (!value) return {};
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Tool arguments must be an object");
	return parsed as Record<string, any>;
}

function mapStopReason(
	reason: string | null | undefined,
	stopDetails?: { explanation?: string } | null,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	if (!reason) return { stopReason: "pending" };
	if (reason === "tool_use") return { stopReason: "toolUse" };
	if (reason === "max_tokens") return { stopReason: "length" };
	if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return { stopReason: "stop" };
	if (reason === "refusal") {
		return {
			stopReason: "error",
			errorMessage: stopDetails?.explanation ?? "The model refused to complete the request",
		};
	}
	if (reason === "sensitive") return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
	throw new Error(`Unhandled stop reason: ${reason}`);
}

function stripStreamingState(output: AssistantMessage): void {
	for (const block of output.content) {
		delete (block as { providerIndex?: number }).providerIndex;
		delete (block as { partialJson?: string }).partialJson;
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (model, context, options) => {
	const events = new AssistantMessageEventStream();
	const output = createOutput(model, options.runtime.clock);
	void (async () => {
		let phase = "request";
		try {
			options?.signal?.throwIfAborted();
			const apiKey = options?.client ? undefined : requireApiKey(model.provider, options?.apiKey);
			const client =
				options?.client ??
				new Anthropic({
					apiKey,
					baseURL: model.baseUrl,
					fetch: options?.fetch,
					defaultHeaders: requestHeaders(anthropicHeaders(model, options)),
					maxRetries: 0,
				});
			let params = buildParams(model, context, options);
			const transformed = await options?.onPayload?.(params, model);
			if (transformed !== undefined) params = transformed as MessageCreateParamsStreaming;
			const response = await retryProviderRequest(
				() =>
					client.messages
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
			const blocks = output.content as StreamingBlock[];
			for await (const event of response.data) processEvent(event, model, output, blocks, events);
			options?.signal?.throwIfAborted();
			if (output.stopReason === "pending") throw new Error("Anthropic stream ended without a stop reason");
			if (output.stopReason === "error") throw new Error(output.errorMessage ?? "Anthropic request failed");
			stripStreamingState(output);
			const reason = output.stopReason;
			if (reason !== "stop" && reason !== "length" && reason !== "toolUse" && reason !== "deferred") {
				throw new Error(`Unexpected Anthropic stop reason: ${reason}`);
			}
			events.push({ type: "done", reason, message: output });
		} catch (error) {
			stripStreamingState(output);
			terminateStream(events, output, model, error, options, phase);
		}
	})();
	return events;
};

function processEvent(
	event: RawMessageStreamEvent,
	model: Model<"anthropic-messages">,
	output: AssistantMessage,
	blocks: StreamingBlock[],
	events: AssistantMessageEventStream,
): void {
	if (event.type === "message_start") {
		output.responseId = event.message.id;
		output.usage.input = event.message.usage.input_tokens ?? 0;
		output.usage.output = event.message.usage.output_tokens ?? 0;
		output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
		output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
	} else if (event.type === "content_block_start") {
		const source = event.content_block;
		if (source.type === "text") {
			output.content.push({ type: "text", text: source.text ?? "", providerIndex: event.index } as StreamingBlock);
			events.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		} else if (source.type === "thinking") {
			output.content.push({
				type: "thinking",
				thinking: source.thinking ?? "",
				thinkingSignature: source.signature ?? "",
				providerIndex: event.index,
			} as StreamingBlock);
			events.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		} else if (source.type === "redacted_thinking") {
			output.content.push({
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: source.data,
				redacted: true,
				providerIndex: event.index,
			} as StreamingBlock);
			events.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		} else if (source.type === "tool_use") {
			output.content.push({
				type: "toolCall",
				id: source.id,
				name: source.name,
				arguments: (source.input as Record<string, any>) ?? {},
				partialJson: "",
				providerIndex: event.index,
			} as StreamingBlock);
			events.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
		}
	} else if (event.type === "content_block_delta") {
		const index = blocks.findIndex((block) => block.providerIndex === event.index);
		const block = blocks[index];
		if (!block) return;
		if (event.delta.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			events.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
		} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			events.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
		} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = `${block.thinkingSignature ?? ""}${event.delta.signature}`;
		} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = partialArguments(block.partialJson);
			events.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
		}
	} else if (event.type === "content_block_stop") {
		const index = blocks.findIndex((block) => block.providerIndex === event.index);
		const block = blocks[index];
		if (!block) return;
		if (block.type === "text") {
			events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
		} else {
			block.arguments = finalArguments(block.partialJson);
			const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
			events.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
		}
	} else if (event.type === "message_delta") {
		output.rawStopReason = event.delta.stop_reason ?? undefined;
		const mapped = mapStopReason(
			event.delta.stop_reason,
			(event.delta as typeof event.delta & { stop_details?: { explanation?: string } | null }).stop_details,
		);
		output.stopReason = mapped.stopReason;
		output.errorMessage = mapped.errorMessage;
		output.usage.output = event.usage.output_tokens ?? output.usage.output;
		const usage = event.usage as typeof event.usage & {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			output_tokens_details?: { thinking_tokens?: number };
		};
		output.usage.input = usage.input_tokens ?? output.usage.input;
		output.usage.cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead;
		output.usage.cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
		output.usage.reasoning = usage.output_tokens_details?.thinking_tokens;
	}
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const reasoning = options?.reasoning;
	if (!reasoning) return stream(model, context, { ...base, thinkingEnabled: false });
	if (model.compat?.forceAdaptiveThinking) {
		const mapped = model.thinkingLevelMap?.[reasoning];
		const effort: NonNullable<AnthropicOptions["effort"]> =
			typeof mapped === "string"
				? (mapped as NonNullable<AnthropicOptions["effort"]>)
				: reasoning === "minimal" || reasoning === "low"
					? "low"
					: reasoning === "medium"
						? "medium"
						: "high";
		return stream(model, context, { ...base, thinkingEnabled: true, effort });
	}
	const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, reasoning, options?.thinkingBudgets);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1_024)),
	});
};
