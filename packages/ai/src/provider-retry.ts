// Portions derived from Pi:
// /packages/ai/src/utils/provider-retry.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { normalizeModelFailure } from "./diagnostics.ts";
import type { TimeRuntime } from "./types.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface ProviderRetryOptions {
	runtime: TimeRuntime;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	const retryabilityOverride = shouldRetry === "true" ? true : shouldRetry === "false" ? false : undefined;
	return (
		normalizeModelFailure(error, {
			phase: "request",
			providerRequest: true,
			...(retryabilityOverride === undefined ? {} : { retryabilityOverride }),
		}).retryability === "retryable"
	);
}

function validateServerRetryDelayMs(delayMs: number, maxRetryDelayMs: number | undefined, message: string): number {
	const maximum = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maximum > 0 && delayMs > maximum) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maximum / 1000)}s). ${message}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(
	error: ProviderError,
	retryIndex: number,
	maxRetryDelayMs: number | undefined,
	runtime: TimeRuntime,
): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}
	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delay = Number.isNaN(seconds) ? Date.parse(retryAfter) - runtime.clock.now() : seconds * 1_000;
		return validateServerRetryDelayMs(delay, maxRetryDelayMs, error.message);
	}
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1_000;
	return exponentialDelay * (1 - runtime.random.next() * 0.25);
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

export async function retryProviderRequest<T>(request: () => Promise<T>, options: ProviderRetryOptions): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;
	for (;;) {
		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw abortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;
			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await options.runtime.sleep.wait(
				getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs, options.runtime),
				options.signal,
			);
		}
	}
}
