import { createProvider, envApiKeyAuth, type Model, type MutableModels, type ProviderStreams } from "@coda/ai";
import { anthropicMessagesApi } from "@coda/ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@coda/ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@coda/ai/api/openai-responses.lazy";
import type { CatalogModel } from "../runtime/model-catalog.ts";
import type {
	AuthApiProtocol,
	CustomProviderConfig,
	CustomProviderInput,
	CustomProviderModelConfig,
	ProviderAuthenticationEntry,
} from "./types.ts";

type CustomProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface ProviderManagerOptions {
	readonly models: MutableModels;
	readonly fetch: typeof globalThis.fetch;
}

interface ProtocolRuntime {
	readonly api: CustomProviderApi;
	readonly streams: ProviderStreams;
}

const COMPATIBILITY_CONTEXT_WINDOW = 16_384;
const COMPATIBILITY_MAX_TOKENS = 4_096;

/**
 * Owns custom-provider identity, credentials, discovery, and runtime registration.
 * Secrets remain in the Models credential store; serializable configurations never
 * contain an API key.
 */
export class ProviderManager {
	readonly #models: MutableModels;
	readonly #fetch: typeof globalThis.fetch;
	readonly #configs = new Map<string, CustomProviderConfig>();
	readonly #catalog = new Map<string, CatalogModel>();

	constructor(options: ProviderManagerOptions) {
		this.#models = options.models;
		this.#fetch = options.fetch;
	}

	get configurations(): readonly CustomProviderConfig[] {
		return [...this.#configs.values()];
	}

	catalogModel(providerId: string, modelId: string): CatalogModel | undefined {
		return this.#catalog.get(modelKey(providerId, modelId));
	}

	restore(configurations: readonly CustomProviderConfig[]): void {
		const seen = new Set<string>();
		for (const input of configurations) {
			if (seen.has(input.id) || this.#configs.has(input.id)) {
				throw new Error(`Duplicate custom provider id: ${input.id}`);
			}
			if (this.#models.getProvider(input.id)) {
				throw new Error(`Custom provider id conflicts with an existing provider: ${input.id}`);
			}
			seen.add(input.id);
			const config: CustomProviderConfig = Object.freeze({
				id: input.id,
				name: normalizeProviderName(input.name),
				apiProtocol: input.apiProtocol,
				baseUrl: normalizeBaseUrl(input.baseUrl),
				discovery: input.discovery,
				models: Object.freeze(input.models.map((model) => Object.freeze({ ...model }))),
			});
			this.#register(config);
		}
	}

	async authenticationEntries(): Promise<readonly ProviderAuthenticationEntry[]> {
		return Promise.all(
			this.#models.getProviders().map(async (provider) => {
				let configured = false;
				try {
					configured = (await this.#models.checkAuth(provider.id)) !== undefined;
				} catch {
					configured = false;
				}
				return Object.freeze({ id: provider.id, name: provider.name, configured });
			}),
		);
	}

	async updateApiKey(
		providerId: string,
		apiKey: string,
		options: { readonly discover?: boolean } = {},
	): Promise<void> {
		if (!this.#models.getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
		await this.#models.login(providerId, "api_key", {
			prompt: async () => apiKey,
			notify: () => {},
		});
		if (options.discover !== false && this.#configs.has(providerId)) {
			await this.#refreshWithKey(providerId, apiKey);
		}
	}

	async logout(providerId: string): Promise<void> {
		if (!this.#models.getProvider(providerId)) throw new Error(`Unknown provider: ${providerId}`);
		await this.#models.logout(providerId);
	}

	async refresh(providerId: string): Promise<CustomProviderConfig | undefined> {
		const auth = await this.#models.getAuth(providerId);
		const apiKey = auth?.auth.apiKey;
		if (typeof apiKey !== "string" || !apiKey) return this.#configs.get(providerId);
		return this.#refreshWithKey(providerId, apiKey);
	}

	async addCustomProvider(input: CustomProviderInput): Promise<CustomProviderConfig> {
		const name = normalizeProviderName(input.providerName);
		const baseUrl = normalizeBaseUrl(input.baseUrl);
		const id = this.#allocateProviderId(name);
		const protocol = runtimeForProtocol(input.apiProtocol);

		const pending: CustomProviderConfig = Object.freeze({
			id,
			name,
			apiProtocol: input.apiProtocol,
			baseUrl,
			discovery: "needs_attention",
			models: Object.freeze([]),
		});
		this.#register(pending, protocol);
		await this.#models.login(id, "api_key", {
			prompt: async () => input.apiKey,
			notify: () => {},
		});

		let discovered: readonly CustomProviderModelConfig[];
		try {
			discovered = await this.#discover(baseUrl, input.apiKey, input.apiProtocol);
		} catch {
			return pending;
		}
		const config: CustomProviderConfig = Object.freeze({
			id,
			name,
			apiProtocol: input.apiProtocol,
			baseUrl,
			discovery: "ready",
			models: Object.freeze(discovered),
		});
		this.#register(config, protocol);
		return config;
	}

	#allocateProviderId(name: string): string {
		const base = `custom-${slugify(name) || "provider"}`;
		let candidate = base;
		let suffix = 2;
		while (this.#models.getProvider(candidate) || this.#configs.has(candidate)) {
			candidate = `${base}-${suffix}`;
			suffix += 1;
		}
		return candidate;
	}

	async #discover(
		baseUrl: string,
		apiKey: string,
		apiProtocol: AuthApiProtocol,
	): Promise<readonly CustomProviderModelConfig[]> {
		const response = await this.#fetch(`${baseUrl}/models`, {
			headers: discoveryHeaders(apiProtocol, apiKey),
		});
		if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.data)) {
			throw new Error("Model discovery response must contain a data array");
		}
		const seen = new Set<string>();
		const models: CustomProviderModelConfig[] = [];
		for (const entry of body.data) {
			if (!isRecord(entry) || typeof entry.id !== "string") continue;
			const id = entry.id.trim();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			models.push(Object.freeze({ id, name: id }));
		}
		return models;
	}

	async #refreshWithKey(providerId: string, apiKey: string): Promise<CustomProviderConfig> {
		const current = this.#configs.get(providerId);
		if (!current) throw new Error(`Provider is not custom: ${providerId}`);
		let discovered: readonly CustomProviderModelConfig[];
		try {
			discovered = await this.#discover(current.baseUrl, apiKey, current.apiProtocol);
		} catch {
			const needsAttention: CustomProviderConfig = Object.freeze({
				...current,
				discovery: "needs_attention",
			});
			this.#register(needsAttention);
			return needsAttention;
		}

		const discoveredIds = new Set(discovered.map((model) => model.id));
		const missing = current.models.filter((model) => !discoveredIds.has(model.id));
		const refreshed: CustomProviderConfig = Object.freeze({
			...current,
			discovery: "ready",
			models: Object.freeze([...discovered, ...missing]),
		});
		this.#register(refreshed);
		this.#markStale(
			providerId,
			missing.map((model) => model.id),
		);
		return refreshed;
	}

	#markStale(providerId: string, modelIds: readonly string[]): void {
		for (const modelId of modelIds) {
			const key = modelKey(providerId, modelId);
			const catalog = this.#catalog.get(key);
			if (catalog) this.#catalog.set(key, Object.freeze({ ...catalog, stale: true }));
		}
	}

	#register(config: CustomProviderConfig, runtime = runtimeForProtocol(config.apiProtocol)): void {
		for (const key of this.#catalog.keys()) {
			if (key.startsWith(`${config.id}/`)) this.#catalog.delete(key);
		}
		const models =
			config.discovery === "ready"
				? config.models.map((entry) => compatibilityRuntimeModel(config, entry, runtime.api))
				: [];
		this.#models.setProvider(
			createProvider({
				id: config.id,
				name: config.name,
				baseUrl: config.baseUrl,
				auth: { apiKey: envApiKeyAuth(`${config.name} API key`, []) },
				models,
				api: runtime.streams,
			}),
		);
		this.#configs.set(config.id, Object.freeze(config));
		for (const model of models) {
			this.#catalog.set(modelKey(config.id, model.id), unknownCatalogModel(model));
		}
	}
}

function compatibilityRuntimeModel(
	config: CustomProviderConfig,
	entry: CustomProviderModelConfig,
	api: CustomProviderApi,
): Model<CustomProviderApi> {
	return Object.freeze({
		id: entry.id,
		name: entry.name,
		api,
		provider: config.id,
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		contextWindow: COMPATIBILITY_CONTEXT_WINDOW,
		maxTokens: COMPATIBILITY_MAX_TOKENS,
	});
}

function unknownCatalogModel(runtime: Model<CustomProviderApi>): CatalogModel {
	return Object.freeze({
		key: modelKey(runtime.provider, runtime.id),
		providerId: runtime.provider,
		id: runtime.id,
		name: runtime.name,
		runtime,
		metadata: Object.freeze({
			contextWindow: "unknown",
			maxOutputTokens: "unknown",
			reasoning: "unknown",
			imageInput: "unknown",
			price: "unknown",
		}),
		compatibility: Object.freeze({
			contextWindow: COMPATIBILITY_CONTEXT_WINDOW,
			maxOutputTokens: COMPATIBILITY_MAX_TOKENS,
			reasoning: false,
			imageInput: false,
			price: "unreported",
		}),
	});
}

function runtimeForProtocol(apiProtocol: AuthApiProtocol): ProtocolRuntime {
	switch (apiProtocol) {
		case "openai.chatcompletions":
			return { api: "openai-completions", streams: openAICompletionsApi() };
		case "openai.responses":
			return { api: "openai-responses", streams: openAIResponsesApi() };
		case "anthropic.messages":
			return { api: "anthropic-messages", streams: anthropicMessagesApi() };
	}
}

function discoveryHeaders(apiProtocol: AuthApiProtocol, apiKey: string): Record<string, string> {
	if (apiProtocol === "anthropic.messages") {
		return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
	}
	return { Authorization: `Bearer ${apiKey}` };
}

function normalizeProviderName(value: string): string {
	const name = value.trim();
	if (!name) throw new Error("Provider name is required");
	return name;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Base URL must use HTTP or HTTPS");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Base URL must not contain credentials, a query, or a fragment");
	}
	return url.toString().replace(/\/$/, "");
}

function slugify(value: string): string {
	return value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function modelKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
