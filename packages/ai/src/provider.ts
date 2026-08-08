// Portions derived from Pi:
// /packages/ai/src/models.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import type { Credential, ProviderAuth } from "./auth/types.ts";
import { ModelsError } from "./errors.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { lazyStream } from "./lazy.ts";
import type {
	Api,
	ApiStreamOptions,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	ProviderHeaders,
	ProviderStreams,
	SimpleStreamOptions,
} from "./types.ts";

export interface RefreshModelsContext {
	credential?: Credential;
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
}

export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;
	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;
	readonly auth: ProviderAuth;
	getModels(): readonly Model<TApi>[];
	refreshModels?(context: RefreshModelsContext): Promise<void>;
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];
	stream<T extends TApi>(model: Model<T>, context: Context, options: ApiStreamOptions<T>): AssistantMessageEventStream;
	streamSimple(model: Model<TApi>, context: Context, options: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<TApi>,
		handle: DeferredHandle,
		options: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<TApi>, handle: DeferredHandle, options: DeferredCancelOptions): Promise<void>;
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	auth: ProviderAuth;
	models: readonly Model<TApi>[];
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		options: SimpleStreamOptions | ApiStreamOptions<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const implementation = apiFor(model);
		if (implementation) return run(implementation);
		return lazyStream(
			model,
			async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			},
			options,
		);
	};

	return {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => input.models,
		filterModels: input.filterModels,
		stream: (model, context, options) =>
			dispatch(model, options, (implementation) => implementation.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, options, (implementation) => implementation.streamSimple(model, context, options)),
	};
}
