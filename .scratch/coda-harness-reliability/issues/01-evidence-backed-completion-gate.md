# Add an evidence-backed completion gate

Type: task
Status: ready-for-agent
Priority: P0

Separate lifecycle success from task completion. Introduce a small `CodingCompletionGate` module and a versioned `CompletionDisposition` (`verified | partial | blocked | unverified`) for print/JSON/eval runs. The gate consumes terminal candidate, public RunEvidence, final workspace diff/status, and bounded repair count; it must never parse “Done” or claim equivalence with the hidden verifier.

## Acceptance

- Read-only/diagnosis tasks are not rejected merely for having no test command.
- A mutation followed by self-declared completion without post-mutation verification cannot be `verified`; at most one bounded, actionable repair steering is injected by default.
- A verification that predates the latest mutation is invalidated; a relevant successful verification after the latest mutation plus final diff/status evidence can produce `verified`.
- Open relevant failures force `partial`/`blocked`; all dispositions still preserve patch and evidence.
- Repair bounds prevent a completion loop. CLI/JSON emits the structured disposition and print-mode exit semantics are explicitly tested and documented.
- `RunOutcome.success` keeps its lifecycle meaning and existing interactive behavior remains compatible.

## Ownership and dependencies

Prefer new `packages/coding-agent/src/completion/*`; keep `application.ts` integration thin. Rebase onto issues 06 and 08. Do not duplicate event reduction or failure reconciliation. Use deterministic fake-model tests; no provider calls.
