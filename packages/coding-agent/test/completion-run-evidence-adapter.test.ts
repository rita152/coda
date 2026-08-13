import { describe, expect, it } from "vitest";
import { completionActivityFromRunEvidence } from "../src/completion/run-evidence-adapter.ts";
import type { CompletionRunEvidence, CompletionTemporalSnapshot } from "../src/completion/types.ts";
import type { RunEvidenceOperation } from "../src/run-evidence/contracts.ts";

describe("completion RunEvidence adapter", () => {
	it("derives mutation and verification ordering from public v2 operations", () => {
		const mutation = operation({
			invocationId: "tool:patch",
			completedSequence: 10,
			paths: [{ path: "src/value.ts", effect: "changed", provenance: "tool-observation" }],
		});
		const verification = operation({
			invocationId: "tool:test",
			completedSequence: 20,
			status: "error",
			command: "npm test",
			commandKey: "command:test",
		});
		const failure = {
			kind: "tool" as const,
			id: "tool:test",
			status: "error" as const,
			summary: "npm test error (exit_7)",
			sequence: 20,
			resolutionKey: "command:test",
		};
		const activity = completionActivityFromRunEvidence(temporal(),
			evidence({
				operations: [mutation, verification],
				commands: [command("tool:test", 20, "npm test", true)],
				terminalFailures: [failure],
				openFailures: [failure],
				unresolvedFailures: [failure],
			}),
		);

		expect(activity).toMatchObject({
			latestMutation: { invocationId: "tool:patch", sequence: 10 },
			latestVerification: { invocationId: "tool:test", sequence: 20, result: "failed" },
			openFailures: [
				{
					key: "command:test",
					kind: "verification",
					status: "error",
					sequence: 20,
				},
			],
		});
	});

	it("does not turn a returned read-only command miss into a completion blocker", () => {
		const read = operation({
			invocationId: "tool:read",
			completedSequence: 5,
			status: "error",
			command: "git status --short",
			commandKey: "command:read",
		});
		const failure = {
			kind: "tool" as const,
			id: "tool:read",
			status: "error" as const,
			summary: "read failed",
			sequence: 5,
			resolutionKey: "command:read",
		};
		const activity = completionActivityFromRunEvidence(
			{},
			evidence({ operations: [read], terminalFailures: [failure], openFailures: [failure] }),
		);

		expect(activity.openFailures).toEqual([]);
	});

	it("uses only openFailures and never resurrects recovered history", () => {
		const historical = {
			kind: "tool" as const,
			id: "tool:test",
			status: "error" as const,
			summary: "historical failure",
			sequence: 8,
			resolutionKey: "command:test",
		};
		const activity = completionActivityFromRunEvidence(
			temporal(),
			evidence({ terminalFailures: [historical], openFailures: [], unresolvedFailures: [] }),
		);

		expect(activity.openFailures).toEqual([]);
	});

	it("keeps a timed-out verification as infrastructure evidence", () => {
		const verification = operation({
			invocationId: "tool:test",
			completedSequence: 20,
			status: "error",
			command: "npm test",
			commandKey: "command:test",
		});
		const activity = completionActivityFromRunEvidence(
			temporal(),
			evidence({
				operations: [verification],
				commands: [command("tool:test", 20, "npm test", false, true)],
			}),
		);

		expect(activity.latestVerification).toMatchObject({ result: "infra_error", sequence: 20 });
	});
});

function temporal(): CompletionTemporalSnapshot {
	return { terminalCandidate: { messageId: "message:final", turnId: "turn:final", sequence: 40 } };
}

function operation(overrides: Partial<RunEvidenceOperation> = {}): RunEvidenceOperation {
	return {
		invocationId: "tool:default",
		toolName: "bash",
		startedSequence: 1,
		completedSequence: 2,
		status: "ok",
		settlement: "returned",
		completeness: "complete",
		code: null,
		command: null,
		commandKey: null,
		paths: [],
		omittedPaths: 0,
		...overrides,
	};
}

function command(invocationId: string, sequence: number, value: string, failed: boolean, timedOut = false) {
	return {
		invocationId,
		sequence,
		command: value,
		commandKey: `command:${invocationId}`,
		status: failed ? ("error" as const) : ("ok" as const),
		exitCode: failed ? 7 : 0,
		signal: null,
		timedOut,
		truncated: false,
		completeness: "complete" as const,
	};
}

function evidence(overrides: Partial<CompletionRunEvidence> = {}): CompletionRunEvidence {
	return {
		schemaVersion: 2,
		type: "run_evidence",
		runId: "run:test",
		outcome: "success",
		startedAt: 0,
		completedAt: 100,
		elapsedMs: 100,
		paths: { inspected: [], changed: [], omitted: { inspected: 0, changed: 0 } },
		operations: [],
		observations: {
			counts: { complete: 0, windowed: 0, "recoverable-overflow": 0, "lossy-overflow": 0 },
			limitations: [],
			omittedLimitations: 0,
		},
		commands: [],
		terminalFailures: [],
		recoveredFailures: [],
		pendingOperations: [],
		openFailures: [],
		toolIssues: [],
		unresolvedFailures: [],
		usage: {
			attempts: 0,
			retries: 0,
			discardedAttempts: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			cost: {
				currency: "USD",
				status: "complete",
				totalUsd: 0,
				knownTotalUsd: 0,
				pricedAttempts: 0,
				unpricedAttempts: 0,
			},
		},
		omitted: {
			operations: 0,
			commands: 0,
			observationLimitations: 0,
			toolIssues: 0,
			terminalFailures: 0,
			recoveredFailures: 0,
			pendingOperations: 0,
			openFailures: 0,
			unresolvedFailures: 0,
		},
		...overrides,
	};
}
