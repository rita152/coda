# Finalize timeout artifacts transactionally

Type: bug
Status: resolved
Priority: P0

Split the Pier adapter into run and idempotent finalize phases. Create adapter status before launch, update it atomically, and salvage workspace changes, partial terminal events, usage, trajectory, and evidence on internal timeout or external cancellation. Re-raise timeout after bounded cleanup so infrastructure status stays honest.

## Acceptance

- Status exists before Coda starts and records phase, timestamps, outcome, and cleanup errors via atomic replacement.
- A fixture that writes files and emits several `attempt_end` events before timeout yields a non-empty collectible patch, readable partial trajectory/evidence, and recovered step/token/cost coverage.
- Missing `run_end` is marked partial, never fabricated as success.
- Finalize is idempotent; commit failure and no-change cases retain status/events and report their real outcome.
- External cancellation gets a short shielded/best-effort cleanup path; tests document that the internal deadline/finalize margin is the stronger guarantee.
- Normal-run artifacts remain backward compatible.

## Ownership

Own `packages/evals/pier/coda_agent.py` and preferably extract `coda_trial_artifacts.py` plus fixture tests. Issue 07 must integrate through this module after rebase. Do not depend on a paid Pier run.

## Comments

Resolved in `abd60b8`: the Pier adapter writes pre-launch status and uses one idempotent finalization path to salvage patches, terminal events, usage, and partial trajectories.
