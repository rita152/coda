import { deepFreeze } from "@coda/agent";
import type { RunEvidenceEnvelope, RunEvidenceFailure, RunEvidenceOperation } from "../run-evidence/contracts.ts";
import { classifyShellCommand, sanitizeCompletionCommand } from "./completion-evidence.ts";
import type {
	CompletionActivitySnapshot,
	CompletionEvidencePoint,
	CompletionRelevantFailure,
	CompletionTemporalSnapshot,
	CompletionVerificationEvidence,
} from "./types.ts";

/**
 * Adapts the public RunEvidence operation chronology and open-failure set to
 * completion policy. Failure reconciliation remains exclusively owned by RunEvidence.
 */
export function completionActivityFromRunEvidence(
	temporal: CompletionTemporalSnapshot,
	evidence: RunEvidenceEnvelope | undefined,
): CompletionActivitySnapshot {
	if (!evidence) return deepFreeze({ ...temporal, openFailures: [] });
	const operations = evidence.operations;
	const operationById = new Map(operations.map((operation) => [operation.invocationId, operation]));
	const activity = activityFromOperations(temporal, evidence);
	return deepFreeze({
		...activity,
		openFailures: evidence.openFailures
			.filter((failure) => isCompletionRelevant(failure, operationById.get(failure.id)))
			.map((failure) => relevantFailure(failure, operationById.get(failure.id))),
	});
}

function activityFromOperations(
	temporal: CompletionTemporalSnapshot,
	evidence: RunEvidenceEnvelope,
): CompletionTemporalSnapshot {
	let latestMutation: CompletionEvidencePoint | undefined;
	let latestPotentialMutation: CompletionEvidencePoint | undefined;
	let latestVerification: CompletionVerificationEvidence | undefined;
	for (const operation of evidence.operations) {
		const commandEffect = operation.command ? classifyShellCommand(operation.command) : undefined;
		const succeeded = operation.status === "ok" && operation.settlement === "returned";
		const changed = operation.paths.filter(({ effect }) => effect === "changed");
		if (succeeded && changed.length > 0) {
			latestMutation = point(operation, changed.map(({ path }) => path).join(", ") || "workspace mutation");
		}
		if (operation.command && commandEffect === "verification") {
			const command = sanitizeCompletionCommand(operation.command);
			const commandEvidence = evidence.commands.find(
				(candidate) => candidate.invocationId === operation.invocationId,
			);
			latestVerification = {
				...point(operation, command),
				result:
					operation.status === "ok" && operation.settlement === "returned"
						? "passed"
						: operation.status === "error" &&
								operation.settlement === "returned" &&
								commandEvidence?.timedOut !== true
							? "failed"
							: "infra_error",
				command,
			};
		} else if (operation.command && commandEffect === "potential_mutation" && operation.settlement === "returned") {
			latestPotentialMutation = point(operation, `Shell command: ${sanitizeCompletionCommand(operation.command)}`);
		}
	}
	return {
		...(latestMutation ? { latestMutation } : {}),
		...(latestPotentialMutation ? { latestPotentialMutation } : {}),
		...(latestVerification ? { latestVerification } : {}),
		...(temporal.terminalCandidate ? { terminalCandidate: temporal.terminalCandidate } : {}),
	};
}

function isCompletionRelevant(failure: RunEvidenceFailure, operation: RunEvidenceOperation | undefined): boolean {
	if (failure.kind !== "tool" || !operation) return true;
	if (failure.status !== "error" || operation.settlement !== "returned") return true;
	if (operation.mutation) return true;
	if (operation.command) return classifyShellCommand(operation.command) !== "read_only";
	return false;
}

function relevantFailure(
	failure: RunEvidenceFailure,
	operation: RunEvidenceOperation | undefined,
): CompletionRelevantFailure {
	return {
		key: bounded(failure.resolutionKey ?? `run-evidence:${failure.kind}:${failure.id}`),
		kind: failureKind(operation),
		status: failure.status === "interrupted" ? "aborted" : failure.status,
		sequence: failure.sequence,
		invocationId: bounded(failure.id),
		summary: bounded(failure.summary),
	};
}

function failureKind(operation: RunEvidenceOperation | undefined): CompletionRelevantFailure["kind"] {
	if (!operation) return "evidence";
	if (operation.mutation || operation.paths.some(({ effect }) => effect === "changed")) return "mutation";
	if (!operation.command) return "evidence";
	const effect = classifyShellCommand(operation.command);
	return effect === "verification" ? "verification" : effect === "potential_mutation" ? "mutation" : "evidence";
}

function point(operation: RunEvidenceOperation, label: string): CompletionEvidencePoint {
	return {
		sequence: operation.completedSequence,
		invocationId: bounded(operation.invocationId),
		label: bounded(label),
		source: "tool",
	};
}

function bounded(value: string): string {
	const characters = Array.from(value);
	return characters.length <= 512 ? value : `${characters.slice(0, 511).join("")}…`;
}
