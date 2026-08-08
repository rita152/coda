// Portions derived from Pi:
// /packages/ai/src/types.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { TSchema } from "typebox";

import type { AssistantMessageDiagnostic } from "./diagnostics.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import type { TelemetryContext } from "./telemetry.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

export type Api = KnownApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";

export type ProviderId = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| { $var: "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean };

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type CacheRetention = "none" | "short" | "long";
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface Clock {
	now(): number;
}

export interface Sleeper {
	wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface RandomSource {
	next(): number;
}

export interface TimeRuntime {
	readonly clock: Clock;
	readonly sleep: Sleeper;
	readonly random: RandomSource;
}

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface ProviderRequestOptions<TModel = Model<Api>> {
	runtime: TimeRuntime;
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	fetch?: FetchFunction;
	env?: ProviderEnv;
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	headers?: ProviderHeaders;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	debugDiagnostics?: boolean;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	transport?: Transport;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	websocketConnectTimeoutMs?: number;
	metadata?: Record<string, unknown>;
}

export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	thinkingBudgets?: ThinkingBudgets;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	effort?: AnthropicEffort;
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	client?: Anthropic;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
}

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: ThinkingLevel;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

export type UnsupportedApiOptions = StreamOptions & Record<string, unknown>;
export type AzureOpenAIResponsesOptions = UnsupportedApiOptions;
export type BedrockOptions = UnsupportedApiOptions;
export type BedrockThinkingDisplay = "summarized" | "omitted";
export type GoogleOptions = UnsupportedApiOptions;
export type GoogleThinkingLevel = ThinkingLevel;
export type GoogleVertexOptions = UnsupportedApiOptions;
export type MistralOptions = UnsupportedApiOptions;
export type OpenAICodexResponsesOptions = UnsupportedApiOptions;
export interface OpenAICodexWebSocketDebugStats {
	connectCount: number;
	reconnectCount: number;
	requestCount: number;
}
export interface PiMessagesEvent {
	type: string;
	[key: string]: unknown;
}
export type PiMessagesOptions = UnsupportedApiOptions;
export interface PiMessagesRewriteImpact {
	rewritten: boolean;
	reason?: string;
}

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	wait?: number;
}

export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options: DeferredCancelOptions): Promise<void>;
}

export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options: TOptions,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: JsonValue;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	usage?: Usage;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type GrammarFormat = "openai_lark" | "openai_regex";
export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

export type ConstrainedSamplingConfig =
	| { type: "json_schema"; strict: "prefer" | "require" }
	| { type: "grammar"; variants: GrammarVariants };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface OpenAICompletionsCompat {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	supportsFinishReason?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "baseten"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
	openRouterRouting?: OpenRouterRouting;
	vercelGatewayRouting?: VercelGatewayRouting;
	zaiToolStream?: boolean;
	supportsThinkingTokenBudget?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsStrictMode?: boolean;
	cacheControlFormat?: "anthropic";
	sendSessionAffinityHeaders?: boolean;
	deferredToolsMode?: "kimi";
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
}

export interface OpenRouterRouting {
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "deny" | "allow";
	zdr?: boolean;
	enforce_distillable_text?: boolean;
	order?: string[];
	only?: string[];
	ignore?: string[];
	quantizations?: string[];
	sort?: string | { by?: string; partition?: string | null };
	max_price?: {
		prompt?: number | string;
		completion?: number | string;
		image?: number | string;
		audio?: number | string;
		request?: number | string;
	};
	preferred_min_throughput?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
	preferred_max_latency?: number | { p50?: number; p75?: number; p90?: number; p99?: number };
}

export interface VercelGatewayRouting {
	only?: string[];
	order?: string[];
}

export interface OpenAIResponsesCompat {
	supportsDeveloperRole?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsToolSearch?: boolean;
	supportsExplicitPromptCacheMode?: boolean;
}

export interface AnthropicMessagesCompat {
	supportsEagerToolInputStreaming?: boolean;
	supportsLongCacheRetention?: boolean;
	sendSessionAffinityHeaders?: boolean;
	supportsCacheControlOnTools?: boolean;
	supportsTemperature?: boolean;
	forceAdaptiveThinking?: boolean;
	allowEmptySignature?: boolean;
	supportsStrictTools?: boolean;
	supportsToolReferences?: boolean;
}

export interface BedrockCompat {
	supportsStrictMode?: boolean;
}

export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	tiers?: ModelCostTier[];
}

export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: never;
}
