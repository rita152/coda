import { describe, expect, it } from "vitest";
import { normalizeModelFailure } from "../src/diagnostics.ts";

function failure(
	message: string,
	metadata: { readonly code?: string; readonly status?: number; readonly retryable?: boolean },
) {
	return Object.assign(new Error(message), metadata);
}

describe("normalized Model failure classification", () => {
	it.each([
		[
			failure("connection reset", { code: "ECONNRESET" }),
			{ phase: "stream", category: "transport", retryability: "retryable", providerCode: "ECONNRESET" },
		],
		[
			failure("slow down", { code: "rate_limit_exceeded", status: 429 }),
			{
				phase: "stream",
				category: "rate_limit",
				retryability: "retryable",
				providerCode: "rate_limit_exceeded",
				httpStatus: 429,
			},
		],
		[
			failure("invalid credentials", { code: "auth", status: 401 }),
			{
				phase: "stream",
				category: "provider",
				retryability: "non_retryable",
				providerCode: "auth",
				httpStatus: 401,
			},
		],
		[
			failure("Maximum context length exceeded", { code: "context_length_exceeded", status: 400 }),
			{
				phase: "stream",
				category: "context_overflow",
				retryability: "non_retryable",
				providerCode: "context_length_exceeded",
				httpStatus: 400,
			},
		],
		[
			failure("truncated protocol frame", { code: "EPROTO", retryable: true }),
			{ phase: "stream", category: "protocol", retryability: "retryable", providerCode: "EPROTO" },
		],
	] as const)("normalizes %s", (error, expected) => {
		expect(normalizeModelFailure(error, { phase: "stream" })).toEqual(expected);
	});

	it("honors Provider request retry overrides without allowing Context Overflow replay", () => {
		expect(
			normalizeModelFailure(failure("bad request", { status: 400 }), {
				phase: "request",
				providerRequest: true,
				retryabilityOverride: true,
			}),
		).toMatchObject({ retryability: "retryable" });
		expect(
			normalizeModelFailure(failure("context window exceeded", { code: "context_window_exceeded", status: 400 }), {
				phase: "request",
				providerRequest: true,
				retryabilityOverride: true,
			}),
		).toMatchObject({ category: "context_overflow", retryability: "non_retryable" });
	});
});
