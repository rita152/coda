# `@coda/agent`

Headless, in-memory Agent runtime for Coda. It owns model turns, immutable
events, Tool execution, cancellation, Steering/Follow-up queues, validated idle
Seeds, a neutral append-only Session contract, and optional whole-turn retry.

The private package depends only on `@coda/ai`. It does not know about
terminals, filesystems, shells, credentials, settings, Session storage, or
Coding Agent policy.

## Runtime boundary

- A caller injects a Clock, IdGenerator, and one `prepareRun` function.
  Preparation runs exactly once and freezes the Model stream, Tools, System
  Prompt, failed-Attempt recovery, optional budget, and disposal capability for
  that Run.
- `Agent.prompt()` settles only after the final `run_end` listeners complete and
  the Agent is idle. `waitForIdle()` observes the same operation boundary.
- Steering is consumed together at the next safe model-call boundary. Follow-up
  items are consumed FIFO and each starts a new Run. Automatic draining is the
  default; an application scheduler may disable it and call
  `runNextFollowUp()` to interleave other local work without moving that work
  into Agent state.
- Tools default to sequential execution. Only consecutive Tools marked
  `parallelSafe` may overlap, and every Tool declares `replaySafety`.
  Callers that journal `tool_started` themselves can run the same lookup,
  validation, `execute()`, and cancel path through `settleToolInvocation`
  without constructing a Run.
- An optional immutable `RunBudget` bounds Turns, model Attempts, Tool
  Invocations, elapsed wall time, total tokens, optional recorded USD cost, and
  consecutive equivalent Tool batches. Limits are checked only between model
  or Tool effects; every Follow-up starts with fresh accounting.
- Whole-turn retry is disabled unless both a `TurnRetryPolicy` and cancellable
  `RetryDelay` capability are supplied.

The package has one root entry. Reducer, dispatch, scheduling, and Seed
validation internals are deliberately not exported.

## Package boundary

Physical Session repositories, Context Window and Compaction policy, filesystem
and Shell access, coding Tools, Model selection, Credentials, settings, and
terminal UI do not belong to `@coda/agent`. `@coda/runtime` owns Worker Runtime
composition, Session attachment, and Context Window orchestration;
`@coda/coding-agent` supplies durable Session and host Adapters.
