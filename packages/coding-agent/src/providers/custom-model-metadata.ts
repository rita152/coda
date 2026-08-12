import type { Api, Model, ModelCost, ModelCostTier } from "@coda/ai";
import type { CatalogModel } from "../runtime/model-catalog.ts";
import {
	COMPATIBILITY_CONTEXT_WINDOW,
	COMPATIBILITY_MAX_TOKENS,
	modelMetadataValue,
} from "../runtime/model-metadata.ts";
import type { CustomProviderConfig, CustomProviderModelConfig } from "./types.ts";

const MODEL_CONFIG_KEYS = ["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "price", "stale"] as const;
const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "tiers"] as const;
const PRICE_TIER_KEYS = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const;
const METADATA_VALUE_KEYS = ["source", "value"] as const;

/** Parse and deeply freeze one serialized Custom Provider Model configuration. */
export function parseCustomProviderModelConfig(value: unknown): CustomProviderModelConfig {
	if (!isRecord(value) || !hasOnlyKeys(value, MODEL_CONFIG_KEYS)) {
		throw new Error("Custom Provider Model configuration has unknown fields");
	}
	const id = requiredText(value.id, "id");
	const name = requiredText(value.name, "name");
	const contextWindow = optionalMetadata(value.contextWindow, positiveInteger, "contextWindow");
	const maxTokens = optionalMetadata(value.maxTokens, positiveInteger, "maxTokens");
	const reasoning = optionalMetadata(value.reasoning, booleanValue, "reasoning");
	const input = optionalMetadata(value.input, inputModalities, "input");
	const price = optionalMetadata(value.price, modelCost, "price");
	if (contextWindow && maxTokens && maxTokens.value > contextWindow.value) {
		throw new Error("Custom Provider Model maxTokens must not exceed contextWindow");
	}
	if (value.stale !== undefined && typeof value.stale !== "boolean") {
		throw new Error("Custom Provider Model stale must be a boolean");
	}
	return Object.freeze({
		id,
		name,
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(reasoning ? { reasoning } : {}),
		...(input ? { input } : {}),
		...(price ? { price } : {}),
		...(value.stale === true ? { stale: true } : {}),
	});
}

/** Read only metadata explicitly returned by the Provider's Model discovery response. */
export function discoverCustomProviderModels(body: unknown): readonly CustomProviderModelConfig[] {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new Error("Model discovery response must contain a data array");
	}
	const seen = new Set<string>();
	const discovered: CustomProviderModelConfig[] = [];
	for (const value of body.data) {
		if (!isRecord(value) || typeof value.id !== "string") continue;
		const id = value.id.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		discovered.push(discoveredModel(value, id));
	}
	return Object.freeze(discovered);
}

/** Refresh Provider metadata while preserving field-by-field user overrides and missing stale Models. */
export function mergeDiscoveredCustomProviderModels(
	discovered: readonly CustomProviderModelConfig[],
	current: readonly CustomProviderModelConfig[],
): readonly CustomProviderModelConfig[] {
	const currentById = new Map(current.map((model) => [model.id, model]));
	const discoveredIds = new Set(discovered.map((model) => model.id));
	const refreshed = discovered.map((model) => {
		const previous = currentById.get(model.id);
		if (!previous) return model;
		return parseCustomProviderModelConfig({
			...model,
			...(previous.contextWindow?.source === "user" ? { contextWindow: previous.contextWindow } : {}),
			...(previous.maxTokens?.source === "user" ? { maxTokens: previous.maxTokens } : {}),
			...(previous.reasoning?.source === "user" ? { reasoning: previous.reasoning } : {}),
			...(previous.input?.source === "user" ? { input: previous.input } : {}),
			...(previous.price?.source === "user" ? { price: previous.price } : {}),
		});
	});
	for (const model of current) {
		if (discoveredIds.has(model.id)) continue;
		refreshed.push(parseCustomProviderModelConfig({ ...model, stale: true }));
	}
	return Object.freeze(refreshed);
}

/** Resolve one source-labelled configuration into the sole runtime and Catalog projection. */
export function customProviderCatalogModel(
	config: CustomProviderConfig,
	entry: CustomProviderModelConfig,
	api: Api,
): CatalogModel {
	const contextWindow = entry.contextWindow ?? modelMetadataValue(COMPATIBILITY_CONTEXT_WINDOW, "compatibility");
	const maxOutputTokens =
		entry.maxTokens ?? modelMetadataValue(Math.min(COMPATIBILITY_MAX_TOKENS, contextWindow.value), "compatibility");
	const reasoning = entry.reasoning ?? modelMetadataValue(false, "compatibility");
	const input =
		entry.input ??
		modelMetadataValue(Object.freeze(["text"] as const) as readonly ("text" | "image")[], "compatibility");
	const price = entry.price ?? modelMetadataValue("unreported" as const, "compatibility");
	const runtimeInput = Object.freeze([...input.value]) as ("text" | "image")[];
	const runtime: Model<Api> = Object.freeze({
		id: entry.id,
		name: entry.name,
		api,
		provider: config.id,
		baseUrl: config.baseUrl,
		reasoning: reasoning.value,
		input: runtimeInput,
		...(price.value === "unreported" ? {} : { cost: price.value }),
		contextWindow: contextWindow.value,
		maxTokens: maxOutputTokens.value,
	});
	return Object.freeze({
		key: `${config.id}/${entry.id}`,
		providerId: config.id,
		id: entry.id,
		name: entry.name,
		runtime,
		metadata: Object.freeze({ contextWindow, maxOutputTokens, reasoning, input, price }),
		...(entry.stale ? { stale: true } : {}),
	});
}

function discoveredModel(value: Record<string, unknown>, id: string): CustomProviderModelConfig {
	const nameValue = firstValue(value, [["name"], ["display_name"], ["displayName"]]);
	const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : id;
	const contextWindow = discoveredPositiveInteger(
		firstValue(value, [
			["contextWindow"],
			["context_window"],
			["context_length"],
			["limits", "context"],
			["top_provider", "context_length"],
		]),
	);
	let maxTokens = discoveredPositiveInteger(
		firstValue(value, [
			["maxTokens"],
			["max_tokens"],
			["max_output_tokens"],
			["limits", "output"],
			["top_provider", "max_completion_tokens"],
		]),
	);
	if (contextWindow && maxTokens && maxTokens.value > contextWindow.value) maxTokens = undefined;
	const reasoningValue = firstValue(value, [["reasoning"], ["supports_reasoning"], ["capabilities", "reasoning"]]);
	const reasoning = typeof reasoningValue === "boolean" ? modelMetadataValue(reasoningValue, "provider") : undefined;
	const inputValue = firstValue(value, [
		["input"],
		["input_modalities"],
		["architecture", "input_modalities"],
		["capabilities", "input"],
	]);
	const modalities = discoveredInputModalities(inputValue);
	const input = modalities ? modelMetadataValue(modalities, "provider") : undefined;
	const price = discoveredPrice(value);
	return parseCustomProviderModelConfig({
		id,
		name,
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
		...(reasoning ? { reasoning } : {}),
		...(input ? { input } : {}),
		...(price ? { price } : {}),
	});
}

function discoveredPositiveInteger(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? modelMetadataValue(value, "provider")
		: undefined;
}

function discoveredInputModalities(value: unknown): readonly ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const supported = [
		...new Set(value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")),
	];
	return supported.includes("text") ? Object.freeze(supported) : undefined;
}

function discoveredPrice(value: Record<string, unknown>) {
	for (const key of ["price", "cost"] as const) {
		if (!(key in value)) continue;
		try {
			return modelMetadataValue(modelCost(value[key]), "provider");
		} catch {
			return undefined;
		}
	}
	if (!("pricing" in value) || !isRecord(value.pricing)) return undefined;
	const pricing = value.pricing;
	try {
		if (["input", "output", "cacheRead", "cacheWrite"].every((key) => key in pricing)) {
			return modelMetadataValue(modelCost(pricing), "provider");
		}
		return modelMetadataValue(perTokenModelCost(pricing), "provider");
	} catch {
		return undefined;
	}
}

function perTokenModelCost(value: Record<string, unknown>): ModelCost {
	const rate = (keys: readonly string[]): number => {
		const candidate = keys.find((key) => key in value);
		if (!candidate) throw new Error("Provider price metadata is incomplete");
		const raw = value[candidate];
		const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
		if (!Number.isFinite(number) || number < 0) throw new Error("Provider price metadata is invalid");
		return number * 1_000_000;
	};
	return Object.freeze({
		input: rate(["prompt", "input"]),
		output: rate(["completion", "output"]),
		cacheRead: rate(["input_cache_read", "cache_read"]),
		cacheWrite: rate(["input_cache_write", "cache_write"]),
	});
}

function optionalMetadata<T>(value: unknown, parse: (value: unknown, field: string) => T, field: string) {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !hasOnlyKeys(value, METADATA_VALUE_KEYS)) {
		throw new Error(`Custom Provider Model ${field} must include only source and value`);
	}
	if (value.source !== "provider" && value.source !== "user") {
		throw new Error(`Custom Provider Model ${field} has an invalid metadata source`);
	}
	return modelMetadataValue(parse(value.value, field), value.source);
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`Custom Provider Model ${field} must be a positive safe integer`);
	}
	return value;
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Custom Provider Model ${field} must be a boolean`);
	return value;
}

function inputModalities(value: unknown): readonly ("text" | "image")[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((entry) => entry !== "text" && entry !== "image") ||
		new Set(value).size !== value.length ||
		!value.includes("text")
	) {
		throw new Error("Custom Provider Model input must contain unique supported modalities including text");
	}
	return Object.freeze([...(value as ("text" | "image")[])]);
}

function modelCost(value: unknown): ModelCost {
	if (!isRecord(value) || !hasOnlyKeys(value, PRICE_KEYS)) {
		throw new Error("Custom Provider Model price has invalid fields");
	}
	const rates = costRates(value);
	let tiers: ModelCostTier[] | undefined;
	if (value.tiers !== undefined) {
		if (!Array.isArray(value.tiers)) throw new Error("Custom Provider Model price tiers must be an array");
		const thresholds = new Set<number>();
		tiers = Object.freeze(
			value.tiers
				.map((tier) => {
					if (!isRecord(tier) || !hasOnlyKeys(tier, PRICE_TIER_KEYS)) {
						throw new Error("Custom Provider Model price tier has invalid fields");
					}
					const inputTokensAbove = tier.inputTokensAbove;
					if (
						typeof inputTokensAbove !== "number" ||
						!Number.isSafeInteger(inputTokensAbove) ||
						inputTokensAbove < 0 ||
						thresholds.has(inputTokensAbove)
					) {
						throw new Error("Custom Provider Model price tier threshold is invalid");
					}
					thresholds.add(inputTokensAbove);
					return Object.freeze({ inputTokensAbove, ...costRates(tier) });
				})
				.sort((left, right) => left.inputTokensAbove - right.inputTokensAbove),
		) as ModelCostTier[];
	}
	return Object.freeze({ ...rates, ...(tiers ? { tiers } : {}) });
}

function costRates(value: Record<string, unknown>) {
	const result: Record<"input" | "output" | "cacheRead" | "cacheWrite", number> = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const rate = value[key];
		if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
			throw new Error(`Custom Provider Model price ${key} must be a non-negative finite number`);
		}
		result[key] = rate;
	}
	return result;
}

function firstValue(value: Record<string, unknown>, paths: readonly (readonly string[])[]): unknown {
	for (const path of paths) {
		let current: unknown = value;
		let found = true;
		for (const key of path) {
			if (!isRecord(current) || !(key in current)) {
				found = false;
				break;
			}
			current = current[key];
		}
		if (found) return current;
	}
	return undefined;
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`Custom Provider Model ${field} is required`);
	}
	return value.trim();
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
