import type {
	CompletionRunEvidence,
	CompletionWorkspaceEvidenceProvider,
	WorkspaceEvidenceSnapshot,
} from "../src/completion/types.ts";
import { RUN_EVIDENCE_SCHEMA_VERSION } from "../src/run-evidence/contracts.ts";

/** Deterministic evidence for tests whose exercised command leaves the Workspace unchanged. */
export function stableCompletionWorkspaceEvidence(capturedAt: number): CompletionWorkspaceEvidenceProvider {
	return {
		capture: async () => snapshot(capturedAt),
	};
}

export function completionRunEvidence(overrides: Partial<CompletionRunEvidence> = {}): CompletionRunEvidence {
	return {
		schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
		type: "run_evidence",
		runId: "run:test",
		outcome: "success",
		startedAt: 0,
		completedAt: 100,
		elapsedMs: 100,
		paths: {
			inspected: [],
			changed: [],
			changedWithProvenance: [],
			workspaceDiff: { status: "unavailable", omitted: 0 },
			omitted: { inspected: 0, changed: 0 },
		},
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
			terminalFailures: 0,
			recoveredFailures: 0,
			pendingOperations: 0,
			openFailures: 0,
		},
		...overrides,
	};
}

function snapshot(capturedAt: number): WorkspaceEvidenceSnapshot {
	return {
		schemaVersion: 1,
		status: "complete",
		capturedAt,
		dirty: false,
		changedPaths: [],
		omittedChangedPaths: 0,
		statusSha256: "stable:status",
		diffSha256: "stable:diff",
		untrackedSha256: "stable:untracked",
		fingerprint: "stable",
		diagnostics: [],
	};
}
