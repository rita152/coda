// Portions derived from Pi:
// /packages/ai/src/api/openai-responses.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { parse } from "partial-json";

import { AssistantMessageEventStream } from "../event-stream.ts";
import { retryProviderRequest } from "../provider-retry.ts";
import { modelToolResultText } from "../tool-observation.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAIResponsesOptions,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	TextSignatureV1,
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

export type { OpenAIResponsesOptions } from "../types.ts";

type StreamingToolCall = ToolCall & { partialJson: string };
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
type OutputSlot =
	| { type: "text"; contentIndex: number; block: TextContent }
	| { type: "thinking"; contentIndex: number; block: ThinkingContent }
	| { type: "toolCall"; contentIndex: number; block: StreamingToolCall };

function encodeTextSignature(id: string, phase?: TextSignatureV1["phase"]): string {
	return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) } satisfies TextSignatureV1);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				const phase = parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
				return { id: parsed.id, ...(phase ? { phase } : {}) };
			}
		} catch {
			// Legacy signatures were plain provider message ids.
		}
	}
	return { id: signature };
}

function responseCallId(id: string): { callId: string; itemId?: string } {
	const separator = id.indexOf("|");
	if (separator < 0) return { callId: id };
	return { callId: id.slice(0, separator), itemId: id.slice(separator + 1) };
}

function inputText(content: Extract<Context["messages"][number], { role: "user" }>["content"]): unknown[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.flatMap((block) => {
		if (block.type === "skill") return [];
		return [
			block.type === "text"
				? { type: "input_text", text: block.text }
				: { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}`, detail: "auto" },
		];
	});
}

function convertInput(context: Context): ResponseInput {
	const input: unknown[] = [];
	for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
		const message = context.messages[messageIndex]!;
		if (message.role === "user") {
			input.push({ role: "user", content: inputText(message.content) });
			continue;
		}
		if (message.role === "toolResult") {
			input.push({
				type: "function_call_output",
				call_id: responseCallId(message.toolCallId).callId,
				output: modelToolResultText(message),
			});
			continue;
		}
		let textIndex = 0;
		for (const block of message.content) {
			if (block.type === "thinking") {
				if (!block.thinkingSignature) continue;
				try {
					input.push(JSON.parse(block.thinkingSignature) as unknown);
				} catch {
					// An invalid provider signature cannot be safely replayed.
				}
			} else if (block.type === "text") {
				const parsed = parseTextSignature(block.textSignature);
				const id = (parsed?.id ?? `msg_pi_${messageIndex}_${textIndex}`).slice(0, 64);
				textIndex++;
				input.push({
					type: "message",
					role: "assistant",
					status: "completed",
					id,
					...(parsed?.phase ? { phase: parsed.phase } : {}),
					content: [{ type: "output_text", text: block.text, annotations: [] }],
				});
			} else {
				const ids = responseCallId(block.id);
				input.push({
					type: "function_call",
					call_id: ids.callId,
					...(ids.itemId ? { id: ids.itemId } : {}),
					name: block.name,
					arguments: JSON.stringify(block.arguments),
					status: "completed",
				});
			}
		}
	}
	return input as ResponseInput;
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): ResponseCreateParamsStreaming {
	const params = {
		model: model.id,
		input: convertInput(context),
		stream: true,
		store: false,
		...(context.systemPrompt ? { instructions: context.systemPrompt } : {}),
		...(context.tools?.length
			? {
					tools: context.tools.map((tool) => ({
						type: "function" as const,
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters as Record<string, unknown>,
						strict: model.compat?.supportsStrictMode ?? false,
					})),
				}
			: {}),
		...(options?.maxTokens !== undefined
			? { max_output_tokens: Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS) }
			: {}),
		...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
		...(options?.reasoningEffort
			? {
					reasoning: {
						effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
						summary: options.reasoningSummary || "auto",
					},
					include: ["reasoning.encrypted_content"],
				}
			: {}),
		...(options?.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
		...(options?.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
		...options?.samplingParams,
	} as ResponseCreateParamsStreaming;
	if (!options?.reasoningEffort && model.reasoning && model.thinkingLevelMap?.off !== null) {
		params.reasoning = {
			effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
				ResponseCreateParamsStreaming["reasoning"]
			>["effort"],
		};
	}
	return params;
}

function sessionHeaders(
	model: Model<"openai-responses">,
	options?: OpenAIResponsesOptions,
): ProviderHeaders | undefined {
	const generated: ProviderHeaders = {};
	if (options?.sessionId) {
		if (model.compat?.sessionAffinityFormat === "openrouter") {
			generated["x-session-id"] = options.sessionId;
		} else {
			if (model.compat?.sessionAffinityFormat === "openai") generated.session_id = options.sessionId;
			generated["x-client-request-id"] = options.sessionId;
		}
	}
	return mergeProviderHeaders(generated, model.headers, options?.headers);
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

function createSlot(
	outputIndex: number,
	item: ResponseOutputItem,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	slots: Map<number, OutputSlot>,
): OutputSlot | undefined {
	if (item.type === "message") {
		const block: TextContent = { type: "text", text: "" };
		const slot: OutputSlot = { type: "text", contentIndex: output.content.push(block) - 1, block };
		slots.set(outputIndex, slot);
		events.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	if (item.type === "reasoning") {
		const block: ThinkingContent = { type: "thinking", thinking: "" };
		const slot: OutputSlot = { type: "thinking", contentIndex: output.content.push(block) - 1, block };
		slots.set(outputIndex, slot);
		events.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	if (item.type === "function_call") {
		const block: StreamingToolCall = {
			type: "toolCall",
			id: `${item.call_id}|${item.id}`,
			name: item.name,
			arguments: partialArguments(item.arguments),
			partialJson: item.arguments,
		};
		const slot: OutputSlot = { type: "toolCall", contentIndex: output.content.push(block) - 1, block };
		slots.set(outputIndex, slot);
		events.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
		return slot;
	}
	return undefined;
}

function finalizeItem(
	outputIndex: number,
	item: ResponseOutputItem,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	slots: Map<number, OutputSlot>,
): void {
	const slot = slots.get(outputIndex) ?? createSlot(outputIndex, item, output, events, slots);
	if (!slot) return;
	if (item.type === "message" && slot.type === "text") {
		slot.block.text = item.content
			.map((content) => (content.type === "output_text" ? content.text : content.refusal))
			.join("");
		slot.block.textSignature = encodeTextSignature(item.id, item.phase ?? undefined);
		events.push({ type: "text_end", contentIndex: slot.contentIndex, content: slot.block.text, partial: output });
	} else if (item.type === "reasoning" && slot.type === "thinking") {
		slot.block.thinking = item.summary.map((part) => part.text).join("\n\n") || slot.block.thinking;
		slot.block.thinkingSignature = JSON.stringify(item);
		events.push({
			type: "thinking_end",
			contentIndex: slot.contentIndex,
			content: slot.block.thinking,
			partial: output,
		});
	} else if (item.type === "function_call" && slot.type === "toolCall") {
		slot.block.partialJson = item.arguments || slot.block.partialJson;
		slot.block.arguments = finalArguments(slot.block.partialJson);
		delete (slot.block as { partialJson?: string }).partialJson;
		events.push({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: slot.block, partial: output });
	}
	slots.delete(outputIndex);
}

function finalizeResponse(
	response: {
		id?: string;
		model?: string;
		status?: string;
		incomplete_details?: { reason?: string } | null;
		usage?: {
			input_tokens: number;
			input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
			output_tokens: number;
			output_tokens_details?: { reasoning_tokens?: number };
			total_tokens: number;
		} | null;
	},
	model: Model<"openai-responses">,
	output: AssistantMessage,
): void {
	if (response.id) output.responseId = response.id;
	if (response.usage) {
		const cached = response.usage.input_tokens_details?.cached_tokens ?? 0;
		const cacheWrite = response.usage.input_tokens_details?.cache_write_tokens ?? 0;
		output.usage.input = Math.max(0, response.usage.input_tokens - cached - cacheWrite);
		output.usage.cacheRead = cached;
		output.usage.cacheWrite = cacheWrite;
		output.usage.output = response.usage.output_tokens;
		output.usage.reasoning = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
		output.usage.totalTokens = response.usage.total_tokens;
		calculateCost(model, output.usage);
	}
	const incompleteReason = response.incomplete_details?.reason;
	output.rawStopReason = incompleteReason ? `${response.status}.${incompleteReason}` : response.status;
	if (response.status === "completed" || response.status === "in_progress" || response.status === "queued") {
		output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
	} else if (response.status === "incomplete" && incompleteReason === "max_output_tokens") {
		output.stopReason = "length";
	} else {
		output.stopReason = "error";
		output.errorMessage = incompleteReason
			? `Response incomplete: ${incompleteReason}`
			: `Response ${response.status}`;
	}
}

function reconcileTerminalOutput(
	items: readonly ResponseOutputItem[],
	output: AssistantMessage,
	events: AssistantMessageEventStream,
	slots: Map<number, OutputSlot>,
): void {
	for (const outputIndex of [...slots.keys()]) {
		const item = items[outputIndex];
		if (item) finalizeItem(outputIndex, item, output, events, slots);
	}
}

async function processStream(
	openAIStream: AsyncIterable<ResponseStreamEvent>,
	model: Model<"openai-responses">,
	output: AssistantMessage,
	events: AssistantMessageEventStream,
): Promise<void> {
	const slots = new Map<number, OutputSlot>();
	let terminal = false;
	for await (const streamEvent of openAIStream) {
		if (streamEvent.type === "response.created") {
			output.responseId = streamEvent.response.id;
		} else if (streamEvent.type === "response.output_item.added") {
			createSlot(streamEvent.output_index, streamEvent.item, output, events, slots);
		} else if (streamEvent.type === "response.output_text.delta" || streamEvent.type === "response.refusal.delta") {
			const slot = slots.get(streamEvent.output_index);
			if (slot?.type === "text") {
				slot.block.text += streamEvent.delta;
				events.push({
					type: "text_delta",
					contentIndex: slot.contentIndex,
					delta: streamEvent.delta,
					partial: output,
				});
			}
		} else if (
			streamEvent.type === "response.reasoning_summary_text.delta" ||
			streamEvent.type === "response.reasoning_text.delta"
		) {
			const slot = slots.get(streamEvent.output_index);
			if (slot?.type === "thinking") {
				slot.block.thinking += streamEvent.delta;
				events.push({
					type: "thinking_delta",
					contentIndex: slot.contentIndex,
					delta: streamEvent.delta,
					partial: output,
				});
			}
		} else if (streamEvent.type === "response.function_call_arguments.delta") {
			const slot = slots.get(streamEvent.output_index);
			if (slot?.type === "toolCall") {
				slot.block.partialJson += streamEvent.delta;
				slot.block.arguments = partialArguments(slot.block.partialJson);
				events.push({
					type: "toolcall_delta",
					contentIndex: slot.contentIndex,
					delta: streamEvent.delta,
					partial: output,
				});
			}
		} else if (streamEvent.type === "response.function_call_arguments.done") {
			const slot = slots.get(streamEvent.output_index);
			if (slot?.type === "toolCall") {
				const previous = slot.block.partialJson;
				slot.block.partialJson = streamEvent.arguments;
				slot.block.arguments = partialArguments(streamEvent.arguments);
				if (streamEvent.arguments.startsWith(previous) && streamEvent.arguments.length > previous.length) {
					events.push({
						type: "toolcall_delta",
						contentIndex: slot.contentIndex,
						delta: streamEvent.arguments.slice(previous.length),
						partial: output,
					});
				}
			}
		} else if (streamEvent.type === "response.output_item.done") {
			finalizeItem(streamEvent.output_index, streamEvent.item, output, events, slots);
		} else if (streamEvent.type === "response.completed" || streamEvent.type === "response.incomplete") {
			terminal = true;
			reconcileTerminalOutput(streamEvent.response.output, output, events, slots);
			finalizeResponse(streamEvent.response, model, output);
		} else if (streamEvent.type === "response.failed") {
			terminal = true;
			throw Object.assign(new Error(streamEvent.response.error?.message ?? "OpenAI Responses request failed"), {
				code: streamEvent.response.error?.code,
			});
		} else if (streamEvent.type === "error") {
			throw Object.assign(new Error(`${streamEvent.code}: ${streamEvent.message}`), { code: streamEvent.code });
		}
	}
	if (!terminal) throw new Error("OpenAI Responses stream ended before a terminal response event");
	if (slots.size) throw new Error("OpenAI Responses stream ended with unfinished output items");
}

function stripStreamingState(output: AssistantMessage): void {
	for (const block of output.content) delete (block as { partialJson?: string }).partialJson;
}

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options) => {
	const events = new AssistantMessageEventStream();
	const output = createOutput(model, options.runtime.clock);
	void (async () => {
		let phase = "request";
		try {
			options?.signal?.throwIfAborted();
			const apiKey = requireApiKey(model.provider, options?.apiKey);
			const client = new OpenAI({
				apiKey,
				baseURL: model.baseUrl,
				fetch: options?.fetch,
				defaultHeaders: requestHeaders(sessionHeaders(model, options)),
				maxRetries: 0,
			});
			let params = buildParams(model, context, options);
			const transformed = await options?.onPayload?.(params, model);
			if (transformed !== undefined) params = transformed as ResponseCreateParamsStreaming;
			const response = await retryProviderRequest(
				() =>
					client.responses
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
			await processStream(response.data, model, output, events);
			options?.signal?.throwIfAborted();
			if (output.stopReason === "pending") throw new Error("OpenAI Responses stream ended without a stop reason");
			if (output.stopReason === "error") throw new Error(output.errorMessage ?? "OpenAI Responses request failed");
			stripStreamingState(output);
			const reason = output.stopReason;
			if (reason !== "stop" && reason !== "length" && reason !== "toolUse" && reason !== "deferred") {
				throw new Error(`Unexpected OpenAI Responses stop reason: ${reason}`);
			}
			events.push({ type: "done", reason, message: output });
		} catch (error) {
			stripStreamingState(output);
			terminateStream(events, output, model, error, options, phase);
		}
	})();
	return events;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return stream(model, context, {
		...base,
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
	});
};
