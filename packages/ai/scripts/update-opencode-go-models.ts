// Portions derived from Pi:
// /packages/ai/scripts/generate-models.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Check } from "typebox/value";

import type {
	Model,
	ModelCost,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	ThinkingLevelMap,
} from "../src/types.ts";

const GENERATOR_VERSION = 1;
const DEFAULT_SOURCE_URL = "https://models.dev/api.json";
const API_ORDER = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
type SupportedApi = (typeof API_ORDER)[number];

interface SourceCostTier {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tier?: { type?: string; size?: number };
}

interface SourceModel {
	id?: string;
	name?: string;
	status?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: Array<
		| { type: "toggle" }
		| { type: "budget_tokens"; min?: number; max?: number }
		| { type: "effort"; values?: Array<string | null> }
	>;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number; output?: number };
	provider?: { npm?: string };
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: SourceCostTier[];
	};
}

interface SourceDocument {
	"opencode-go"?: { models?: Record<string, SourceModel> };
}

const optionalNumber = Type.Optional(Type.Number());
const sourceCostTierSchema = Type.Object(
	{
		input: optionalNumber,
		output: optionalNumber,
		cache_read: optionalNumber,
		cache_write: optionalNumber,
		tier: Type.Optional(
			Type.Object({ type: Type.Optional(Type.String()), size: optionalNumber }, { additionalProperties: true }),
		),
	},
	{ additionalProperties: true },
);
const sourceModelSchema = Type.Object(
	{
		id: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		status: Type.Optional(Type.String()),
		tool_call: Type.Optional(Type.Boolean()),
		reasoning: Type.Optional(Type.Boolean()),
		reasoning_options: Type.Optional(
			Type.Array(
				Type.Object(
					{
						type: Type.String(),
						min: optionalNumber,
						max: optionalNumber,
						values: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Null()]))),
					},
					{ additionalProperties: true },
				),
			),
		),
		modalities: Type.Optional(
			Type.Object(
				{
					input: Type.Optional(Type.Array(Type.String())),
					output: Type.Optional(Type.Array(Type.String())),
				},
				{ additionalProperties: true },
			),
		),
		limit: Type.Optional(
			Type.Object({ context: optionalNumber, output: optionalNumber }, { additionalProperties: true }),
		),
		provider: Type.Optional(Type.Object({ npm: Type.Optional(Type.String()) }, { additionalProperties: true })),
		cost: Type.Optional(
			Type.Object(
				{
					input: optionalNumber,
					output: optionalNumber,
					cache_read: optionalNumber,
					cache_write: optionalNumber,
					tiers: Type.Optional(Type.Array(sourceCostTierSchema)),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);
const sourceDocumentSchema = Type.Object(
	{
		"opencode-go": Type.Object(
			{ models: Type.Record(Type.String(), sourceModelSchema) },
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);

type Catalog = Record<SupportedApi, Record<string, Model<SupportedApi>>>;

interface CliOptions {
	sourceUrl: string;
	outputDirectory: string;
	fetchedAt: string;
}

interface Route {
	api: SupportedApi;
	baseUrl: string;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

function parseArguments(argv: readonly string[]): CliOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}`);
		values.set(key, value);
	}
	const defaultOutput = fileURLToPath(new URL("../src/providers/data", import.meta.url));
	return {
		sourceUrl: values.get("--source-url") ?? DEFAULT_SOURCE_URL,
		outputDirectory: resolve(values.get("--output-dir") ?? defaultOutput),
		fetchedAt: values.get("--fetched-at") ?? new Date().toISOString(),
	};
}

function routeModel(id: string, npm: string | undefined): Route {
	const goBase = "https://opencode.ai/zen/go";
	let route: Route;
	if (npm === "@ai-sdk/openai") {
		route = {
			api: "openai-responses",
			baseUrl: `${goBase}/v1`,
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
	} else if (npm === "@ai-sdk/anthropic") {
		route = { api: "anthropic-messages", baseUrl: goBase };
	} else if (npm === undefined || npm === "@ai-sdk/openai-compatible" || npm === "@ai-sdk/alibaba") {
		route = { api: "openai-completions", baseUrl: `${goBase}/v1` };
	} else {
		throw new Error(`Unknown OpenCode Go wire implementation for ${id}: ${npm}`);
	}

	if (id === "minimax-m2.7") route = { api: "openai-completions", baseUrl: `${goBase}/v1` };
	if (id === "qwen3.5-plus" || id === "qwen3.6-plus") {
		route = {
			api: "openai-completions",
			baseUrl: `${goBase}/v1`,
			compat: { thinkingFormat: "qwen" },
		};
	}
	if (route.api === "openai-completions") {
		route.compat = { ...route.compat, maxTokensField: "max_tokens" };
		if (id === "kimi-k2.6") {
			route.compat = {
				...route.compat,
				thinkingFormat: "deepseek",
				supportsReasoningEffort: false,
				supportsLongCacheRetention: false,
			};
		}
	}
	return route;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function effortMap(source: SourceModel): ThinkingLevelMap | undefined {
	const values = source.reasoning_options?.flatMap((option) =>
		option.type === "effort" ? (option.values ?? []) : [],
	);
	if (!values?.length) return undefined;
	const supported = new Set(values);
	if (!supported.has("none") && !THINKING_LEVELS.some((level) => supported.has(level))) return undefined;
	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
}

function normalizeCost(source: SourceModel): ModelCost {
	const tiers = source.cost?.tiers?.flatMap((tier) => {
		if (tier.tier?.type !== "context" || tier.tier.size === undefined) return [];
		return [
			{
				inputTokensAbove: tier.tier.size,
				input: tier.input ?? 0,
				output: tier.output ?? 0,
				cacheRead: tier.cache_read ?? 0,
				cacheWrite: tier.cache_write ?? 0,
			},
		];
	});
	return {
		input: source.cost?.input ?? 0,
		output: source.cost?.output ?? 0,
		cacheRead: source.cost?.cache_read ?? 0,
		cacheWrite: source.cost?.cache_write ?? 0,
		...(tiers?.length ? { tiers } : {}),
	};
}

function normalizeModel(id: string, source: SourceModel): Model<SupportedApi> {
	const route = routeModel(id, source.provider?.npm);
	let thinkingLevelMap = route.api === "anthropic-messages" ? undefined : effortMap(source);
	if (id === "glm-5.2") {
		thinkingLevelMap = { off: null, minimal: null, low: null, medium: null, high: "high", max: "max" };
	}
	if (id === "kimi-k2.6") {
		thinkingLevelMap = { ...thinkingLevelMap, minimal: null, low: null, medium: null };
	}
	const model: Model<SupportedApi> = {
		id,
		name: source.name ?? source.id ?? id,
		api: route.api,
		provider: "opencode-go",
		baseUrl: route.baseUrl,
		reasoning: source.reasoning === true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: normalizeCost(source),
		contextWindow: source.limit?.context ?? 4_096,
		maxTokens: source.limit?.output ?? 4_096,
		...(route.compat ? { compat: route.compat as never } : {}),
	};
	validateModel(model);
	return model;
}

function validateModel(model: Model<SupportedApi>): void {
	if (!API_ORDER.includes(model.api)) throw new Error(`Unsupported Api for ${model.id}: ${model.api}`);
	if (!model.id || !model.name) throw new Error("Model identity must be non-empty");
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
		throw new Error(`Invalid context window for ${model.id}`);
	}
	if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0)
		throw new Error(`Invalid output limit for ${model.id}`);
	if (!model.cost) throw new Error(`Missing cost for generated Model ${model.id}`);
	for (const value of Object.values(model.cost)) {
		if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`Invalid cost for ${model.id}`);
		}
	}
}

function buildCatalog(document: SourceDocument): {
	catalog: Catalog;
	sourceRecordCount: number;
	excludedCount: number;
} {
	const sourceModels = document["opencode-go"]?.models;
	if (!sourceModels || typeof sourceModels !== "object") throw new Error("models.dev omitted opencode-go.models");
	const catalog: Catalog = {
		"anthropic-messages": {},
		"openai-completions": {},
		"openai-responses": {},
	};
	let excludedCount = 0;
	for (const id of Object.keys(sourceModels).sort()) {
		const source = sourceModels[id]!;
		if (source.tool_call !== true || source.status === "deprecated") {
			excludedCount++;
			continue;
		}
		const model = normalizeModel(id, source);
		if (catalog[model.api][id]) throw new Error(`Duplicate model id: ${id}`);
		catalog[model.api][id] = model;
	}
	if (Object.values(catalog).every((group) => Object.keys(group).length === 0)) {
		throw new Error("OpenCode Go catalog contained no supported models");
	}
	return { catalog, sourceRecordCount: Object.keys(sourceModels).length, excludedCount };
}

function flattenRoutes(catalog: Catalog): Map<string, SupportedApi> {
	const routes = new Map<string, SupportedApi>();
	for (const api of API_ORDER) {
		for (const id of Object.keys(catalog[api])) routes.set(id, api);
	}
	return routes;
}

async function readPreviousCatalog(path: string): Promise<Catalog | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Catalog;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Existing catalog is invalid: ${path}`, { cause: error });
	}
}

function diffCatalog(previous: Catalog | undefined, next: Catalog) {
	const before = previous ? flattenRoutes(previous) : new Map<string, SupportedApi>();
	const after = flattenRoutes(next);
	const added = [...after.keys()].filter((id) => !before.has(id)).sort();
	const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
	const rerouted = [...after.keys()]
		.filter((id) => before.has(id) && before.get(id) !== after.get(id))
		.sort()
		.map((id) => `${id}: ${before.get(id)} -> ${after.get(id)}`);
	return { added, removed, rerouted };
}

function renderChanges(diff: ReturnType<typeof diffCatalog>): string {
	const section = (title: string, entries: readonly string[]) =>
		[
			`## ${title} (${entries.length})`,
			"",
			...(entries.length ? entries.map((entry) => `- ${entry}`) : ["- None"]),
			"",
		].join("\n");
	return `# OpenCode Go model changes\n\n${section("Added", diff.added)}${section("Removed", diff.removed)}${section(
		"Rerouted",
		diff.rerouted,
	)}`;
}

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function publishDirectory(staging: string, target: string): Promise<void> {
	const backup = `${target}.backup-${process.pid}-${Date.now()}`;
	const hadTarget = await exists(target);
	if (hadTarget) await rename(target, backup);
	try {
		await rename(staging, target);
	} catch (error) {
		if (hadTarget) await rename(backup, target);
		throw error;
	}
	if (hadTarget) await rm(backup, { recursive: true, force: true });
}

async function update(options: CliOptions): Promise<void> {
	const response = await fetch(options.sourceUrl, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new Error("models.dev returned invalid JSON", { cause: error });
	}
	if (!Check(sourceDocumentSchema, parsed)) throw new Error("models.dev schema validation failed");
	const document = parsed as SourceDocument;
	const { catalog, sourceRecordCount, excludedCount } = buildCatalog(document);
	const previous = await readPreviousCatalog(join(options.outputDirectory, "opencode-go.json"));
	const diff = diffCatalog(previous, catalog);
	const recordCount = flattenRoutes(catalog).size;
	const routeCounts = Object.fromEntries(API_ORDER.map((api) => [api, Object.keys(catalog[api]).length]));
	const manifest = {
		source: options.sourceUrl,
		fetchedAt: options.fetchedAt,
		etag: response.headers.get("etag"),
		sha256,
		generatorVersion: GENERATOR_VERSION,
		sourceRecordCount,
		recordCount,
		excludedCount,
		routeCounts,
	};

	const parent = dirname(options.outputDirectory);
	await mkdir(parent, { recursive: true });
	const staging = await mkdtemp(join(parent, ".opencode-go-update-"));
	let published = false;
	try {
		await Promise.all([
			writeFile(join(staging, "opencode-go.json"), stableJson(catalog), "utf8"),
			writeFile(join(staging, "manifest.json"), stableJson(manifest), "utf8"),
			writeFile(join(staging, "opencode-go.changes.md"), renderChanges(diff), "utf8"),
		]);
		JSON.parse(await readFile(join(staging, "opencode-go.json"), "utf8"));
		JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
		await publishDirectory(staging, options.outputDirectory);
		published = true;
	} finally {
		if (!published) await rm(staging, { recursive: true, force: true });
	}

	process.stdout.write(
		`OpenCode Go models updated (${recordCount} records)\nadded: ${diff.added.length}\nremoved: ${diff.removed.length}\nrerouted: ${diff.rerouted.length}\nsha256: ${sha256}\n`,
	);
}

await update(parseArguments(process.argv.slice(2))).catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`models:update failed: ${message}\n`);
	process.exitCode = 1;
});
