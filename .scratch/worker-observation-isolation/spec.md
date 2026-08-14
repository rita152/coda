# Worker Fact and Observation Isolation

Status: accepted

## Goal

Remove transient Worker Observations from every fatal persistence barrier and every unbounded forwarding queue. Preserve fatal ordering only for bounded semantic Worker Facts, so independent Worker Runtimes can stream concurrently without token deltas, Tool progress, presentation code, or slow consumers delaying Model and Tool progression.

The result must make the distinction structural and exhaustive. A future Agent event must not become durable merely because it was added to a generic event union.

## Problem statement

The current implementation routes every `WorkerRuntimeEvent` through one awaited callback:

1. `Agent.#dispatch` awaits every listener for every event, including each `message_update`.
2. the Worker Runtime awaits Session acceptance and then awaits the Coordinator callback;
3. the Coordinator serializes the complete event as `worker_event` and awaits the Work Journal;
4. `FileWorkJournal.append` writes and `sync()`s each record;
5. only after that barrier does the Coordinator publish the public Observation and invoke Worker Control.

This gives transient Observations fatal semantics, duplicates full Messages and Tool results across Session and Work Journal, globally serializes parallel streams on per-token `fsync`, and allows Observation projection errors to abort a Run. Cleanup after a real barrier failure can also retry an already poisoned journal and incorrectly change a safe pre-effect failure into an interrupted Work Item.

The current public Observation buffer does not await consumers, but the application-level `SessionWorkController` adds an unbounded promise tail after that buffer. The complete delivery path is therefore not bounded.

## Non-goals

- Do not add a sandbox, approval system, permission policy, or Tool confirmation flow.
- Do not preserve the v1 Work Journal format, `worker_event`, `fatal_barrier_failed`, or the current callback names and types.
- Do not make the serial Agent concurrent or share one Session between Worker Runtimes.
- Do not make best-effort Observations replayable audit records. Durable conversation remains the Session's responsibility.
- Do not weaken fatal ordering around Model calls, Tool Invocations, Work Graph transitions, input-resource settlement, or Publication.

## Vocabulary and invariants

### Worker Fact

A Worker Fact is a bounded semantic fact required for Work Item recovery, budget reconstruction, external-effect uncertainty, or the durable lifecycle point preceding Worker Control. It is the only Worker Runtime output admitted to the Work Journal.

Worker Facts must never contain an `AgentEvent`, `AgentMessage`, `MessageDelta`, input Message, Assistant content, Tool arguments, Tool result, Tool progress, arbitrary Tool details, preparation resource references, or executable capability. Their encoded size must be bounded independently of model output and Tool output.

### Worker Observation

A Worker Observation is a full-fidelity, live projection for the TUI, print/JSON, evaluation, telemetry, and future Extensions. Publishing is synchronous or fire-and-forget from the Worker Runtime's perspective, returns `void`, never invokes a consumer inline, never rejects, and never acquires a persistence lock.

Observation delivery is lossy under pressure. Every queue is bounded. Overflow produces `resync_required`; the application rebuilds durable presentation state from the Coding Agent snapshot and Session rather than retaining an unbounded promise chain.

### Worker Control

Worker Control receives only the closed semantic subset required by causal policy. It runs after the applicable Session and Worker Fact barriers. It may intentionally delay later Agent progression, for example while a `turn_end` completion repair submits Steering. Failure diagnoses and detaches the controller; it is never converted into a persistence failure.

### Fatal ordering

For a semantic Agent event, ordering is:

```text
Agent event
  -> applicable Session append
  -> applicable Worker Fact append
  -> apply the live Worker Fact projection
  -> publish Worker Observation without awaiting a consumer
  -> applicable Worker Control
  -> later Model, Tool, or Agent progression
```

For a transient Agent event, ordering is:

```text
Agent event -> publish Worker Observation -> immediate return
```

There must be no promise created by Session persistence, Work Journal persistence, Worker Control, or a consumer on the transient path.

## Required modules and seams

### 1. Exhaustive Worker event router

Introduce one pure internal module that exhaustively maps every Agent event to a disposition:

- optional narrowly typed Session event;
- optional Worker Fact;
- optional narrowly typed Worker Control event;
- one Worker Observation.

Preparation lifecycle Observations are routed explicitly outside the Agent event algebra. Delete the catch-all `onEvent(WorkerRuntimeEvent)` interface. A TypeScript exhaustiveness failure must force a routing decision whenever `AgentEvent` gains a variant.

The `WorkerSession` interface accepts only the semantic Session event union. It must be impossible at the type level for `message_start`, `message_update`, or `tool_execution_progress` to call `WorkerSession.accept`.

### 2. Worker Fact journal and projection

Replace `WorkJournalRecord.type === "worker_event"` with `type === "worker_fact"` carrying this closed, bounded fact algebra:

| Worker Fact | Minimum bounded data | Recovery effect |
| --- | --- | --- |
| `run_started` | Run identity and timestamp | Establish the durable lifecycle point before Run-start Control and perform `preparing -> running` for the first Run |
| `attempt_started` | Run, Turn, Attempt and Message identities, attempt number, timestamp | Increment model Attempts and open an Attempt effect window |
| `attempt_settled` | Matching identities, outcome, discarded flag, total token count, timestamp | Add token usage and close the Attempt window |
| `tool_started` | Run, Turn and Tool Invocation identities, bounded Tool name, replay safety, timestamp | Increment Tool Invocations and open a Tool effect window |
| `tool_settled` | Matching identities, settlement, outcome, timestamp | Close the Tool effect window |
| `turn_settled` | Run and Turn identities, outcome, timestamp | Establish the durable lifecycle point before Turn-end Control |
| `budget_exhausted` | Run identity, bounded exhaustion data, timestamp | Restore structured Run Budget exhaustion |
| `run_settled` | Run identity, outcome, bounded failure classification, timestamp | Establish the durable lifecycle point before Run-end Control |

Use one pure Worker Fact reducer for both live accounting and recovery. It owns model-Attempt count, Tool-Invocation count, total tokens, exhaustion, open Attempt identities, and open Tool Invocation identities. For live work, compute and validate the next projection before append, append the Fact, and install the already validated projection only after append succeeds. Delete duplicated event-name switches from live handling and recovery.

`run_started` replaces the separate `item_transition` record for the first `preparing -> running` edge so one semantic point does not require two `sync()` calls. Later Runs for the same Work Item append `run_started` while it remains `running`. Other Work Item transitions continue to use `item_transition`.

The reducer validates impossible settlement, duplicate start, identity mismatch, and counter overflow. Invalid restored facts fail recovery with an exact diagnostic; they are not silently accepted.

### 3. Fatal barrier latch

The Worker Runtime owns a first-failure latch for its fatal paths. After Session or Worker Fact persistence fails:

- capture the barrier, source fact/event, original diagnostic, and currently open Attempt and Tool effect windows;
- abort later Agent progression;
- skip all later Session and Work Journal writes emitted by cleanup;
- skip Worker Control for cleanup events that did not reach their durable lifecycle point;
- permit best-effort cleanup Observations without letting them change failure classification;
- return a typed Worker barrier outcome to the Coordinator instead of emitting `fatal_barrier_failed` through the Observation union.

External-effect uncertainty is derived from the effect windows, not a static safe-event list. A successfully appended `attempt_started` or `tool_started` opens a window; only its successfully appended settlement closes it. This must handle multiple parallel Tool Invocations. If the second Tool-start barrier fails while the first Tool is already open, the Work Item is interrupted even though the second Tool itself did not start. If the first Tool-start barrier fails with no open window, the Work Item fails without claiming an unknown Tool effect.

A Session barrier failure is scoped to its Worker Runtime. A Work Journal append failure is Coordinator-wide because the journal is a shared fatal dependency: atomically latch persistence failure, reject new batches with a persistence-unavailable rejection, abort active Worker Runtimes, prevent new Model/Tool effects, stop retrying the poisoned journal, and surface undurable active work in the close result. Observation delivery remains available for the failure diagnostic.

### 4. Non-blocking Observation module

Keep the existing bounded public `observe()` model but deepen it into the only Worker Observation delivery module:

- a Worker Runtime publishes without awaiting or receiving a consumer result;
- conversion to public `JsonValue` is total for the caller: an unsupported value drops that Observation and emits a bounded `worker_observation_dropped` diagnostic;
- diagnostic fallback never serializes or clones the offending payload and cannot recurse;
- each subscriber has a hard capacity and receives one `resync_required` terminal Observation on overflow;
- global Coding Agent sequence remains monotonic and per-Worker Agent event order is preserved;
- close does not wait for stalled consumers.

Remove `SessionWorkController.#observationTail` and any equivalent unbounded per-event promise chain. Replace callback delivery with a bounded per-Session Observation mailbox or consume the Coding Agent stream directly. On resynchronization, apply the Coding Agent snapshot and rebuild committed conversation state from the Session; transient partial output may disappear until its terminal semantic event arrives.

### 5. Narrow Worker Control

Replace `controlWorkerEvent(WorkerRuntimeEvent)` with a closed `WorkerControlEvent` union. It contains only:

- `run_start`;
- `turn_start`;
- `attempt_end`;
- `retry_scheduled`;
- `message_end`;
- `tool_execution_start`;
- `tool_execution_end`;
- `tool_execution_rejected`;
- `turn_end`;
- `run_end`.

This is the semantic input currently required by completion evidence and completion repair. `message_start`, `message_update`, `tool_execution_progress`, preparation status, and Run Budget display are never sent to Worker Control.

## Event routing matrix

| Source event | Session barrier | Worker Fact | Worker Control | Worker Observation |
| --- | --- | --- | --- | --- |
| preparation started/settled/disposed | no | no | no | yes |
| `run_start` | yes | `run_started` | yes | yes |
| `turn_start` | yes | no | yes | yes |
| `attempt_start` | yes | `attempt_started` | no | yes |
| `message_start` | no | no | no | yes |
| `message_update` | no | no | no | yes |
| `attempt_end` | yes | `attempt_settled` | yes | yes |
| `retry_scheduled` | yes | no | yes | yes |
| `message_end` | yes | no | yes | yes |
| `tool_execution_rejected` | yes | no | yes | yes |
| `tool_execution_start` | yes | `tool_started` | yes | yes |
| `tool_execution_progress` | no | no | no | yes |
| `tool_execution_end` | yes | `tool_settled` | yes | yes |
| `turn_end` | yes | `turn_settled` | yes | yes |
| `run_budget_exhausted` | no | `budget_exhausted` | no | yes |
| `run_end` | yes | `run_settled` | yes | yes |

No default branch may route an unknown event to persistence or Control.

## Work Journal v2 and recovery

- Bump the file envelope to version 2 and replace `worker_event` in the codec's admitted record types.
- Reject a v1 journal with an explicit unsupported-version error. Do not decode, migrate, reinterpret, rename, or silently discard it.
- Keep the existing append-and-sync durability contract for actual Worker Facts. The number and encoded size of journal writes must be independent of token-delta and Tool-progress counts.
- Recovery replays the shared Worker Fact reducer. An unclosed Attempt adds `unclosed_model_attempt`; an unclosed Tool Invocation adds `unclosed_tool_invocation`; active Work remains interrupted and is never replayed automatically.
- Final `item_result` remains authoritative for settled budget values. Worker Facts reconstruct only work that did not reach a durable result.
- Remove imports that allow `WorkerRuntimeEvent` or `AgentEvent` to appear in `WorkJournalRecord`.

## Required verification

### Routing and persistence contracts

- Exhaustively classify every current Agent event and fail compilation when a new variant is not classified.
- Emit at least 10,000 `message_update` events and 10,000 `tool_execution_progress` events; assert zero Session appends, zero Work Journal appends, and zero Worker Control calls attributable to those events.
- Assert that Work Journal record count and byte size are unchanged when only the number or size of deltas/progress events changes.
- Assert no encoded Work Journal line contains message text, delta text, Tool arguments, Tool result content, progress text, arbitrary details, `worker_event`, or `fatal_barrier_failed`.

### Ordering and failure contracts

- A gated `attempt_started` Fact prevents the Model adapter from being called.
- A gated `tool_started` Fact prevents that Tool adapter from being called.
- Worker Control for Run start, Turn end, and Run end begins only after the corresponding Worker Fact is durably appended.
- A failing or stalled Observation consumer and a throwing Observation serializer cannot abort, slow, or alter a Run, Tool Invocation, Work Result, or Work Graph Result.
- A first safe pre-effect barrier failure remains failed after cleanup and produces only one root failure diagnostic.
- Failure while an Attempt or Tool effect window is open produces interrupted work; parallel Tool-start failure accounts for already open sibling Tools.
- Cleanup after a latched failure performs no further append and no Worker Control call.
- A Work Journal failure rejects later submissions and prevents new effects across other active Worker Runtimes; a Session failure does not stop unrelated Worker Runtimes.

### Recovery and parallelism contracts

- Recovery restores counters and exhaustion from Worker Facts and reports unmatched Attempt/Tool identities.
- Two Sessions stream large interleaved delta sequences concurrently while a slow consumer resynchronizes; both Runs settle and journal traffic remains bounded by semantic lifecycle counts.
- Overflow at every Observation hop remains memory-bounded and causes resynchronization rather than a growing promise tail.
- TUI, print/JSON, evaluation, and completion repair continue to receive the event subsets they require after the split.

### Repository verification

- Replace old shallow tests that assert full Agent events were journaled; do not layer new tests on top of the obsolete contract.
- Run the repository's format, typecheck, lint, unit, integration, and relevant end-to-end commands.
- Run `git diff --check` and confirm no compatibility export, decoder, or dead generic event path remains.

## Completion criteria

- Transient Worker Observations cannot reach a fatal persistence interface by type or by runtime control flow.
- No Observation consumer or forwarding queue can backpressure an Agent, Worker Runtime, Model call, Tool Invocation, Session barrier, or Work Journal barrier.
- Work recovery and live accounting share the same bounded Worker Fact reducer.
- Barrier failure classification is stable under cleanup and correct for parallel open effects.
- The v1 generic Worker event journal and all compatibility paths are deleted.
- All four implementation issues are resolved with verification evidence appended to their Comments sections.
