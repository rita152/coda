# Add two-phase deadline and convergence control

Type: task
Status: ready-for-agent
Priority: P0

Add an independent `RunControl` safety envelope that remains active when `--no-run-budget` disables the economic budget. It has a work deadline, one finalization steering, a grace/hard-stop deadline, and conservative progress/stagnation signals.

## Acceptance

- With a deterministic clock, the work deadline emits exactly one finalization request at a safe model boundary; the grace deadline aborts and records an explicit stop reason.
- `--no-run-budget` does not disable RunControl. Unconfigured interactive runs keep current behavior.
- New workspace content, a failed verification becoming successful, or new requirement evidence count as progress; equivalent reads, repeated identical failures, and no workspace change do not.
- Stagnation enters the finalization phase rather than discarding work immediately; long in-flight Tool calls are not mistaken for repeated turns.
- All timers are cancelled on normal completion. Configuration proves `work + grace + adapter finalize margin < Pier hard timeout`.
- `run_end`, status, and evidence expose the phase/reason without conflating this controller with RunBudget.

## Ownership and dependencies

Prefer new `packages/coding-agent/src/run-control/*`. Rebase onto 01/04/06/09 before the thin CLI/eval wiring. Pi's `shouldStopAfterTurn` is a useful safe-boundary pattern. No paid evaluation.
