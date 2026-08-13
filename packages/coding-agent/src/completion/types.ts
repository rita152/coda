import type { RunEvidenceEnvelope } from "../run-evidence/contracts.ts";

export const COMPLETION_DISPOSITION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type CompletionDispositionStatus = "verified" | "partial" | "blocked" | "unverified";
export type CompletionModelTermination = "completed" | "failed" | "interrupted" | "timed_out";
export type CompletionEvidenceCompleteness = "complete" | "partial" | "missing";
export type CompletionVerificationResult = "passed" | "failed" | "not_run" | "infra_error";

export type CompletionReason =
	| "evidence_supported"
	| "read_only_or_diagnosis"
	| "model_not_completed"
	| "terminal_candidate_missing"
	| "run_evidence_missing"
	| "run_evidence_partial"
	| "workspace_evidence_missing"
	| "workspace_evidence_partial"
	| "mutation_without_post_verification"
	| "verification_failed"
	| "verification_infra_error"
	| "open_relevant_failures"
	| "repair_limit_reached";

export interface WorkspaceEvidenceSnapshot {
	readonly schemaVersion: typeof WORKSPACE_EVIDENCE_SCHEMA_VERSION;
	readonly status: "complete" | "partial" | "unavailable";
	readonly capturedAt: number;
	readonly dirty: boolean | null;
	readonly changedPaths: readonly string[];
	readonly omittedChangedPaths: number;
	readonly statusSha256: string | null;
	readonly diffSha256: string | null;
	readonly untrackedSha256: string | null;
	readonly fingerprint: string | null;
	readonly diagnostics: readonly string[];
}

export interface CompletionEvidencePoint {
	readonly sequence: number;
	readonly invocationId: string;
	readonly label: string;
	readonly source: "tool" | "workspace";
}

export interface CompletionVerificationEvidence extends CompletionEvidencePoint {
	readonly result: Exclude<CompletionVerificationResult, "not_run">;
	readonly command: string;
}

export interface CompletionRelevantFailure {
	readonly key: string;
	readonly kind: "evidence" | "mutation" | "verification";
	readonly status: "error" | "denied" | "aborted" | "infra_error";
	readonly sequence: number;
	readonly invocationId: string;
	readonly summary: string;
}

/**
 * Completion-specific sequencing that RunEvidence v1 does not expose. This is
 * deliberately narrower than a second RunEvidence reducer.
 */
export interface CompletionTemporalSnapshot {
	readonly latestMutation?: CompletionEvidencePoint;
	readonly latestPotentialMutation?: CompletionEvidencePoint;
	readonly latestVerification?: CompletionVerificationEvidence;
	readonly terminalCandidate?: {
		readonly messageId: string;
		readonly turnId: string;
		readonly sequence: number;
	};
}

export interface CompletionActivitySnapshot extends CompletionTemporalSnapshot {
	readonly openFailures: readonly CompletionRelevantFailure[];
}

/** The completion gate consumes the public v2 evidence contract directly. */
export type CompletionRunEvidence = RunEvidenceEnvelope;

export interface CompletionDisposition {
	readonly schemaVersion: typeof COMPLETION_DISPOSITION_SCHEMA_VERSION;
	readonly type: "completion_disposition";
	readonly runId: string;
	readonly disposition: CompletionDispositionStatus;
	readonly modelTermination: CompletionModelTermination;
	readonly evidenceCompleteness: CompletionEvidenceCompleteness;
	readonly verification: {
		readonly result: CompletionVerificationResult;
		readonly scope: "local";
		readonly hiddenVerifier: "not_evaluated";
		readonly command: string | null;
		readonly invocationId: string | null;
		readonly sequence: number | null;
		readonly afterLatestMutation: boolean;
	};
	readonly workspace: {
		readonly status: WorkspaceEvidenceSnapshot["status"];
		readonly changedDuringRun: boolean | null;
		readonly dirty: boolean | null;
		readonly changedPaths: readonly string[];
		readonly omittedChangedPaths: number;
		readonly statusSha256: string | null;
		readonly diffSha256: string | null;
		readonly untrackedSha256: string | null;
	};
	readonly evidence: {
		readonly runEvidenceSchemaVersion: number | null;
		readonly runEvidenceRunId: string | null;
		readonly latestMutationSequence: number | null;
		readonly openFailureCount: number;
	};
	readonly repair: {
		readonly attempts: number;
		readonly maxAttempts: number;
		readonly exhausted: boolean;
	};
	readonly reasons: readonly CompletionReason[];
}

export interface CompletionGateInput {
	readonly runId: string;
	readonly modelTermination: CompletionModelTermination;
	readonly runEvidence?: CompletionRunEvidence;
	readonly activity: CompletionActivitySnapshot;
	readonly baselineWorkspace?: WorkspaceEvidenceSnapshot;
	readonly finalWorkspace?: WorkspaceEvidenceSnapshot;
	readonly repairAttempts: number;
	readonly maxRepairAttempts: number;
}

export type CompletionGateDecision =
	| { readonly action: "accept"; readonly disposition: CompletionDisposition }
	| {
			readonly action: "repair";
			readonly disposition: CompletionDisposition;
			readonly steering: string;
	  };

export interface CompletionWorkspaceEvidenceProvider {
	capture(): Promise<WorkspaceEvidenceSnapshot>;
}
