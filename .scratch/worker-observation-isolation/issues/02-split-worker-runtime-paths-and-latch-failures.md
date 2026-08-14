# Split Worker Runtime paths and latch fatal failures

Status: resolved
Blocked by: 01

## Objective

Replace the generic awaited Worker event callback with distinct fatal Worker Fact, non-blocking Worker Observation, and narrow Worker Control paths. Add first-failure latching and open-effect-window classification, including parallel Tools and cleanup behavior.

## Scope

- Private Worker Runtime and Work Coordinator composition.
- Semantic Session routing versus transient fast path.
- Worker Fact commit ordering and live reducer application.
- Typed barrier outcome propagation; removal of `fatal_barrier_failed`.
- Item-scoped Session failure and Coordinator-scoped Work Journal failure behavior.
- Control ordering and detachment.

## Acceptance

- Deltas and progress return without an asynchronous barrier operation.
- Model and Tool starts remain behind their durable start Facts.
- The first failure classification cannot be changed by cleanup.
- No append or Control invocation occurs after the fatal latch.
- A poisoned shared Work Journal stops later effects and submissions; a failed Session does not stop unrelated Work Items.

## Comments

- Replaced the generic awaited Worker callback with separate `commitFact`, fire-and-forget `publishObservation`, narrow `controlWorker`, and typed `barrierFailed` seams. Transient Agent events return through the pure Observation path without Session, Journal, or Control promises.
- Added a Worker-owned first-failure latch carrying the original barrier/source/diagnostic and the reducer's exact open Attempt/parallel Tool windows. Cleanup publishes best-effort Observations only; it cannot append another Fact, invoke Control, or change the first classification.
- Added pre-effect Model and Tool gates, atomic `run_started` state installation, item-scoped Session failure, and Coordinator-wide Work Journal fail-stop. Poisoning rejects new batches, aborts active Workers, blocks later Model/Tool adapters, avoids append retries, and records undurable active work in `close()`.
- Replaced static event-name failure tests with gated `attempt_started`/`tool_started`, durable Fact-before-Control ordering, safe first Tool-start failure, parallel sibling-open Tool failure, cleanup suppression, single-root diagnostic, shared-Journal fail-stop, and independent Session failure tests.
- Verification: `npm run check --workspace=@coda/runtime` passed; `npm test --workspace=@coda/runtime` passed (12 files, 75 tests). Production search found no `worker_event`, `fatal_barrier_failed`, `WorkerRuntimeEvent`, `controlWorkerEvent`, or generic Worker persistence callback.
