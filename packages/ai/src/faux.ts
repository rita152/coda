// Portions derived from Pi:
// /packages/ai/src/providers/faux.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { emptyUsage } from "./api/shared.ts";
import { createStreamDiagnostic } from "./diagnostics.ts";
import { type AssistantMessageEventStream, createAssistantMessageEventStream } from "./event-stream.ts";
import { createProvider, type Provider } from "./provider.ts";
import type {
	AssistantMessage,
	Clock,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TextContent,
	ThinkingContent,
	TimeRuntime,
	ToolCall,
} from "./types.ts";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";

export interface FauxModelDefinition {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export interface FauxIdGenerator {
	generate(): string;
}

export type FauxToolCallOptions = { id: string; idGenerator?: never } | { id?: never; idGenerator: FauxIdGenerator };

export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: FauxToolCallOptions): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? options.idGenerator.generate(),
		name,
		arguments: arguments_,
	};
}

function normalizeContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") return [fauxText(content)];
	return Array.isArray(content) ? content : [content];
}

interface FauxAssistantMessageFields {
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	responseId?: string;
}

export type FauxAssistantMessageOptions = FauxAssistantMessageFields &
	({ timestamp: number; clock?: never } | { timestamp?: never; clock: Clock });

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: FauxAssistantMessageOptions,
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeContent(content),
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: emptyUsage(),
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		responseId: options.responseId,
		timestamp: options.timestamp ?? options.clock.now(),
	};
}

export interface FauxProviderState {
	callCount: number;
}

export type FauxResponseFactory = (
	context: Context,
	options: SimpleStreamOptions,
	state: FauxProviderState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface FauxProviderOptions {
	runtime: TimeRuntime;
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	chunkCharacters?: number;
}

export interface FauxProviderHandle {
	provider: Provider;
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses(responses: FauxResponseStep[]): void;
	appendResponses(responses: FauxResponseStep[]): void;
	getPendingResponseCount(): number;
}

export interface FauxCore extends Omit<FauxProviderHandle, "provider"> {
	provider: string;
	stream: StreamFunction<string, SimpleStreamOptions>;
	streamSimple: StreamFunction<string, SimpleStreamOptions>;
}

function fixedChunks(value: string, size: number): string[] {
	if (value.length === 0) return [""];
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
	return chunks;
}

function nextMicrotask(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

function snapshot(message: AssistantMessage): AssistantMessage {
	return structuredClone(message);
}

export function createFauxCore(options: FauxProviderOptions): FauxCore {
	const api = options.api ?? DEFAULT_API;
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const clock = options.runtime.clock;
	const chunkCharacters = Math.max(1, Math.floor(options.chunkCharacters ?? 16));
	const definitions = options.models?.length
		? options.models
		: [{ id: DEFAULT_MODEL_ID, name: "Faux Model", input: ["text", "image"] as ("text" | "image")[] }];
	const models = definitions.map((definition) => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: "http://localhost:0",
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128_000,
		maxTokens: definition.maxTokens ?? 16_384,
	})) as [Model<string>, ...Model<string>[]];
	const state: FauxProviderState = { callCount: 0 };
	let responses: FauxResponseStep[] = [];

	const stream: StreamFunction<string, SimpleStreamOptions> = (model, context, streamOptions) => {
		const output = createAssistantMessageEventStream();
		const step = responses.shift();
		state.callCount++;
		queueMicrotask(() => {
			void runFauxStream(output, model, context, streamOptions, step, state, clock, chunkCharacters).catch(
				(error) => {
					terminateError(output, model, error, streamOptions, clock);
				},
			);
		});
		return output;
	};

	function getModel(): Model<string>;
	function getModel(modelId: string): Model<string> | undefined;
	function getModel(modelId?: string): Model<string> | undefined {
		return modelId === undefined ? models[0] : models.find((candidate) => candidate.id === modelId);
	}

	return {
		api,
		provider,
		models,
		stream,
		streamSimple: stream,
		getModel,
		state,
		setResponses(next) {
			responses = [...next];
		},
		appendResponses(next) {
			responses.push(...next);
		},
		getPendingResponseCount() {
			return responses.length;
		},
	};
}

async function runFauxStream(
	stream: AssistantMessageEventStream,
	model: Model<string>,
	context: Context,
	options: SimpleStreamOptions,
	step: FauxResponseStep | undefined,
	state: FauxProviderState,
	clock: Clock,
	chunkCharacters: number,
): Promise<void> {
	options.signal?.throwIfAborted();
	await options.onResponse?.({ status: 200, headers: {} }, model);
	if (!step) throw new Error("No more faux responses queued");
	const scripted = typeof step === "function" ? await step(context, options, state, model) : step;
	const message: AssistantMessage = {
		...structuredClone(scripted),
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: scripted.timestamp ?? clock.now(),
	};
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	stream.push({ type: "start", partial: snapshot(partial) });

	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index]!;
		if (block.type === "thinking") {
			partial.content.push({ type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: index, partial: snapshot(partial) });
			for (const chunk of fixedChunks(block.thinking, chunkCharacters)) {
				await nextMicrotask();
				if (options.signal?.aborted) return terminateAborted(stream, partial, clock);
				(partial.content[index] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: snapshot(partial) });
			}
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: snapshot(partial),
			});
			continue;
		}
		if (block.type === "text") {
			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: index, partial: snapshot(partial) });
			for (const chunk of fixedChunks(block.text, chunkCharacters)) {
				await nextMicrotask();
				if (options.signal?.aborted) return terminateAborted(stream, partial, clock);
				(partial.content[index] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: snapshot(partial) });
			}
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: snapshot(partial) });
			continue;
		}

		partial.content.push({ type: "toolCall", id: block.id, name: block.name, arguments: {} });
		stream.push({ type: "toolcall_start", contentIndex: index, partial: snapshot(partial) });
		for (const chunk of fixedChunks(JSON.stringify(block.arguments), chunkCharacters)) {
			await nextMicrotask();
			if (options.signal?.aborted) return terminateAborted(stream, partial, clock);
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: snapshot(partial) });
		}
		(partial.content[index] as ToolCall).arguments = structuredClone(block.arguments);
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: structuredClone(block),
			partial: snapshot(partial),
		});
	}

	if (options.signal?.aborted) return terminateAborted(stream, partial, clock);
	if (message.stopReason === "error") {
		if (!message.diagnostics?.length) {
			const error = new Error(message.errorMessage ?? "Faux response failed");
			message.diagnostics = [
				createStreamDiagnostic(model, error, {
					phase: "stream",
					clock: options.runtime.clock,
					debug: options.debugDiagnostics,
				}),
			];
		}
		stream.push({ type: "error", reason: "error", error: message });
		return;
	}
	if (message.stopReason === "aborted") {
		delete message.diagnostics;
		delete message.errorMessage;
		stream.push({ type: "error", reason: "aborted", error: message });
		return;
	}
	if (message.stopReason === "pending") throw new Error("Faux response ended without a stop reason");
	stream.push({ type: "done", reason: message.stopReason, message });
}

function terminateAborted(stream: AssistantMessageEventStream, partial: AssistantMessage, clock: Clock): void {
	const message: AssistantMessage = {
		...snapshot(partial),
		stopReason: "aborted",
		timestamp: clock.now(),
	};
	delete message.diagnostics;
	stream.push({ type: "error", reason: "aborted", error: message });
}

function terminateError(
	stream: AssistantMessageEventStream,
	model: Model<string>,
	error: unknown,
	options: SimpleStreamOptions,
	clock: Clock,
): void {
	if (options.signal?.aborted) {
		terminateAborted(
			stream,
			{
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "pending",
				timestamp: clock.now(),
			},
			clock,
		);
		return;
	}
	const failure = error instanceof Error ? error : new Error(String(error));
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: failure.message,
		timestamp: options.runtime.clock.now(),
		diagnostics: [
			createStreamDiagnostic(model, failure, {
				phase: "stream",
				clock: options.runtime.clock,
				debug: options.debugDiagnostics,
			}),
		],
	};
	stream.push({ type: "error", reason: "error", error: message });
}

export function fauxProvider(options: FauxProviderOptions): FauxProviderHandle {
	const core = createFauxCore(options);
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: { stream: core.stream, streamSimple: core.streamSimple },
	});
	return { ...core, provider };
}
