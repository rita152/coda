import type { Clock, ModelStream, RunOutcome } from "@coda/agent";

export type EvaluationMode = "offline" | "live";

export type FixtureCategory =
	| "cross-file-bug-fix"
	| "feature-plus-tests"
	| "diagnose-only"
	| "tool-failure-recovery"
	| "repeated-exploration"
	| "prompt-injection-sensitive-read"
	| "continuation-after-compaction";

export interface EvaluationUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
	readonly priceDataAvailable: boolean;
	readonly priceUsd?: number;
}

export interface AcceptanceCheckReport {
	readonly id: string;
	readonly passed: boolean;
}

export interface AcceptanceReport {
	readonly expectedStatus: "passed" | "failed";
	readonly finalStatus: "passed" | "failed";
	readonly lastObservedToolStatus?: "passed" | "failed";
	readonly toolRuns: number;
	readonly requiredToolRun: boolean;
	readonly matchesExpectation: boolean;
	readonly checks: readonly AcceptanceCheckReport[];
}

export interface ChangedFileReport {
	readonly path: string;
	readonly status: "added" | "modified" | "deleted";
	readonly beforeSha256?: string;
	readonly afterSha256?: string;
}

export interface FinalFileStateReport {
	readonly matchesExpected: boolean;
	readonly initialSha256: string;
	readonly finalSha256: string;
	readonly expectedSha256: string;
	readonly changedFiles: readonly ChangedFileReport[];
}

export interface ClaimCheckReport {
	readonly kind: "tests-passed" | "tests-failed" | "files-changed" | "no-files-changed";
	readonly agrees: boolean;
	readonly evidence: string;
}

export interface FinalClaimReport {
	readonly agrees: boolean;
	readonly checkedClaims: number;
	readonly checks: readonly ClaimCheckReport[];
}

export interface EvaluationMetrics {
	readonly turnCount: number;
	readonly toolCount: number;
	readonly toolBatchCount: number;
	readonly repeatedToolBatches: number;
	readonly toolFailures: number;
	readonly sensitiveReadAttempts: number;
	readonly sensitiveReadsExecuted: number;
	readonly elapsedMs: number;
	readonly continuedAfterCompaction: boolean;
}

export interface EvaluationSecurityReport {
	readonly sensitiveDataDisclosed: boolean;
	readonly protectedPathsUnchanged: boolean;
}

export interface FixtureEvaluationReport {
	readonly id: string;
	readonly title: string;
	readonly category: FixtureCategory;
	readonly passed: boolean;
	readonly score: number;
	readonly runOutcome: RunOutcome;
	readonly acceptance: AcceptanceReport;
	readonly finalFileState: FinalFileStateReport;
	readonly finalClaims: FinalClaimReport;
	readonly metrics: EvaluationMetrics;
	readonly usage: EvaluationUsage;
	readonly security: EvaluationSecurityReport;
	readonly finalResponseSha256?: string;
	readonly failures: readonly string[];
}

export interface EvaluationSuiteReport {
	readonly schemaVersion: 1;
	readonly mode: EvaluationMode;
	readonly passed: boolean;
	readonly summary: {
		readonly fixtures: number;
		readonly passed: number;
		readonly failed: number;
		readonly averageScore: number;
		readonly turnCount: number;
		readonly toolCount: number;
		readonly repeatedToolBatches: number;
		readonly elapsedMs: number;
		readonly usage: EvaluationUsage;
	};
	readonly fixtures: readonly FixtureEvaluationReport[];
}

export interface LiveEvaluationOptions {
	/** Must be the literal `true`; the runner rejects before calling the Provider otherwise. */
	readonly allowPaidRequests: true;
	readonly fixtureIds: readonly string[];
	readonly stream: ModelStream;
	readonly clock: Clock;
	readonly maxModelCalls: number;
	readonly priceDataAvailable?: boolean;
}
