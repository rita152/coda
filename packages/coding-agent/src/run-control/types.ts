export type RunControlPhase = "running" | "wrap_up_requested" | "finalizing" | "terminal";

export type RunControlTrigger = "work_deadline" | "stagnation";

export type RunControlReason = RunControlTrigger | "grace_deadline_exceeded" | "run_ended";

export interface RunControlConfiguration {
	readonly workDurationMs: number;
	readonly graceDurationMs: number;
	readonly maxStationaryTurns?: number;
}

export type RunControlProgressFact =
	| {
			readonly kind: "workspace_content";
			readonly path: string;
			readonly digest: string;
	  }
	| {
			readonly kind: "verification";
			readonly target: string;
			readonly status: "failed" | "passed";
	  }
	| {
			readonly kind: "requirement_evidence";
			readonly requirementId: string;
			readonly evidenceId: string;
	  }
	| {
			readonly kind: "read";
			readonly fingerprint: string;
	  }
	| {
			readonly kind: "failure";
			readonly fingerprint: string;
	  };

export interface RunControlProgressSnapshot {
	readonly revision: number;
	readonly consecutiveStationaryTurns: number;
	readonly workspaceContentCount: number;
	readonly verificationTargetCount: number;
	readonly requirementEvidenceCount: number;
	readonly uniqueReadCount: number;
	readonly uniqueFailureCount: number;
	readonly lastProgressAt: number | null;
}

/** Versioned, RunBudget-independent status embedded in JSON run_end and Run Evidence. */
export interface RunControlReport {
	readonly schemaVersion: 1;
	readonly phase: RunControlPhase;
	readonly reason: RunControlReason | null;
	readonly trigger: RunControlTrigger | null;
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
	readonly progress: RunControlProgressSnapshot;
}

export interface RunControlReportProvider {
	reportForRun(runId: string): RunControlReport | undefined;
}
