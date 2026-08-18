import type { RunControlProgressFact } from "./types.ts";

interface RunProgressSnapshot {
	readonly revision: number;
	readonly consecutiveStationaryTurns: number;
	readonly workspaceContentCount: number;
	readonly verificationTargetCount: number;
	readonly requirementEvidenceCount: number;
	readonly uniqueReadCount: number;
	readonly uniqueFailureCount: number;
}

/**
 * Conservative stationarity projection. Novel observations count once; replaying
 * an equivalent read, failure, verification outcome, or workspace digest does not.
 */
export class RunProgressTracker {
	readonly #workspaceContent = new Map<string, string>();
	readonly #workspaceDigests = new Set<string>();
	readonly #verificationStates = new Map<string, "failed" | "passed">();
	readonly #verificationOutcomes = new Set<string>();
	readonly #requirementEvidence = new Set<string>();
	readonly #reads = new Set<string>();
	readonly #failures = new Set<string>();
	#revision = 0;
	#turnProgress = false;
	#consecutiveStationaryTurns = 0;

	beginTurn(): void {
		this.#turnProgress = false;
	}

	seedWorkspaceContent(path: string, digest: string): void {
		this.#workspaceContent.set(path, digest);
		this.#workspaceDigests.add(workspaceDigest(path, digest));
	}

	observe(fact: RunControlProgressFact): boolean {
		let novel = false;
		switch (fact.kind) {
			case "workspace_content": {
				this.#workspaceContent.set(fact.path, fact.digest);
				const observation = workspaceDigest(fact.path, fact.digest);
				novel = !this.#workspaceDigests.has(observation);
				this.#workspaceDigests.add(observation);
				break;
			}
			case "verification": {
				this.#verificationStates.set(fact.target, fact.status);
				const outcome = `${fact.target}\u0000${fact.status}`;
				novel = !this.#verificationOutcomes.has(outcome);
				this.#verificationOutcomes.add(outcome);
				break;
			}
			case "requirement_evidence": {
				const evidence = `${fact.requirementId}\u0000${fact.evidenceId}`;
				novel = !this.#requirementEvidence.has(evidence);
				this.#requirementEvidence.add(evidence);
				break;
			}
			case "read":
				novel = !this.#reads.has(fact.fingerprint);
				this.#reads.add(fact.fingerprint);
				break;
			case "failure":
				novel = !this.#failures.has(fact.fingerprint);
				this.#failures.add(fact.fingerprint);
				break;
		}
		if (!novel) return false;
		this.#revision++;
		this.#turnProgress = true;
		this.#consecutiveStationaryTurns = 0;
		return true;
	}

	finishTurn(): number {
		if (this.#turnProgress) this.#consecutiveStationaryTurns = 0;
		else this.#consecutiveStationaryTurns++;
		this.#turnProgress = false;
		return this.#consecutiveStationaryTurns;
	}

	snapshot(): RunProgressSnapshot {
		return Object.freeze({
			revision: this.#revision,
			consecutiveStationaryTurns: this.#consecutiveStationaryTurns,
			workspaceContentCount: this.#workspaceContent.size,
			verificationTargetCount: this.#verificationStates.size,
			requirementEvidenceCount: this.#requirementEvidence.size,
			uniqueReadCount: this.#reads.size,
			uniqueFailureCount: this.#failures.size,
		});
	}
}

function workspaceDigest(path: string, digest: string): string {
	return `${path}\u0000${digest}`;
}
