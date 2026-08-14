// Portions derived from Pi:
// /packages/ai/src/models.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { operationSignal, raceWithAbortSignal } from "./abort.ts";
import { defaultProviderAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, resolveProviderAuth } from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
} from "./auth/types.ts";
import { ModelsError } from "./errors.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { lazyStream } from "./lazy.ts";
import type { ModelsStore } from "./models-store.ts";
import type { Provider } from "./provider.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	ProviderHeaders,
	ProviderRequestOptions,
	SimpleStreamOptions,
	TimeRuntime,
} from "./types.ts";

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	providers?: readonly string[];
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsRequestTransforms {
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
	/** A previously resolved credential view that must remain stable for this request. */
	authSnapshot?: AuthResult;
}

type ModelsRuntimeOverride = { runtime?: TimeRuntime };

export type ModelsApiStreamOptions<TApi extends Api> = Omit<ApiStreamOptions<TApi>, "runtime"> &
	ModelsRuntimeOverride &
	ModelsRequestTransforms;
export type ModelsSimpleStreamOptions = Omit<SimpleStreamOptions, "runtime"> &
	ModelsRuntimeOverride &
	ModelsRequestTransforms;
export type ModelsDeferredFetchOptions = Omit<DeferredFetchOptions, "runtime"> &
	ModelsRuntimeOverride &
	ModelsRequestTransforms;
export type ModelsDeferredCancelOptions = Omit<DeferredCancelOptions, "runtime"> &
	ModelsRuntimeOverride &
	ModelsRequestTransforms;

export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;
	getModels(provider?: string): readonly Model<Api>[];
	getModel(provider: string, id: string): Model<Api> | undefined;
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	/**
	 * Captures the currently registered Provider implementation and authentication
	 * snapshot so later registry replacement cannot change an active Run.
	 */
	bindSimple(
		model: Model<Api>,
		authSnapshot: AuthResult,
	): {
		readonly model: Model<Api>;
		readonly providerGeneration: number;
		stream(context: Context, options?: Omit<ModelsSimpleStreamOptions, "authSnapshot">): AssistantMessageEventStream;
		complete(context: Context, options?: Omit<ModelsSimpleStreamOptions, "authSnapshot">): Promise<AssistantMessage>;
	};
	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;
}

export interface MutableModels extends Models {
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	runtime: TimeRuntime;
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		for (const existing of Object.keys(merged)) {
			if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
		}
		merged[name] = value;
	}
	return merged;
}

class ModelsImpl implements MutableModels {
	private readonly providers = new Map<string, Provider>();
	private readonly providerGenerations = new WeakMap<Provider, number>();
	private readonly credentials: CredentialStore;
	private readonly authContext: AuthContext;
	private readonly runtime: TimeRuntime;
	private nextProviderGeneration = 0;

	constructor(options: CreateModelsOptions) {
		this.credentials = options.credentials ?? new InMemoryCredentialStore();
		this.authContext = options.authContext ?? defaultProviderAuthContext();
		this.runtime = options.runtime;
	}

	setProvider(provider: Provider): void {
		this.providers.set(provider.id, provider);
		this.providerGenerations.set(provider, ++this.nextProviderGeneration);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return [...this.providers.values()];
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider) {
			try {
				return this.providers.get(provider)?.getModels() ?? [];
			} catch {
				return [];
			}
		}
		return this.getProviders().flatMap((entry) => {
			try {
				return [...entry.getModels()];
			} catch {
				return [];
			}
		});
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const signal = operationSignal(options.signal);
		const errors = new Map<string, Error>();
		if (signal.aborted) return { aborted: true, errors };
		const selected = options.providers ? new Set(options.providers) : undefined;
		for (const provider of this.providers.values()) {
			if (!provider.refreshModels || (selected && !selected.has(provider.id))) continue;
			try {
				await raceWithAbortSignal(
					provider.refreshModels({
						allowNetwork: options.allowNetwork ?? true,
						force: options.force,
						signal,
					}),
					signal,
				);
			} catch (error) {
				if (!signal.aborted) errors.set(provider.id, error instanceof Error ? error : new Error(String(error)));
			}
		}
		return { aborted: signal.aborted, errors };
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const stored = await this.credentials.read(providerId, { signal });
		if (stored?.type === "oauth") return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		if (provider.auth.apiKey?.check) {
			return provider.auth.apiKey.check({
				ctx: this.authContext,
				credential: stored?.type === "api_key" ? stored : undefined,
				signal,
			});
		}
		const resolved = await this.getAuth(providerId, { signal });
		return resolved ? { source: resolved.source, type: "api_key" } : undefined;
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const providers = providerId
			? ([this.providers.get(providerId)].filter((entry): entry is Provider => entry !== undefined) as Provider[])
			: this.getProviders();
		const available: Model<Api>[] = [];
		for (const provider of providers) {
			if (!(await this.checkAuth(provider.id, options))) continue;
			const stored = await this.credentials.read(provider.id, options);
			available.push(...(provider.filterModels?.(provider.getModels(), stored) ?? provider.getModels()));
		}
		return available;
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, {
			...overrides,
			clock: overrides?.clock ?? this.runtime.clock,
		});
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: { ...result.auth, headers: mergeHeaders(result.auth.headers, providerOrModel.headers) },
		};
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		let login: Promise<Credential>;
		if (type === "oauth") {
			if (!provider.auth.oauth) throw new ModelsError("auth", `${provider.name} does not support oauth login`);
			login = provider.auth.oauth.login({ ...interaction, signal });
		} else {
			if (!provider.auth.apiKey?.login) {
				throw new ModelsError("auth", `${provider.name} does not support api_key login`);
			}
			login = provider.auth.apiKey.login({ ...interaction, signal });
		}
		const credential = await raceWithAbortSignal(login, signal);
		await this.credentials.modify(providerId, async () => credential, { signal });
		return credential;
	}

	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.credentials.delete(providerId, options);
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				const provider = this.requireProvider(model);
				const applied = await this.applyAuth(model, options);
				return provider.stream(applied.model as Model<TApi>, context, applied.options as ApiStreamOptions<TApi>);
			},
			{ ...options, runtime: options?.runtime ?? this.runtime, phase: "auth" },
		);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(
			model,
			async () => {
				const provider = this.requireProvider(model);
				const applied = await this.applyAuth(model, options);
				return provider.streamSimple(applied.model, context, applied.options as SimpleStreamOptions);
			},
			{ ...options, runtime: options?.runtime ?? this.runtime, phase: "auth" },
		);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	bindSimple(model: Model<Api>, authSnapshot: AuthResult) {
		const provider = this.requireProvider(model);
		const providerGeneration = this.providerGenerations.get(provider);
		if (providerGeneration === undefined) {
			throw new ModelsError("provider", `Provider generation is unavailable: ${model.provider}`);
		}
		const stream = (
			context: Context,
			options?: Omit<ModelsSimpleStreamOptions, "authSnapshot">,
		): AssistantMessageEventStream =>
			lazyStream(
				model,
				async () => {
					const applied = await this.applyAuth(model, { ...options, authSnapshot });
					return provider.streamSimple(applied.model, context, applied.options as SimpleStreamOptions);
				},
				{ ...options, runtime: options?.runtime ?? this.runtime, phase: "auth" },
			);
		return Object.freeze({
			model,
			providerGeneration,
			stream,
			complete: (context: Context, options?: Omit<ModelsSimpleStreamOptions, "authSnapshot">) =>
				stream(context, options).result(),
		});
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		const provider = this.requireProvider(model);
		if (!provider.fetchDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const applied = await this.applyAuth(model, options);
		return provider.fetchDeferred(applied.model, handle, applied.options as DeferredFetchOptions).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.requireProvider(model);
		if (!provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const applied = await this.applyAuth(model, options);
		await provider.cancelDeferred(applied.model, handle, applied.options as DeferredCancelOptions);
	}

	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		return provider;
	}

	private async applyAuth<
		TOptions extends Omit<ProviderRequestOptions, "runtime"> & ModelsRuntimeOverride & ModelsRequestTransforms,
	>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{ model: Model<Api>; options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions }> {
		const resolution =
			options?.authSnapshot ??
			(await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
				signal: options?.signal,
				clock: options?.runtime?.clock ?? this.runtime.clock,
			}));
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		let headers = mergeHeaders(resolution.auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const environment =
			resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
		const { authSnapshot: _authSnapshot, transformHeaders: _transformHeaders, ...rest } = options ?? {};
		return {
			model: requestModel,
			options: {
				...rest,
				apiKey: options?.apiKey ?? resolution.auth.apiKey,
				headers,
				env: environment,
				runtime: options?.runtime ?? this.runtime,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions,
		};
	}
}

export function createModels(options: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}
