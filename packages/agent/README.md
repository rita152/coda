# `@coda/agent`

Headless, in-memory Agent runtime for Coda. It owns model turns, immutable
events, Tool execution, cancellation, Steering/Follow-up queues, validated idle
Seeds, and optional whole-turn retry.

The package depends only on `@coda/ai`. It does not know about terminals,
filesystems, shells, credentials, settings, sessions, or coding-agent policy.

Status: private Milestone 1 package.

## Runtime boundary

- A caller injects the model stream, Clock, IdGenerator, Tool implementations,
  and PolicyGate.
- The System Prompt may be a string or a factory evaluated exactly once per
  Run, so callers can freeze Run-scoped context without exposing their policy.
- `Agent.prompt()` settles only after the final `run_end` listeners complete and
  the Agent is idle. `waitForIdle()` observes the same operation boundary.
- Steering is consumed together at the next safe model-call boundary. Follow-up
  items are consumed FIFO and each starts a new Run. Automatic draining is the
  default; an application scheduler may disable it and call
  `runNextFollowUp()` to interleave other local work without moving that work
  into Agent state.
- Tools default to sequential execution. Only consecutive Tools marked
  `parallelSafe` may overlap, and every Tool declares `replaySafety`.
- An optional immutable `RunBudget` bounds Turns, model Attempts, Tool
  Invocations, elapsed wall time, total tokens, optional recorded USD cost, and
  consecutive equivalent Tool batches. Limits are checked only between model
  or Tool effects; every Follow-up starts with fresh accounting.
- Whole-turn retry is disabled unless both a `TurnRetryPolicy` and cancellable
  `RetryDelay` capability are supplied.

The public package has one root entry. Reducer, dispatch, scheduling, and Seed
validation internals are deliberately not exported.

## Deferred

Session repositories, durable operations, compaction, filesystem and shell
access, coding Tools, model selection, credentials, settings, and terminal UI
belong to later packages or milestones.
