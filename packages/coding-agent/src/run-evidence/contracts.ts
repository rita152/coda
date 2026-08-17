import type { ToolObservation } from "@coda/ai";

/** Structural copy of the versioned Run Control report embedded in evidence envelopes. */
export interface RunEvidenceControlReport {
	readonly schemaVersion: 1;
	readonly phase: "running" | "wrap_up_requested" | "finalizing" | "terminal";
	readonly reason:
		| "work_deadline"
		| "stagnation"
		| "grace_deadline_exceeded"
		| "run_ended"
		| "work_item_settled"
		| null;
	readonly trigger: "work_deadline" | "stagnation" | null;
	readonly configured: {
		readonly workDurationMs: number;
		readonly graceDurationMs: number;
		readonly maxStationaryTurns: number | null;
	};
	readonly startedAt: number;
	readonly workDeadlineAt: number;
	readonly wrapUpRequestedAt: number | null;
	readonly graceDeadlineAt: number | null;
	readonly finalizingAt: number | null;
	readonly terminalAt: number | null;
	readonly progress: {
		readonly revision: number;
		readonly consecutiveStationaryTurns: number;
		readonly workspaceContentCount: number;
		readonly verificationTargetCount: number;
		readonly requirementEvidenceCount: number;
		readonly uniqueReadCount: number;
		readonly uniqueFailureCount: number;
		readonly lastProgressAt: number | null;
	};
}

export const RUN_EVIDENCE_SCHEMA_VERSION = 3 as const;
export const RUN_EVIDENCE_RUN_CONTROL_SCHEMA_VERSION = 4 as const;
export const RUN_EVIDENCE_TOOL_FACTS_VERSION = 1 as const;

export type RunEvidenceOutcome = "success" | "error" | "aborted" | "interrupted";

export type RunEvidenceObservationCompleteness = "complete" | "windowed" | "recoverable-overflow" | "lossy-overflow";

export type RunEvidenceObservationLimitationReason = "pagination" | "user-preview" | "output-overflow";

/**
 * Versioned Tool Observation facts consumed by Run Evidence.
 *
 * Native Tools can publish this shape under `observation.facts.runEvidence` without
 * coupling themselves to the collector. Issue 05 can therefore add mutation paths
 * without adding its Tool name to Run Evidence.
 */
export interface RunEvidenceToolFactsV1 {
	readonly schemaVersion: typeof RUN_EVIDENCE_TOOL_FACTS_VERSION;
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly limitationReason?: RunEvidenceObservationLimitationReason;
	readonly paths?: readonly RunEvidenceToolFactPath[];
	readonly omittedPaths?: RunEvidencePathOmissions;
	readonly resolutionTarget?: RunEvidenceResolutionTarget;
}

export interface RunEvidencePathOmissions {
	readonly inspected: number;
	readonly changed: number;
}

export interface RunEvidenceToolFactPath {
	readonly path: string;
	readonly effect: "inspected" | "changed";
}

export interface RunEvidenceResolutionTarget {
	readonly kind: "path" | "opaque";
	readonly value: string;
}

export type RunEvidencePathProvenance = "tool-observation" | "invocation-argument" | "workspace-diff";
export type RunEvidenceChangedPathProvenance = "native" | "workspace-diff";

export interface RunEvidenceOperationPath extends RunEvidenceToolFactPath {
	readonly provenance: RunEvidencePathProvenance;
}

export interface RunEvidenceOperationMutation {
	readonly attemptedPaths: readonly string[];
	readonly committedPaths: readonly string[];
}

/** Generic, completion-policy-free operation facts for issues 01 and 05. */
export interface RunEvidenceOperation {
	readonly invocationId: string;
	readonly toolName: string;
	readonly startedSequence: number;
	readonly completedSequence: number;
	readonly status: ToolObservation["status"];
	readonly settlement: "returned" | "threw" | "aborted" | null;
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly code: string | null;
	readonly command: string | null;
	readonly commandKey: string | null;
	readonly mutation?: RunEvidenceOperationMutation;
	readonly paths: readonly RunEvidenceOperationPath[];
	readonly omittedPaths: number;
}

export interface RunEvidencePendingOperation {
	readonly invocationId: string;
	readonly toolName: string;
	readonly startedSequence: number;
	readonly target: RunEvidenceResolutionTarget | null;
}

export interface RunEvidenceObservationLimitation {
	readonly invocationId: string;
	readonly toolName: string;
	readonly sequence: number;
	readonly completeness: Exclude<RunEvidenceObservationCompleteness, "complete">;
	readonly reason: RunEvidenceObservationLimitationReason;
}

export interface RunEvidenceObservationSummary {
	readonly counts: Readonly<Record<RunEvidenceObservationCompleteness, number>>;
	readonly limitations: readonly RunEvidenceObservationLimitation[];
	readonly omittedLimitations: number;
}

export interface RunEvidenceCommand {
	readonly invocationId: string;
	readonly command: string;
	readonly status: ToolObservation["status"];
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly truncated: boolean;
	readonly sequence: number;
	readonly completeness: RunEvidenceObservationCompleteness;
	readonly commandKey: string;
}

export interface RunEvidenceFailure {
	readonly kind: "attempt" | "tool" | "run";
	readonly id: string;
	readonly status: "error" | "aborted" | "interrupted";
	readonly summary: string;
	readonly sequence: number;
	/** Null means no later success can safely resolve this failure. */
	readonly resolutionKey: string | null;
}

export interface RunEvidenceRecoveredFailure extends RunEvidenceFailure {
	readonly recoveredById: string;
	readonly recoveredAtSequence: number;
}

export interface RunEvidenceUsage {
	readonly attempts: number;
	readonly retries: number;
	readonly discardedAttempts: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly cacheWrite1hTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly currency: "USD";
		readonly status: "complete" | "partial" | "unavailable";
		/** Null unless every completed Attempt carried historical price data. */
		readonly totalUsd: number | null;
		/** Sum of recorded prices; useful when status is partial. */
		readonly knownTotalUsd: number;
		readonly pricedAttempts: number;
		readonly unpricedAttempts: number;
	};
}

export interface RunEvidencePaths {
	readonly inspected: readonly string[];
	readonly changed: readonly string[];
	readonly omitted: {
		readonly inspected: number;
		readonly changed: number;
	};
	readonly changedWithProvenance: readonly RunEvidenceChangedPath[];
	readonly workspaceDiff: RunEvidenceWorkspaceDiff;
}

export interface RunEvidenceChangedPath {
	readonly path: string;
	readonly provenance: readonly RunEvidenceChangedPathProvenance[];
}

export interface RunEvidenceWorkspaceDiff {
	readonly status: "complete" | "partial" | "unavailable";
	readonly omitted: number;
}

export interface RunEvidenceWorkspaceDiffSupplement {
	readonly status: RunEvidenceWorkspaceDiff["status"];
	readonly paths: readonly string[];
	readonly omitted?: number;
}

/** Stable v3 JSONL envelope emitted after one completed Run. */
export interface RunEvidenceEnvelope {
	readonly schemaVersion: typeof RUN_EVIDENCE_SCHEMA_VERSION;
	readonly type: "run_evidence";
	readonly runId: string;
	readonly outcome: RunEvidenceOutcome;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly elapsedMs: number;
	readonly paths: RunEvidencePaths;
	readonly operations: readonly RunEvidenceOperation[];
	readonly observations: RunEvidenceObservationSummary;
	readonly commands: readonly RunEvidenceCommand[];
	readonly terminalFailures: readonly RunEvidenceFailure[];
	readonly recoveredFailures: readonly RunEvidenceRecoveredFailure[];
	readonly pendingOperations: readonly RunEvidencePendingOperation[];
	readonly openFailures: readonly RunEvidenceFailure[];
	readonly usage: RunEvidenceUsage;
	readonly omitted: {
		readonly operations: number;
		readonly commands: number;
		readonly observationLimitations: number;
		readonly terminalFailures: number;
		readonly recoveredFailures: number;
		readonly pendingOperations: number;
		readonly openFailures: number;
	};
}

/**
 * Controlled JSONL projection. Unconfigured Runs retain the v3 envelope while
 * configured Runs advance to v4 and add orthogonal RunControl lifecycle facts.
 */
export interface RunEvidenceWithRunControlEnvelope extends Omit<RunEvidenceEnvelope, "schemaVersion"> {
	readonly schemaVersion: typeof RUN_EVIDENCE_RUN_CONTROL_SCHEMA_VERSION;
	readonly runControl: RunEvidenceControlReport;
}
