# Coda Harness Reliability

Status: implemented

The durable integration outcome is recorded in
[`packages/evals/docs/harness-reliability-integration.md`](../../packages/evals/docs/harness-reliability-integration.md).
Implementation and verification completed on 2026-08-13. The plan below is
retained as implementation history.

## Objective

Make the Coda CLI and DeepSWE harness distinguish lifecycle completion from verified completion, preserve upstream shell failures, converge before the evaluator kills the process, salvage artifacts transactionally, and produce complete, coverage-aware evaluation evidence.

This milestone is based on the round 5–11 data audit and the current implementation audit at Coda commit `6aea277ea801d34028af993c68a3c0eb3e5256ba`. The ten issues are independently testable, but several share integration seams and must be rebased in the order below.

## Audited findings

- All ten reported mechanisms are real and worth fixing.
- Round 11 had 19 lifecycle-success/exit-0 runs but only 9 verifier passes. Lifecycle `RunOutcome.success` must remain distinct from task correctness.
- The historical `partial > 0.98` count is 43 zero-reward trials: 42 `failed` plus one timeout `error`.
- The 1,225 pipeline count is lexical (`contains("|")`); excluding pure `||` gives 1,224. Boa directly demonstrates an upstream Rust failure hidden by a zero pipeline exit.
- The 333 Shell-mutation count cannot be reproduced without its original classifier; an independent classifier finds 361 candidates. The native/path-evidence gap itself is confirmed (188 evidence paths versus 217 patch paths; Cliffy 13 versus 35).
- The 122 read issues consist of 118 `output_truncated` and 4 `not_found`, not 122 truncations.
- The 56/120 adjacent status flips are confirmed, but adjacent rounds used different harness revisions. They demonstrate that one observation cannot support causal attribution; they do not estimate pure sampling noise.
- Arktype's recoverable cost is `$0.1411856516`; known round-11 cost is at least `$0.9709328832`, 14.5412% above the reported known-total denominator.

Detailed evidence:

- `.scratch/deep-swe-evals/round-11-harness-defect-audit.md`
- `.scratch/deep-swe-evals/harness-10-defects-implementation-audit.md`
- `.scratch/deep-swe-evals/oss-coding-agent-harness-comparison-2026-08-13.md`

The upstream comparison is pinned to `badlogic/pi-mono@581d75a89cea21e50d6a26df840352f94427f633`, `openai/codex@902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe`, `anomalyco/opencode@cc4b45612974f735ddec46009ede07729511fba4`, and `xai-org/grok-build@e5fd4816d43260c15ba785f103990c1ed6cea230`. The local Pi checkout is a personal fork and is not treated as the official source.

## Product design decisions

1. Add separate completion, run-control, event-output, tool-evidence, and Pier-artifact modules instead of expanding the existing hotspot files with more ad-hoc branches.
2. Keep lifecycle outcome backward compatible. Add a versioned completion disposition (`verified | partial | blocked | unverified`) driven by real evidence and bounded repair, never by parsing phrases such as “Done”.
3. Keep an independent safety envelope when economic RunBudget is disabled. A soft deadline requests finalization; a grace deadline aborts before Pier's hard timeout and leaves time for artifact collection.
4. Treat compact RunEvidence as a summary. Full, redacted Tool evidence belongs in a streamable external artifact referenced by stable IDs.
5. Version evidence/report schema changes and distinguish missing data from a real zero.
6. Do not run paid/provider DeepSWE evaluation in these implementation tasks. Use deterministic unit/integration fixtures; paid A/B starts only after observability and finalization changes land.

## Parallel ownership and integration order

All ten tasks may start in isolated worktrees. Recommended merge waves:

1. Wave A: 02 Shell, 04 artifact finalizer, 06 semantic JSONL, 08 evidence semantics.
2. Wave B: 01 completion gate (rebase onto 06/08), 07 ATIF (onto 04/06), 09 coverage report.
3. Wave C: 03 run control (onto 01/04/06/09), 05 patch Tool (onto 01/08).
4. Wave D: 10 repeated sampling (onto 09 and any 03 config changes).

Hotspot ownership:

- `application.ts`: 06 extracts event writer first; 01 and 03 rebase later.
- `coda_agent.py`: 04 extracts artifact lifecycle first; 07 integrates through that module; 03 only wires flags after rebase.
- `run-evidence.ts`: 08 owns the semantic refactor; 05 consumes its generic mutation facts; 01 only reads the public projection.
- `deep-swe.ts` / `deep-swe-cli.ts`: 09 owns report schema; 10 follows it; 03 rebases configuration wiring.

## Milestone verification

Each task runs its focused tests. Each merge wave must also run the affected package suites, `npm run capabilities:check`, and `npm run check`. The milestone is complete only after deterministic fixtures cover false pipeline success, post-mutation verification invalidation, soft-stop finalization, timeout salvage, 100+ Tool trajectory completeness, missing-resource coverage, and repeated-attempt comparison.
