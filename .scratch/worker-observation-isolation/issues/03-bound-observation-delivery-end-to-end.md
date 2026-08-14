# Bound Worker Observation delivery end to end

Status: resolved
Blocked by: 02

## Objective

Make every Observation hop from Worker Runtime through the application adapters non-blocking and memory-bounded, with explicit resynchronization and total projection behavior.

## Scope

- Coordinator Observation publication and safe JSON projection.
- Public subscriber overflow/resynchronization behavior.
- Workspace observation pump and per-Session delivery.
- Removal of `SessionWorkController.#observationTail` and callback-driven unbounded queues.
- TUI, print/JSON, evaluation, telemetry, and completion/control wiring affected by the new paths.

## Acceptance

- No consumer promise is reachable from Worker Runtime progression.
- Serialization/projection failure drops one Observation and emits a non-recursive bounded diagnostic.
- Every queue has an enforced capacity and a tested overflow outcome.
- Resynchronization rebuilds committed state rather than silently ignoring the snapshot.
- Stalled consumers do not affect Run settlement or close.

## Comments

- Removed the Agent Tool-progress promise chain and `SessionWorkController.#observationTail`. Message start/delta and Tool progress now take a synchronous fire-and-forget path into bounded public and per-Session mailboxes; stalled consumer promises are never awaited by Agent, Worker, Session, Journal, Model, Tool, settlement, or close.
- Added per-subscriber hard capacities, slow-consumer `resync_required`, throwing-consumer detachment, and upstream snapshot application. Session resynchronization rebuilds active Work identity/placement from the Coding Agent snapshot and committed conversation/tool lifecycle from the Session; TUI projections replace their timeline, JSON emits the durable resync seed, and completion/RunControl use the narrow causal Control seam.
- Made Worker Observation JSON projection total for Worker progression: an unserializable payload drops only that Observation and emits one bounded `worker_observation_dropped` diagnostic without cloning the failed payload. Workspace forwarding restarts from a fresh snapshot after public overflow.
- Verification: `npm run check --workspace=@coda/agent` passed; `npm test --workspace=@coda/agent` passed (10 files, 72 tests); `npm run check --workspace=@coda/coding-agent` passed; focused `session-work-controller`, `run-control`, `json-event-writer`, and `file-work-journal` suites passed (18 tests total, including slow/failing consumers and both local/upstream resynchronization).
