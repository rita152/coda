import type { AgentEvent } from "@coda/agent";
import { RunEvidenceProjection } from "../run-evidence/run-evidence.ts";
import { CompletionActivityProjection } from "./completion-evidence.ts";
import { assessCompletion, CodingCompletionGate } from "./completion-gate.ts";
import { completionActivityFromRunEvidence } from "./run-evidence-adapter.ts";
import {
	type CompletionDisposition,
	type CompletionModelTermination,
	type CompletionWorkspaceEvidenceProvider,
	WORKSPACE_EVIDENCE_SCHEMA_VERSION,
	type WorkspaceEvidenceSnapshot,
} from "./types.ts";

export const DEFAULT_COMPLETION_REPAIR_ATTEMPTS = 1;

export interface CodingCompletionControllerOptions {
	readonly workspaceEvidence: CompletionWorkspaceEvidenceProvider;
	readonly steer: (message: string) => Promise<void> | void;
	readonly maxRepairAttempts?: number;
}

interface CompletionRunState {
	readonly runId: string;
	readonly baselineWorkspace: WorkspaceEvidenceSnapshot;
	repairAttempts: number;
	finalWorkspace?: WorkspaceEvidenceSnapshot;
}

/** Coordinates the pure gate at settled Agent event boundaries in print mode. */
export class CodingCompletionController {
	readonly #options: CodingCompletionControllerOptions;
	readonly #gate = new CodingCompletionGate();
	readonly #activity = new CompletionActivityProjection();
	readonly #evidence = new RunEvidenceProjection();
	readonly #runs = new Map<string, CompletionRunState>();
	readonly #dispositions = new Map<string, CompletionDisposition>();

	constructor(options: CodingCompletionControllerOptions) {
		const maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_COMPLETION_REPAIR_ATTEMPTS;
		if (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
			throw new Error("maxRepairAttempts must be a non-negative integer");
		}
		this.#options = { ...options, maxRepairAttempts };
	}

	get(runId: string): CompletionDisposition | undefined {
		const disposition = this.#dispositions.get(runId);
		return disposition ? structuredClone(disposition) : undefined;
	}

	async accept(event: AgentEvent): Promise<void> {
		const completedEvidence = this.#evidence.accept(event);
		this.#activity.accept(event);
		if (event.type === "run_start") {
			this.#runs.set(event.runId, {
				runId: event.runId,
				baselineWorkspace: await safeCapture(this.#options.workspaceEvidence, event.timestamp),
				repairAttempts: 0,
			});
			return;
		}
		const state = this.#runs.get(event.runId);
		if (!state) return;
		if (event.type === "turn_end" && event.outcome === "success") {
			const temporal = this.#activity.snapshot(event.runId);
			if (!temporal.terminalCandidate || temporal.terminalCandidate.turnId !== event.turnId) return;
			state.finalWorkspace = await safeCapture(this.#options.workspaceEvidence, event.timestamp);
			const runEvidence = this.#evidence.snapshot(event.runId, event.timestamp, "success");
			const activity = completionActivityFromRunEvidence(temporal, runEvidence);
			const decision = this.#gate.evaluate({
				runId: event.runId,
				modelTermination: "completed",
				runEvidence,
				activity,
				baselineWorkspace: state.baselineWorkspace,
				finalWorkspace: state.finalWorkspace,
				repairAttempts: state.repairAttempts,
				maxRepairAttempts: this.#maxRepairAttempts,
			});
			if (decision.action === "repair") {
				await this.#options.steer(decision.steering);
				state.repairAttempts++;
			}
			return;
		}
		if (event.type !== "run_end") return;
		// A repair Turn can mutate the Workspace and then fail before producing
		// another terminal candidate. Re-capture at lifecycle settlement so the
		// emitted disposition never points at the earlier pre-repair snapshot.
		state.finalWorkspace = await safeCapture(this.#options.workspaceEvidence, event.timestamp);
		const activity = completionActivityFromRunEvidence(this.#activity.snapshot(event.runId), completedEvidence);
		const disposition = assessCompletion({
			runId: event.runId,
			modelTermination: modelTermination(event),
			runEvidence: completedEvidence,
			activity,
			baselineWorkspace: state.baselineWorkspace,
			finalWorkspace: state.finalWorkspace,
			repairAttempts: state.repairAttempts,
			maxRepairAttempts: this.#maxRepairAttempts,
		});
		this.#dispositions.set(event.runId, disposition);
		this.#activity.delete(event.runId);
		this.#runs.delete(event.runId);
	}

	get #maxRepairAttempts(): number {
		return this.#options.maxRepairAttempts ?? DEFAULT_COMPLETION_REPAIR_ATTEMPTS;
	}
}

function modelTermination(event: Extract<AgentEvent, { type: "run_end" }>): CompletionModelTermination {
	if (event.outcome === "success") return "completed";
	if (event.outcome === "aborted") return "interrupted";
	return "failed";
}

async function safeCapture(
	provider: CompletionWorkspaceEvidenceProvider,
	fallbackTimestamp: number,
): Promise<WorkspaceEvidenceSnapshot> {
	try {
		return await provider.capture();
	} catch {
		return Object.freeze({
			schemaVersion: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
			status: "unavailable",
			capturedAt: fallbackTimestamp,
			dirty: null,
			changedPaths: Object.freeze([]),
			omittedChangedPaths: 0,
			statusSha256: null,
			diffSha256: null,
			untrackedSha256: null,
			fingerprint: null,
			diagnostics: Object.freeze(["workspace_evidence_provider_failed"]),
		});
	}
}
