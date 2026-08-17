import { describe, expect, it } from "vitest";
import { renderRunEvidenceSummary } from "../src/run-evidence/presentation.ts";
import { RUN_EVIDENCE_SCHEMA_VERSION, type RunEvidenceEnvelope } from "../src/run-evidence/run-evidence.ts";

describe("Run evidence interactive presentation", () => {
	it("presents concise aggregate evidence without projecting paths or commands", () => {
		const lines = renderRunEvidenceSummary(evidence(), 260);

		expect(lines).toEqual([
			"Evidence · 2 inspected · 1 changed · 1 command · 1 windowed · 1 recoverable overflow · 1 lossy overflow · 1 recovered failure · 1 open failure · 1 pending operation · 12.3k tokens · $0.04 known · 2.5s",
		]);
		expect(lines.join("\n")).not.toContain("malicious");
		expect(lines.join("\n")).not.toContain("secret");
	});

	it("presents deliberate pagination as windowing instead of an anomaly", () => {
		const value = evidence();
		const lines = renderRunEvidenceSummary(
			{
				...value,
				observations: {
					counts: {
						complete: 0,
						windowed: 1,
						"recoverable-overflow": 0,
						"lossy-overflow": 0,
					},
					limitations: [value.observations.limitations[0]!],
					omittedLimitations: 0,
				},
				terminalFailures: [],
				recoveredFailures: [],
				pendingOperations: [],
				openFailures: [],
			},
			160,
		);

		expect(lines.join(" ")).toContain("1 windowed");
		expect(lines.join(" ")).not.toContain("overflow");
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
	const openFailure = {
		kind: "tool" as const,
		id: "tool:1",
		status: "error" as const,
		summary: "bash error",
		sequence: 10,
		resolutionKey: "command:v1:open",
	};
	return {
		schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
		type: "run_evidence",
		runId: "run:1",
		outcome: "success",
		startedAt: 1_000,
		completedAt: 3_500,
		elapsedMs: 2_500,
		paths: {
			inspected: ["malicious\u001b[31m/path", "second"],
			changed: ["secret/path"],
			changedWithProvenance: [{ path: "secret/path", provenance: ["native"] }],
			workspaceDiff: { status: "complete", omitted: 0 },
			omitted: { inspected: 0, changed: 0 },
		},
		operations: [],
		observations: {
			counts: {
				complete: 0,
				windowed: 1,
				"recoverable-overflow": 1,
				"lossy-overflow": 1,
			},
			limitations: [
				{
					invocationId: "tool:read",
					toolName: "read",
					sequence: 8,
					completeness: "windowed",
					reason: "pagination",
				},
			],
			omittedLimitations: 2,
		},
		commands: [
			{
				invocationId: "tool:1",
				sequence: 10,
				command: "echo secret",
				commandKey: "command:v1:open",
				status: "error",
				exitCode: 1,
				signal: null,
				timedOut: false,
				truncated: true,
				completeness: "recoverable-overflow",
			},
		],
		terminalFailures: [openFailure],
		recoveredFailures: [
			{
				...openFailure,
				id: "tool:recovered",
				recoveredById: "tool:retry",
				recoveredAtSequence: 12,
			},
		],
		pendingOperations: [{ invocationId: "tool:pending", toolName: "read", startedSequence: 13, target: null }],
		openFailures: [openFailure],
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
		omitted: {
			operations: 0,
			commands: 0,
			observationLimitations: 2,
			terminalFailures: 0,
			recoveredFailures: 0,
			pendingOperations: 0,
			openFailures: 0,
		},
	};
}
