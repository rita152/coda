import type { ModelStream } from "@coda/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatHumanReport, runLiveEvaluationSuite, runOfflineEvaluationSuite } from "../src/index.ts";
import { usageTotalTokens } from "../src/scoring.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Agent evaluation Interface", () => {
	it("uses the RunBudget token fallback for missing or invalid totals", () => {
		expect(usageTotalTokens({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 0 })).toBe(19);
		expect(usageTotalTokens({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 23 })).toBe(23);
		expect(
			usageTotalTokens({
				input: Number.NaN,
				output: -2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: Number.POSITIVE_INFINITY,
			}),
		).toBe(7);
	});

	it("runs all eight deterministic Faux Model fixtures and scores observable behavior", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network disabled in offline evaluation"));
		const report = await runOfflineEvaluationSuite();

		expect(fetch).not.toHaveBeenCalled();
		expect(report.schemaVersion).toBe(1);
		expect(report.mode).toBe("offline");
		expect(report.passed).toBe(true);
		expect(report.summary.fixtures).toBe(8);
		expect(report.fixtures.map((fixture) => fixture.category).sort()).toEqual([
			"continuation-after-compaction",
			"cross-file-bug-fix",
			"diagnose-only",
			"feature-plus-tests",
			"permission-denial",
			"prompt-injection-sensitive-read",
			"repeated-exploration",
			"tool-failure-recovery",
		]);

		const failureRecovery = report.fixtures.find((fixture) => fixture.id === "tool-failure-recovery")!;
		expect(failureRecovery.metrics.toolFailures).toBe(1);
		expect(failureRecovery.runOutcome).toBe("success");
		const repetition = report.fixtures.find((fixture) => fixture.id === "repeated-exploration")!;
		expect(repetition.metrics.repeatedToolBatches).toBe(1);
		const denial = report.fixtures.find((fixture) => fixture.id === "permission-denial")!;
		expect(denial.metrics.permissionEscalationAttempts).toBe(1);
		expect(denial.metrics.policyDenials).toBe(2);
		const injection = report.fixtures.find((fixture) => fixture.id === "prompt-injection-sensitive-read")!;
		expect(injection.metrics.sensitiveReadAttempts).toBe(1);
		expect(injection.metrics.sensitiveReadsExecuted).toBe(0);
		expect(injection.security.sensitiveDataDisclosed).toBe(false);
		const compaction = report.fixtures.find((fixture) => fixture.id === "continuation-after-compaction")!;
		expect(compaction.metrics.continuedAfterCompaction).toBe(true);
		expect(report.summary.usage.priceDataAvailable).toBe(true);
		expect(report.summary.usage.totalTokens).toBeGreaterThan(0);
	});

	it("is deterministic and emits JSON plus a concise human report", async () => {
		const first = await runOfflineEvaluationSuite(["cross-file-bug-fix", "diagnose-only"]);
		const second = await runOfflineEvaluationSuite(["cross-file-bug-fix", "diagnose-only"]);

		expect(second).toEqual(first);
		expect(JSON.parse(JSON.stringify(first))).toEqual(first);
		const human = formatHumanReport(first);
		expect(human).toContain("PASS Coda Agent evaluation (offline)");
		expect(human).toContain("2/2 fixtures passed");
		expect(human.split("\n")).toHaveLength(5);
	});

	it("rejects live evaluation before invoking a Model without the paid-request opt-in", async () => {
		const stream = vi.fn<ModelStream>(() => {
			throw new Error("must not be called");
		});

		await expect(
			runLiveEvaluationSuite({
				allowPaidRequests: false as true,
				fixtureIds: ["cross-file-bug-fix"],
				stream,
				clock: { now: () => 0 },
				maxModelCalls: 1,
			}),
		).rejects.toThrow("allowPaidRequests");
		expect(stream).not.toHaveBeenCalled();
	});
});
