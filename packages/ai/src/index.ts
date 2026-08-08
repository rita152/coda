export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

export { defaultProviderAuthContext } from "./auth/context.ts";
export { InMemoryCredentialStore } from "./auth/credential-store.ts";
export { envApiKeyAuth } from "./auth/helpers.ts";
export type * from "./auth/oauth-types.ts";
export type * from "./auth/types.ts";
export type {
	AssistantMessageDiagnostic,
	DiagnosticErrorInfo,
} from "./diagnostics.ts";
export { ModelsError, type ModelsErrorCode } from "./errors.ts";
export { AssistantMessageEventStream, createAssistantMessageEventStream, EventStream } from "./event-stream.ts";
export {
	createFauxCore,
	type FauxAssistantMessageOptions,
	type FauxContentBlock,
	type FauxCore,
	type FauxIdGenerator,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxProviderOptions,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	type FauxToolCallOptions,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "./faux.ts";
export { type LazyApiCapabilities, lazyApi, lazyStream } from "./lazy.ts";
export {
	type CreateModelsOptions,
	createModels,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type MutableModels,
} from "./models.ts";
export type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "./models-store.ts";
export { type CreateProviderOptions, createProvider, type Provider, type RefreshModelsContext } from "./provider.ts";
export type * from "./types.ts";
export { validateToolArguments, validateToolCall } from "./validation.ts";
