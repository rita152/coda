// Portions derived from Pi:
// /packages/ai/test/provider-retry.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";

import { retryProviderRequest } from "../src/provider-retry.ts";
import type { TimeRuntime } from "../src/types.ts";

function providerError(status: number, headers: Record<string, string> = {}): Error {
	return Object.assign(new Error(`HTTP ${status}`), { status, headers: new Headers(headers) });
}

const immediateRuntime: TimeRuntime = {
	clock: { now: () => 0 },
	random: { next: () => 0 },
	scheduler: { schedule: () => ({ cancel: () => undefined }) },
	sleep: { wait: async () => {} },
};

describe("request-establishment retry (upstream: /packages/ai/test/provider-retry.test.ts)", () => {
	test("uses the injected clock, random source, and sleeper for retry timing", async () => {
		const delays: number[] = [];
		const runtime: TimeRuntime = {
			clock: { now: () => Date.parse("2026-08-08T00:00:00.000Z") },
			random: { next: () => 0.5 },
			scheduler: { schedule: () => ({ cancel: () => undefined }) },
			sleep: {
				wait: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		};
		let calls = 0;
		const result = await retryProviderRequest(
			async () => {
				calls++;
				if (calls === 1) throw providerError(503);
				return "ok";
			},
			{ maxRetries: 1, runtime },
		);

		expect(result).toBe("ok");
		expect(delays).toEqual([437.5]);
	});

	test.each([408, 409, 429, 500, 502, 503])("retries HTTP %i when explicitly budgeted", async (status) => {
		let calls = 0;
		const result = await retryProviderRequest(
			async () => {
				calls++;
				if (calls === 1) throw providerError(status, { "retry-after-ms": "0" });
				return "ok";
			},
			{ maxRetries: 1, runtime: immediateRuntime },
		);

		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});

	test("defaults to zero retries and honors x-should-retry overrides", async () => {
		let defaultCalls = 0;
		await expect(
			retryProviderRequest(
				async () => {
					defaultCalls++;
					throw providerError(503, { "retry-after-ms": "0" });
				},
				{ runtime: immediateRuntime },
			),
		).rejects.toThrow("HTTP 503");
		expect(defaultCalls).toBe(1);

		let forcedCalls = 0;
		await expect(
			retryProviderRequest(
				async () => {
					forcedCalls++;
					throw providerError(400, { "retry-after-ms": "0", "x-should-retry": "true" });
				},
				{ maxRetries: 1, runtime: immediateRuntime },
			),
		).rejects.toThrow("HTTP 400");
		expect(forcedCalls).toBe(2);

		let blockedCalls = 0;
		await expect(
			retryProviderRequest(
				async () => {
					blockedCalls++;
					throw providerError(503, { "x-should-retry": "false" });
				},
				{ maxRetries: 2, runtime: immediateRuntime },
			),
		).rejects.toThrow("HTTP 503");
		expect(blockedCalls).toBe(1);
	});

	test("fails closed when Retry-After exceeds the configured cap", async () => {
		await expect(
			retryProviderRequest(async () => Promise.reject(providerError(429, { "retry-after": "5" })), {
				maxRetries: 1,
				maxRetryDelayMs: 100,
				runtime: immediateRuntime,
			}),
		).rejects.toThrow("Server requested 5s retry delay (max: 1s)");
	});

	test("cancels a pending retry wait without issuing another request", async () => {
		const controller = new AbortController();
		let calls = 0;
		const runtime: TimeRuntime = {
			...immediateRuntime,
			sleep: {
				wait: (_delayMs, signal) =>
					new Promise<void>((_resolve, reject) => {
						const rejectAbort = () => {
							const error = new Error("Request aborted");
							error.name = "AbortError";
							reject(error);
						};
						if (signal?.aborted) rejectAbort();
						else signal?.addEventListener("abort", rejectAbort, { once: true });
					}),
			},
		};
		const request = retryProviderRequest(
			async () => {
				calls++;
				throw providerError(503, { "retry-after-ms": "10000" });
			},
			{ maxRetries: 1, maxRetryDelayMs: 0, signal: controller.signal, runtime },
		);
		queueMicrotask(() => controller.abort("caller cancelled"));

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
	});
});
