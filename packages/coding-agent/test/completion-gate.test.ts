import { describe, expect, it } from "vitest";
import { CodingCompletionGate } from "../src/completion/completion-gate.ts";
import type {
	CompletionActivitySnapshot,
	CompletionGateInput,
	CompletionRelevantFailure,
	WorkspaceEvidenceSnapshot,
} from "../src/completion/types.ts";
import { completionRunEvidence } from "./completion-test-helpers.ts";

describe("CodingCompletionGate", () => {
	it("verifies read-only or diagnosis completion without requiring a test command", () => {
		const decision = gate().evaluate(input());

		expect(decision).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "verified",
				modelTermination: "completed",
				evidenceCompleteness: "complete",
				verification: {
					result: "not_run",
					scope: "local",
					hiddenVerifier: "not_evaluated",
				},
				reasons: ["read_only_or_diagnosis", "evidence_supported"],
			},
		});
	});

	it("requests one bounded repair for a mutation without post-mutation verification", () => {
		const activity = mutationActivity(20);
		const first = gate().evaluate(input({ activity }));

		expect(first).toMatchObject({
			action: "repair",
			disposition: {
				disposition: "unverified",
				verification: { result: "not_run", afterLatestMutation: false },
				repair: { attempts: 0, maxAttempts: 1, exhausted: false },
			},
		});
		if (first.action !== "repair") throw new Error("expected repair");
		expect(first.steering).toContain("run a focused verification after the latest mutation");

		const bounded = gate().evaluate(input({ activity, repairAttempts: 1 }));
		expect(bounded).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "unverified",
				repair: { attempts: 1, maxAttempts: 1, exhausted: true },
				reasons: ["mutation_without_post_verification", "repair_limit_reached"],
			},
		});
	});

	it("invalidates a successful verification that predates the latest mutation", () => {
		const decision = gate().evaluate(
			input({
				activity: {
					...mutationActivity(30),
					latestVerification: verification(20, "passed"),
				},
			}),
		);

		expect(decision).toMatchObject({
			action: "repair",
			disposition: {
				disposition: "unverified",
				verification: { result: "not_run", sequence: 20, afterLatestMutation: false },
				evidence: { latestMutationSequence: 30 },
			},
		});
	});

	it("keeps missing workspace evidence orthogonal to a missing verification", () => {
		const decision = gate().evaluate(
			input({
				activity: mutationActivity(20),
				finalWorkspace: undefined,
			}),
		);

		expect(decision).toMatchObject({
			action: "repair",
			disposition: {
				disposition: "unverified",
				evidenceCompleteness: "missing",
				verification: { result: "not_run" },
				reasons: ["mutation_without_post_verification", "workspace_evidence_missing"],
			},
		});
	});

	it("verifies a relevant successful verification after the latest mutation with final workspace evidence", () => {
		const decision = gate().evaluate(
			input({
				finalWorkspace: workspace("after", true, ["src/value.ts"]),
				activity: {
					...mutationActivity(20),
					latestVerification: verification(30, "passed"),
				},
			}),
		);

		expect(decision).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "verified",
				verification: { result: "passed", afterLatestMutation: true },
				workspace: { status: "complete", changedDuringRun: true, changedPaths: ["src/value.ts"] },
				reasons: ["evidence_supported"],
			},
		});
	});

	it("keeps open failures orthogonal and preserves patch/evidence links for partial and blocked results", () => {
		const partial = gate().evaluate(
			input({
				activity: failureActivity(failure("error", "verification")),
				finalWorkspace: workspace("after", true, ["src/value.ts"]),
				repairAttempts: 1,
			}),
		);
		const blocked = gate().evaluate(
			input({
				activity: failureActivity(failure("aborted", "mutation")),
				finalWorkspace: workspace("after", true, ["src/value.ts"]),
				repairAttempts: 1,
			}),
		);

		expect(partial).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "partial",
				evidence: { runEvidenceRunId: "run:test", openFailureCount: 1 },
				workspace: { changedPaths: ["src/value.ts"] },
			},
		});
		expect(blocked).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "blocked",
				evidence: { runEvidenceRunId: "run:test", openFailureCount: 1 },
				workspace: { changedPaths: ["src/value.ts"] },
			},
		});
	});

	it("does not conflate lifecycle completion, evidence completeness, local verification, or hidden verification", () => {
		const decision = gate().evaluate(
			input({
				modelTermination: "interrupted",
				runEvidence: undefined,
				activity: mutationActivity(10),
				repairAttempts: 1,
			}),
		);

		expect(decision).toMatchObject({
			action: "accept",
			disposition: {
				disposition: "partial",
				modelTermination: "interrupted",
				evidenceCompleteness: "missing",
				verification: { result: "not_run", hiddenVerifier: "not_evaluated" },
			},
		});
	});
});

function gate(): CodingCompletionGate {
	return new CodingCompletionGate();
}

function input(overrides: Partial<CompletionGateInput> = {}): CompletionGateInput {
	return {
		runId: "run:test",
		modelTermination: "completed",
		runEvidence: completionRunEvidence(),
		activity: { openFailures: [], terminalCandidate: candidate() },
		baselineWorkspace: workspace("before", false, []),
		finalWorkspace: workspace("before", false, []),
		repairAttempts: 0,
		maxRepairAttempts: 1,
		...overrides,
	};
}

function workspace(fingerprint: string, dirty: boolean, changedPaths: readonly string[]): WorkspaceEvidenceSnapshot {
	return {
		schemaVersion: 1,
		status: "complete",
		capturedAt: 1,
		dirty,
		changedPaths,
		omittedChangedPaths: 0,
		statusSha256: `${fingerprint}:status`,
		diffSha256: `${fingerprint}:diff`,
		untrackedSha256: `${fingerprint}:untracked`,
		fingerprint,
		diagnostics: [],
	};
}

function candidate() {
	return { messageId: "message:final", turnId: "turn:final", sequence: 40 };
}

function mutationActivity(sequence: number): CompletionActivitySnapshot {
	return {
		latestMutation: {
			sequence,
			invocationId: "tool:edit",
			label: "edit src/value.ts",
			source: "tool",
		},
		openFailures: [],
		terminalCandidate: candidate(),
	};
}

function verification(sequence: number, result: "passed" | "failed" | "infra_error") {
	return {
		sequence,
		invocationId: "tool:test",
		label: "git diff --check",
		source: "tool" as const,
		result,
		command: "git diff --check",
	};
}

function failure(
	status: CompletionRelevantFailure["status"],
	kind: CompletionRelevantFailure["kind"],
): CompletionRelevantFailure {
	return {
		key: `${kind}:target`,
		kind,
		status,
		sequence: 25,
		invocationId: `tool:${kind}`,
		summary: `${kind} ${status}`,
	};
}

function failureActivity(openFailure: CompletionRelevantFailure): CompletionActivitySnapshot {
	return {
		...mutationActivity(20),
		...(openFailure.kind === "verification" ? { latestVerification: verification(25, "failed") } : {}),
		openFailures: [openFailure],
	};
}
