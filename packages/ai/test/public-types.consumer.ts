import type {
	AnthropicEffort,
	AnthropicMessagesCompat,
	AnthropicOptions,
	AnthropicThinkingDisplay,
	Api,
	ApiKeyAuth,
	ApiKeyCredential,
	ApiOptionsMap,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageDiagnostic,
	AssistantMessageEvent,
	AuthCheck,
	AuthContext,
	AuthEvent,
	AuthInfoLink,
	AuthInteraction,
	AuthOperationOptions,
	AuthPrompt,
	AuthResult,
	AuthType,
	AzureOpenAIResponsesOptions,
	BedrockCompat,
	BedrockOptions,
	BedrockThinkingDisplay,
	CacheRetention,
	ChatTemplateKwargValue,
	Clock,
	ConstrainedSamplingConfig,
	Context,
	CreateModelsOptions,
	CreateProviderOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	DiagnosticErrorInfo,
	FauxAssistantMessageOptions,
	FauxContentBlock,
	FauxCore,
	FauxIdGenerator,
	FauxModelDefinition,
	FauxProviderHandle,
	FauxProviderOptions,
	FauxProviderState,
	FauxResponseFactory,
	FauxResponseStep,
	FauxToolCallOptions,
	FetchFunction,
	GoogleOptions,
	GoogleThinkingLevel,
	GoogleVertexOptions,
	GrammarFormat,
	GrammarVariants,
	ImageContent,
	JsonValue,
	KnownApi,
	KnownProvider,
	LazyApiCapabilities,
	Message,
	MistralOptions,
	Model,
	ModelAuth,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	Models,
	ModelsApiStreamOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsErrorCode,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsRequestTransforms,
	ModelsSimpleStreamOptions,
	ModelsStore,
	ModelsStoreEntry,
	ModelsStoreOperationOptions,
	ModelThinkingLevel,
	MutableModels,
	OAuthAuth,
	OAuthAuthInfo,
	OAuthCredential,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
	OpenAICodexResponsesOptions,
	OpenAICodexWebSocketDebugStats,
	OpenAICompletionsCompat,
	OpenAICompletionsOptions,
	OpenAIResponsesCompat,
	OpenAIResponsesOptions,
	OpenRouterRouting,
	PiMessagesEvent,
	PiMessagesOptions,
	PiMessagesRewriteImpact,
	Provider,
	ProviderAuth,
	ProviderAuthInteraction,
	ProviderEnv,
	ProviderHeaders,
	ProviderId,
	ProviderRequestOptions,
	ProviderResponse,
	ProviderStreamOptions,
	ProviderStreams,
	RandomSource,
	RefreshModelsContext,
	SessionAffinityFormat,
	SimpleStreamOptions,
	Sleeper,
	Static,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	TextSignatureV1,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ThinkingLevelMap,
	TimeRuntime,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	TSchema,
	UnsupportedApiOptions,
	Usage,
	UserMessage,
	VercelGatewayRouting,
} from "../src/index.ts";
import { createModels, fauxAssistantMessage, fauxToolCall } from "../src/index.ts";

declare const runtime: TimeRuntime;
declare const fauxIds: FauxIdGenerator;

createModels({ runtime });
fauxAssistantMessage("ready", { clock: runtime.clock });
fauxToolCall("read", { path: "README.md" }, { idGenerator: fauxIds });

// @ts-expect-error Coda deliberately requires explicit runtime capabilities.
createModels();
// @ts-expect-error Coda deliberately requires an explicit timestamp or Clock.
fauxAssistantMessage("ready");
// @ts-expect-error Coda deliberately requires an explicit Provider Tool-call identity source.
fauxToolCall("read", { path: "README.md" });

// This compile-only consumer makes every selected type name part of an external import.
export interface PublicTypeConsumption {
	readonly AnthropicEffort: AnthropicEffort;
	readonly AnthropicMessagesCompat: AnthropicMessagesCompat;
	readonly AnthropicOptions: AnthropicOptions;
	readonly AnthropicThinkingDisplay: AnthropicThinkingDisplay;
	readonly Api: Api;
	readonly ApiKeyAuth: ApiKeyAuth;
	readonly ApiKeyCredential: ApiKeyCredential;
	readonly ApiOptionsMap: ApiOptionsMap;
	readonly ApiStreamOptions: ApiStreamOptions<Api>;
	readonly AssistantMessage: AssistantMessage;
	readonly AssistantMessageDiagnostic: AssistantMessageDiagnostic;
	readonly AssistantMessageEvent: AssistantMessageEvent;
	readonly AuthCheck: AuthCheck;
	readonly AuthContext: AuthContext;
	readonly AuthEvent: AuthEvent;
	readonly AuthInfoLink: AuthInfoLink;
	readonly AuthInteraction: AuthInteraction;
	readonly AuthOperationOptions: AuthOperationOptions;
	readonly AuthPrompt: AuthPrompt;
	readonly AuthResult: AuthResult;
	readonly AuthType: AuthType;
	readonly AzureOpenAIResponsesOptions: AzureOpenAIResponsesOptions;
	readonly BedrockCompat: BedrockCompat;
	readonly BedrockOptions: BedrockOptions;
	readonly BedrockThinkingDisplay: BedrockThinkingDisplay;
	readonly CacheRetention: CacheRetention;
	readonly ChatTemplateKwargValue: ChatTemplateKwargValue;
	readonly Clock: Clock;
	readonly ConstrainedSamplingConfig: ConstrainedSamplingConfig;
	readonly Context: Context;
	readonly CreateModelsOptions: CreateModelsOptions;
	readonly CreateProviderOptions: CreateProviderOptions;
	readonly Credential: Credential;
	readonly CredentialInfo: CredentialInfo;
	readonly CredentialStore: CredentialStore;
	readonly DeferredCancelOptions: DeferredCancelOptions;
	readonly DeferredFetchOptions: DeferredFetchOptions;
	readonly DeferredHandle: DeferredHandle;
	readonly DiagnosticErrorInfo: DiagnosticErrorInfo;
	readonly FauxAssistantMessageOptions: FauxAssistantMessageOptions;
	readonly FauxContentBlock: FauxContentBlock;
	readonly FauxCore: FauxCore;
	readonly FauxIdGenerator: FauxIdGenerator;
	readonly FauxModelDefinition: FauxModelDefinition;
	readonly FauxProviderHandle: FauxProviderHandle;
	readonly FauxProviderOptions: FauxProviderOptions;
	readonly FauxProviderState: FauxProviderState;
	readonly FauxResponseFactory: FauxResponseFactory;
	readonly FauxResponseStep: FauxResponseStep;
	readonly FauxToolCallOptions: FauxToolCallOptions;
	readonly FetchFunction: FetchFunction;
	readonly GoogleOptions: GoogleOptions;
	readonly GoogleThinkingLevel: GoogleThinkingLevel;
	readonly GoogleVertexOptions: GoogleVertexOptions;
	readonly GrammarFormat: GrammarFormat;
	readonly GrammarVariants: GrammarVariants;
	readonly ImageContent: ImageContent;
	readonly JsonValue: JsonValue;
	readonly KnownApi: KnownApi;
	readonly KnownProvider: KnownProvider;
	readonly LazyApiCapabilities: LazyApiCapabilities;
	readonly Message: Message;
	readonly MistralOptions: MistralOptions;
	readonly Model: Model;
	readonly ModelAuth: ModelAuth;
	readonly ModelCost: ModelCost;
	readonly ModelCostRates: ModelCostRates;
	readonly ModelCostTier: ModelCostTier;
	readonly ModelThinkingLevel: ModelThinkingLevel;
	readonly Models: Models;
	readonly ModelsApiStreamOptions: ModelsApiStreamOptions<Api>;
	readonly ModelsDeferredCancelOptions: ModelsDeferredCancelOptions;
	readonly ModelsDeferredFetchOptions: ModelsDeferredFetchOptions;
	readonly ModelsErrorCode: ModelsErrorCode;
	readonly ModelsRefreshOptions: ModelsRefreshOptions;
	readonly ModelsRefreshResult: ModelsRefreshResult;
	readonly ModelsRequestTransforms: ModelsRequestTransforms;
	readonly ModelsSimpleStreamOptions: ModelsSimpleStreamOptions;
	readonly ModelsStore: ModelsStore;
	readonly ModelsStoreEntry: ModelsStoreEntry;
	readonly ModelsStoreOperationOptions: ModelsStoreOperationOptions;
	readonly MutableModels: MutableModels;
	readonly OAuthAuth: OAuthAuth;
	readonly OAuthAuthInfo: OAuthAuthInfo;
	readonly OAuthCredential: OAuthCredential;
	readonly OAuthCredentials: OAuthCredentials;
	readonly OAuthDeviceCodeInfo: OAuthDeviceCodeInfo;
	readonly OAuthLoginCallbacks: OAuthLoginCallbacks;
	readonly OAuthPrompt: OAuthPrompt;
	readonly OAuthSelectOption: OAuthSelectOption;
	readonly OAuthSelectPrompt: OAuthSelectPrompt;
	readonly OpenAICodexResponsesOptions: OpenAICodexResponsesOptions;
	readonly OpenAICodexWebSocketDebugStats: OpenAICodexWebSocketDebugStats;
	readonly OpenAICompletionsCompat: OpenAICompletionsCompat;
	readonly OpenAICompletionsOptions: OpenAICompletionsOptions;
	readonly OpenAIResponsesCompat: OpenAIResponsesCompat;
	readonly OpenAIResponsesOptions: OpenAIResponsesOptions;
	readonly OpenRouterRouting: OpenRouterRouting;
	readonly PiMessagesEvent: PiMessagesEvent;
	readonly PiMessagesOptions: PiMessagesOptions;
	readonly PiMessagesRewriteImpact: PiMessagesRewriteImpact;
	readonly Provider: Provider;
	readonly ProviderAuth: ProviderAuth;
	readonly ProviderAuthInteraction: ProviderAuthInteraction;
	readonly ProviderEnv: ProviderEnv;
	readonly ProviderHeaders: ProviderHeaders;
	readonly ProviderId: ProviderId;
	readonly ProviderRequestOptions: ProviderRequestOptions;
	readonly ProviderResponse: ProviderResponse;
	readonly ProviderStreamOptions: ProviderStreamOptions;
	readonly ProviderStreams: ProviderStreams;
	readonly RandomSource: RandomSource;
	readonly RefreshModelsContext: RefreshModelsContext;
	readonly SessionAffinityFormat: SessionAffinityFormat;
	readonly SimpleStreamOptions: SimpleStreamOptions;
	readonly Sleeper: Sleeper;
	readonly Static: Static<TSchema>;
	readonly StopReason: StopReason;
	readonly StreamFunction: StreamFunction;
	readonly StreamOptions: StreamOptions;
	readonly TSchema: TSchema;
	readonly TextContent: TextContent;
	readonly TextSignatureV1: TextSignatureV1;
	readonly ThinkingBudgets: ThinkingBudgets;
	readonly ThinkingContent: ThinkingContent;
	readonly ThinkingLevel: ThinkingLevel;
	readonly ThinkingLevelMap: ThinkingLevelMap;
	readonly TimeRuntime: TimeRuntime;
	readonly Tool: Tool;
	readonly ToolCall: ToolCall;
	readonly ToolResultMessage: ToolResultMessage;
	readonly Transport: Transport;
	readonly UnsupportedApiOptions: UnsupportedApiOptions;
	readonly Usage: Usage;
	readonly UserMessage: UserMessage;
	readonly VercelGatewayRouting: VercelGatewayRouting;
}
