import {
	COMPLETION_DISPOSITION_SCHEMA_VERSION,
	type CompletionActivitySnapshot,
	type CompletionDisposition,
	type CompletionEvidenceCompleteness,
	type CompletionEvidencePoint,
	type CompletionGateDecision,
	type CompletionGateInput,
	type CompletionReason,
	type CompletionVerificationResult,
	type WorkspaceEvidenceSnapshot,
} from "./types.ts";

const REPAIR_STEERING =
	"Completion evidence is not sufficient yet. Inspect the final workspace diff/status, resolve any relevant open mutation or verification failure, and run a focused verification after the latest mutation. If local verification cannot run, preserve the patch and evidence and report the concrete blocker; do not merely restate completion.";

export class CodingCompletionGate {
	evaluate(input: CompletionGateInput): CompletionGateDecision {
		validateRepairBounds(input.repairAttempts, input.maxRepairAttempts);
		const disposition = assessCompletion(input);
		if (shouldRequestRepair(input, disposition)) {
			return deepFreeze({ action: "repair", disposition, steering: REPAIR_STEERING });
		}
		return deepFreeze({ action: "accept", disposition });
	}
}

export function assessCompletion(input: CompletionGateInput): CompletionDisposition {
	validateRepairBounds(input.repairAttempts, input.maxRepairAttempts);
	const runEvidenceState = runEvidenceCompleteness(input);
	const changedDuringRun = workspaceChanged(input.baselineWorkspace, input.finalWorkspace);
	const latestMutation = effectiveLatestMutation(input.activity, input.runEvidence, changedDuringRun);
	const hasMutation = latestMutation !== undefined;
	const evidenceCompleteness = combinedEvidenceCompleteness(runEvidenceState, latestMutation, input.finalWorkspace);
	const verification = verificationAfter(latestMutation, input.activity);
	const openFailures = input.activity.openFailures;
	const reasons: CompletionReason[] = [];
	let disposition: CompletionDisposition["disposition"];

	if (input.modelTermination !== "completed") {
		reasons.push("model_not_completed");
		if (!input.activity.terminalCandidate) reasons.push("terminal_candidate_missing");
		disposition = hasMutation || input.runEvidence?.paths.changed.length ? "partial" : "blocked";
	} else if (!input.activity.terminalCandidate) {
		reasons.push("terminal_candidate_missing");
		disposition = hasMutation ? "partial" : "blocked";
	} else if (openFailures.length > 0) {
		reasons.push("open_relevant_failures");
		if (verification.result === "failed") reasons.push("verification_failed");
		if (verification.result === "infra_error") reasons.push("verification_infra_error");
		disposition = openFailures.some(({ status }) => status !== "error") ? "blocked" : "partial";
	} else if (verification.result === "failed") {
		reasons.push("verification_failed");
		disposition = "partial";
	} else if (verification.result === "infra_error") {
		reasons.push("verification_infra_error");
		disposition = "blocked";
	} else if (runEvidenceState !== "complete") {
		reasons.push(runEvidenceState === "missing" ? "run_evidence_missing" : "run_evidence_partial");
		disposition = "unverified";
	} else if (!hasMutation) {
		reasons.push("read_only_or_diagnosis", "evidence_supported");
		disposition = "verified";
	} else if (verification.result !== "passed" || !verification.afterLatestMutation) {
		reasons.push("mutation_without_post_verification");
		appendWorkspaceEvidenceReason(reasons, input.finalWorkspace);
		disposition = "unverified";
	} else if (!input.finalWorkspace || input.finalWorkspace.status !== "complete") {
		appendWorkspaceEvidenceReason(reasons, input.finalWorkspace);
		disposition = "unverified";
	} else {
		reasons.push("evidence_supported");
		disposition = "verified";
	}

	const repairExhausted = disposition !== "verified" && input.repairAttempts >= input.maxRepairAttempts;
	if (disposition !== "verified" && repairExhausted) reasons.push("repair_limit_reached");
	const finalWorkspace = input.finalWorkspace;
	return deepFreeze({
		schemaVersion: COMPLETION_DISPOSITION_SCHEMA_VERSION,
		type: "completion_disposition",
		runId: input.runId,
		disposition,
		modelTermination: input.modelTermination,
		evidenceCompleteness,
		verification: {
			result: verification.result,
			scope: "local",
			hiddenVerifier: "not_evaluated",
			command: verification.evidence?.command ?? null,
			invocationId: verification.evidence?.invocationId ?? null,
			sequence: verification.evidence?.sequence ?? null,
			afterLatestMutation: verification.afterLatestMutation,
		},
		workspace: {
			status: finalWorkspace?.status ?? "unavailable",
			changedDuringRun,
			dirty: finalWorkspace?.dirty ?? null,
			changedPaths: finalWorkspace?.changedPaths ?? [],
			omittedChangedPaths: finalWorkspace?.omittedChangedPaths ?? 0,
			statusSha256: finalWorkspace?.statusSha256 ?? null,
			diffSha256: finalWorkspace?.diffSha256 ?? null,
			untrackedSha256: finalWorkspace?.untrackedSha256 ?? null,
		},
		evidence: {
			runEvidenceSchemaVersion: input.runEvidence?.schemaVersion ?? null,
			runEvidenceRunId: input.runEvidence?.runId ?? null,
			latestMutationSequence: latestMutation?.sequence ?? null,
			openFailureCount: openFailures.length,
		},
		repair: {
			attempts: input.repairAttempts,
			maxAttempts: input.maxRepairAttempts,
			exhausted: repairExhausted,
		},
		reasons: uniqueReasons(reasons),
	});
}

function combinedEvidenceCompleteness(
	runEvidenceState: CompletionEvidenceCompleteness,
	latestMutation: CompletionEvidencePoint | undefined,
	finalWorkspace: WorkspaceEvidenceSnapshot | undefined,
): CompletionEvidenceCompleteness {
	if (runEvidenceState !== "complete" || !latestMutation) return runEvidenceState;
	if (!finalWorkspace || finalWorkspace.status === "unavailable") return "missing";
	return finalWorkspace.status === "partial" ? "partial" : "complete";
}

function appendWorkspaceEvidenceReason(
	reasons: CompletionReason[],
	finalWorkspace: WorkspaceEvidenceSnapshot | undefined,
): void {
	if (finalWorkspace?.status === "complete") return;
	reasons.push(finalWorkspace?.status === "partial" ? "workspace_evidence_partial" : "workspace_evidence_missing");
}

function shouldRequestRepair(input: CompletionGateInput, disposition: CompletionDisposition): boolean {
	if (disposition.disposition === "verified" || disposition.disposition === "blocked") return false;
	if (input.modelTermination !== "completed" || !input.activity.terminalCandidate) return false;
	if (input.repairAttempts >= input.maxRepairAttempts) return false;
	return disposition.reasons.some(
		(reason) =>
			reason === "mutation_without_post_verification" ||
			reason === "verification_failed" ||
			reason === "open_relevant_failures",
	);
}

function runEvidenceCompleteness(input: CompletionGateInput): CompletionEvidenceCompleteness {
	const evidence = input.runEvidence;
	if (!evidence || evidence.runId !== input.runId) return "missing";
	const omitted =
		evidence.paths.omitted.changed +
		evidence.omitted.operations +
		evidence.omitted.openFailures +
		evidence.omitted.pendingOperations;
	return omitted > 0 || evidence.pendingOperations.length > 0 || evidence.observations.counts["lossy-overflow"] > 0
		? "partial"
		: "complete";
}

function workspaceChanged(
	baseline: WorkspaceEvidenceSnapshot | undefined,
	final: WorkspaceEvidenceSnapshot | undefined,
): boolean | null {
	if (baseline?.status !== "complete" || final?.status !== "complete") return null;
	if (!baseline.fingerprint || !final.fingerprint) return null;
	return baseline.fingerprint !== final.fingerprint;
}

function effectiveLatestMutation(
	activity: CompletionActivitySnapshot,
	runEvidence: CompletionGateInput["runEvidence"],
	changedDuringRun: boolean | null,
): CompletionEvidencePoint | undefined {
	let latest = activity.latestMutation;
	if (
		activity.latestPotentialMutation &&
		changedDuringRun !== false &&
		(!latest || activity.latestPotentialMutation.sequence > latest.sequence)
	) {
		latest = activity.latestPotentialMutation;
	}
	const projectedMutation = (runEvidence?.paths.changed.length ?? 0) > 0;
	if ((changedDuringRun === true || projectedMutation) && !latest) {
		const sequence = activity.terminalCandidate?.sequence ?? 0;
		latest = {
			sequence,
			invocationId: "workspace:final",
			label: "final workspace changed",
			source: "workspace",
		};
	}
	return latest;
}

function verificationAfter(
	latestMutation: CompletionEvidencePoint | undefined,
	activity: CompletionActivitySnapshot,
): {
	readonly result: CompletionVerificationResult;
	readonly afterLatestMutation: boolean;
	readonly evidence?: CompletionActivitySnapshot["latestVerification"];
} {
	const evidence = activity.latestVerification;
	if (!evidence) return { result: "not_run", afterLatestMutation: false };
	const afterLatestMutation = !latestMutation || evidence.sequence > latestMutation.sequence;
	return {
		result: afterLatestMutation ? evidence.result : "not_run",
		afterLatestMutation,
		evidence,
	};
}

function uniqueReasons(reasons: readonly CompletionReason[]): readonly CompletionReason[] {
	return [...new Set(reasons)];
}

function validateRepairBounds(attempts: number, maxAttempts: number): void {
	if (!Number.isSafeInteger(attempts) || attempts < 0)
		throw new Error("repairAttempts must be a non-negative integer");
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
		throw new Error("maxRepairAttempts must be a non-negative integer");
	}
	if (attempts > maxAttempts) throw new Error("repairAttempts must not exceed maxRepairAttempts");
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const nested of Object.values(value)) deepFreeze(nested);
	return value;
}
