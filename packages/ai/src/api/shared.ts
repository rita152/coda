// Portions derived from Pi:
// /packages/ai/src/models.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { createStreamDiagnostic } from "../diagnostics.ts";
import { ModelsError } from "../errors.ts";
import type { AssistantMessageEventStream } from "../event-stream.ts";
import type {
	AssistantMessage,
	Clock,
	Model,
	ProviderHeaders,
	ProviderResponse,
	StreamOptions,
	Usage,
} from "../types.ts";

export function emptyUsage(includeCost = true): Usage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
	if (includeCost) usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return usage;
}

export function createOutput(model: Model, clock: Clock): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(model.cost !== undefined),
		stopReason: "pending",
		timestamp: clock.now(),
	};
}

export function calculateCost(model: Model, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const baseRates = model.cost;
	if (!baseRates) {
		delete usage.cost;
		return undefined;
	}
	let rates = baseRates;
	let matchedThreshold = -1;
	for (const tier of baseRates.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	const cost = usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	cost.input = (rates.input / 1_000_000) * usage.input;
	cost.output = (rates.output / 1_000_000) * usage.output;
	cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000;
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	usage.cost = cost;
	return cost;
}

export function requireApiKey(provider: string, apiKey: string | undefined): string {
	if (!apiKey) throw new ModelsError("auth", `Missing API key for ${provider}`);
	return apiKey;
}

export function requestHeaders(headers?: ProviderHeaders): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export function mergeProviderHeaders(...sources: Array<ProviderHeaders | undefined>): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			for (const existing of Object.keys(merged)) {
				if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
			}
			merged[name] = value;
		}
	}
	return Object.keys(merged).length ? merged : undefined;
}

export function responseMetadata(response: Response): ProviderResponse {
	return { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
}

export function terminateStream(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model,
	error: unknown,
	options: StreamOptions,
	phase: string,
): void {
	if (options.signal?.aborted) {
		output.stopReason = "aborted";
		delete output.errorMessage;
		delete output.diagnostics;
		stream.push({ type: "error", reason: "aborted", error: output });
		return;
	}
	output.stopReason = "error";
	output.errorMessage = error instanceof Error ? error.message : String(error);
	output.diagnostics = [
		createStreamDiagnostic(model, error, {
			phase,
			clock: options.runtime.clock,
			debug: options.debugDiagnostics,
		}),
	];
	stream.push({ type: "error", reason: "error", error: output });
}
