# Make DeepSWE reports coverage-aware

Type: bug
Status: ready-for-agent
Priority: P1

Upgrade the report schema so missing resource values are never silently treated as real zeros. Distinguish job wall time from cumulative trial/agent time and recover partial usage/cost from terminal events with a streaming reducer.

## Acceptance

- A 100-second job with two concurrent 80-second trials reports `wallElapsedMs=100000` and `cumulativeTrialElapsedMs=160000`.
- Each token/cost/step/agent-time aggregate includes known total, observed/expected trials, and `complete | partial | unavailable`; missing and true zero remain distinguishable.
- Partial JSONL without RunEvidence recovers `attempt_end` usage/cost with source `terminal_events` and bounded memory.
- Cost exposes priced/unpriced attempts and never labels a partial known total as complete.
- An Arktype-style timeout fixture still contributes recoverable resources and explicit partial coverage.
- The versioned report reader remains compatible with round 5–11 legacy input; CLI renders partial totals unambiguously.

## Ownership and dependencies

Own `packages/evals/src/deep-swe.ts`, `deep-swe-cli.ts`, and tests; avoid adapter edits. Issue 10 rebases onto this schema, and issue 03 rebases any config wiring afterward.
