import type { TurnRetryContext } from "@coda/agent";
import type { Scheduler } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { createCodingAgentRetry } from "../src/retry.ts";

describe("Coding Agent Turn retry", () => {
	it("uses exactly three transient retries at 2s, 4s, and 8s", async () => {
		const scheduler: Scheduler = { schedule: () => ({ cancel: () => undefined }) };
		const retry = createCodingAgentRetry(scheduler);
		const context = {
			runId: "run-1",
			turnId: "turn-1",
			attemptId: "attempt-1",
			message: {},
			transient: true,
		} as unknown as TurnRetryContext;

		await expect(retry.policy.decide({ ...context, attempt: 1 })).resolves.toEqual({
			retry: true,
			delayMs: 2_000,
			reason: "transient model failure (retry 1/3)",
		});
		await expect(retry.policy.decide({ ...context, attempt: 2 })).resolves.toMatchObject({
			retry: true,
			delayMs: 4_000,
		});
		await expect(retry.policy.decide({ ...context, attempt: 3 })).resolves.toMatchObject({
			retry: true,
			delayMs: 8_000,
		});
		await expect(retry.policy.decide({ ...context, attempt: 4 })).resolves.toEqual({ retry: false });
		await expect(retry.policy.decide({ ...context, attempt: 1, transient: false })).resolves.toEqual({
			retry: false,
		});
	});

	it("cancels a scheduled wait when the Run signal aborts", async () => {
		let cancelled = false;
		const scheduler: Scheduler = {
			schedule: () => ({
				cancel: () => {
					cancelled = true;
				},
			}),
		};
		const retry = createCodingAgentRetry(scheduler);
		const controller = new AbortController();
		const waiting = retry.delay.wait(2_000, controller.signal);
		controller.abort();

		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(cancelled).toBe(true);
	});
});
