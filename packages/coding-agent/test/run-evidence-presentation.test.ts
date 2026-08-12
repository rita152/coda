import { describe, expect, it } from "vitest";
import { renderRunEvidenceSummary } from "../src/run-evidence/presentation.ts";
import type { RunEvidenceEnvelope } from "../src/run-evidence/run-evidence.ts";

describe("Run evidence interactive presentation", () => {
	it("presents concise aggregate evidence without projecting paths or commands", () => {
		const lines = renderRunEvidenceSummary(evidence(), 120);

		expect(lines).toEqual([
			"Evidence · 2 inspected · 1 changed · 1 command · 2 Tool issues · 1 unresolved · 12.3k tokens · $0.04 known · 2.5s",
		]);
		expect(lines.join("\n")).not.toContain("malicious");
		expect(lines.join("\n")).not.toContain("secret");
	});

	it.each([40, 24, 12, 1])("keeps every rendered line within a %i-column terminal", (width) => {
		const lines = renderRunEvidenceSummary(evidence(), width);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => Array.from(line).length <= width)).toBe(true);
	});

	it("labels aborted Runs and unavailable historical pricing", () => {
		const value = evidence();
		const lines = renderRunEvidenceSummary(
			{
				...value,
				outcome: "aborted",
				usage: {
					...value.usage,
					cost: {
						currency: "USD",
						status: "unavailable",
						totalUsd: null,
						knownTotalUsd: 0,
						pricedAttempts: 0,
						unpricedAttempts: 1,
					},
				},
			},
			80,
		);

		expect(lines.join(" ")).toContain("Evidence (aborted)");
		expect(lines.join(" ")).toContain("cost unavailable");
	});
});

function evidence(): RunEvidenceEnvelope {
	return {
		schemaVersion: 1,
		type: "run_evidence",
		runId: "run:1",
		outcome: "success",
		startedAt: 1_000,
		completedAt: 3_500,
		elapsedMs: 2_500,
		paths: {
			inspected: ["malicious\u001b[31m/path", "second"],
			changed: ["secret/path"],
			omitted: { inspected: 0, changed: 0 },
		},
		commands: [
			{
				invocationId: "tool:1",
				command: "echo secret",
				status: "error",
				exitCode: 1,
				signal: null,
				timedOut: false,
				truncated: true,
			},
		],
		toolIssues: [
			{
				invocationId: "tool:1",
				toolName: "bash",
				status: "error",
				settlement: "returned",
				truncated: true,
				outputRecoverable: true,
				reason: "exit_1",
			},
			{
				invocationId: "tool:2",
				toolName: "read",
				status: "ok",
				settlement: "returned",
				truncated: true,
				outputRecoverable: false,
				reason: "output_truncated",
			},
		],
		unresolvedFailures: [{ kind: "tool", id: "tool:1", status: "error", summary: "bash error" }],
		usage: {
			attempts: 2,
			retries: 1,
			discardedAttempts: 1,
			inputTokens: 10_000,
			outputTokens: 2_345,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
			reasoningTokens: 0,
			totalTokens: 12_345,
			cost: {
				currency: "USD",
				status: "partial",
				totalUsd: null,
				knownTotalUsd: 0.04,
				pricedAttempts: 1,
				unpricedAttempts: 1,
			},
		},
		omitted: { commands: 0, toolIssues: 0, unresolvedFailures: 0 },
	};
}
