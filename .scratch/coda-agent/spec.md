# `@coda/agent` Initial Design Spec

Status: Milestone 1 implemented

## Objective

Provide Coda's headless, model-driven Agent runtime without terminal, coding-tool, or durable-storage policy.

## Reference strategy

- The mature Pi `Agent + StreamFn` path is the executable behavioral reference.
- The in-progress Pi Harness may contribute design ideas, not an inherited public API.
- Unimplemented Harness actions do not enter Coda merely because Pi intends to migrate toward them.

## First runtime boundary

- in-memory transcript
- injected model/stream seam
- injected Tool execution
- immutable Agent events
- stable Message identity
- cancellation
- steering and follow-up queues
- optional immutable per-Run execution budgets
- explicit capabilities and future persistence seams
- no reliance on in-memory object identity for restore or replay semantics
- ownership of whole-assistant-call retry, because only the Agent can reason about transcript state, Tool idempotency, and cancellation

## Identity and immutable events

- `RunId`, `TurnId`, `MessageId`, `ToolInvocationId`, and `QueueItemId` are opaque identifiers.
- An injected `IdGenerator` allocates identities before their operations begin.
- Provider `toolCallId` remains separate from Coda's `ToolInvocationId`.
- Every Run event carries a monotonic `sequence`.
- Update events carry immutable deltas and never expose a Message still being assembled internally.
- `message_end` carries the complete immutable Message snapshot.

## Run lifecycle

The event order is:

```text
run_start
→ turn_start
→ message_start | message_update | message_end
→ tool_execution_*
→ turn_end
→ run_end
```

- The internal reducer applies an event before listeners observe it.
- Listeners are awaited sequentially in registration order.
- A listener failure is an infrastructure failure for the current Run. Remaining listeners are still notified best-effort, but no later model or Tool side effect begins.
- Listener dispatch and state cleanup are protected by `finally`; even a `run_end` listener failure leaves the Agent idle and rejects `prompt()` with `AgentError("listener_failed")`.
- `run_end` means the Run will emit no further events.
- `prompt()` and `waitForIdle()` resolve only after `run_end` listeners finish and Agent state becomes idle.

## Run budgets

- A caller may inject one immutable `RunBudget`; the package default remains unbounded.
- Positive limits independently bound Turns, Model Attempts, Tool Invocations, elapsed wall time, total tokens, optional recorded USD cost, and consecutive equivalent Tool batches.
- Accounting includes discarded retry Attempts. A Tool batch that would exceed its Invocation or repetition limit is rejected in full before policy checks or side effects begin.
- Exhaustion emits `run_budget_exhausted`, settles the current Turn and Run as a budget failure, clears unconsumed Steering, pauses later Follow-ups, and leaves every later Follow-up with fresh accounting.

## Tool scheduling

- Tools default to sequential execution and must explicitly declare parallel safety.
- Lookup, schema validation, and policy preflight run in model-source order.
- `tool_execution_start` means `execute()` is actually about to run; missing, invalid, and policy-blocked calls instead produce an explicit rejected Tool result.
- Parallel completion events may arrive in completion order, while Tool result Messages enter the transcript in model-source order.
- Abort prevents new Tool execution, signals running Tools, and waits for them to settle without claiming rollback of external side effects.
- A Tool declares replay safety as `never` or `safe`.
- Each accepted Tool Invocation receives its result `MessageId` before execution.
- Expected lookup, validation, and policy rejection use explicit tagged results; unexpected runtime faults throw.

## Input queues

- Steering enters the current Run at the next safe model-call boundary and never interrupts an active Tool batch.
- All Steering already queued at a safe boundary is injected together.
- Follow-up items start new Runs after the current Run settles and are consumed FIFO one at a time.
- Both queue types use stable IDs and support explicit cancellation.
- Aborting a Run clears its unconsumed Steering but preserves Follow-up items.
- Interrupting an active Tool requires abort followed by a new Follow-up; Steering is not an implicit interrupt.

## State reduction

- Agent state is advanced by a pure reducer over immutable events.
- Tests can reconstruct the same state from a valid event sequence.
- Runtime orchestration owns effects, while the reducer owns state transitions and invariant checks.
- The reducer and event dispatch mechanism are internal seams, not public exports.
- Restore accepts only a validated immutable Agent Seed.
- The public Interface exposes an immutable state snapshot but cannot accept caller-forged events.

## Whole-turn retry

- `@coda/agent` accepts an injected `TurnRetryPolicy`; the package default is disabled.
- `@coda/coding-agent` enables at most three retries by default with 2s, 4s, and 8s delays.
- Only transient provider or network failures are retryable.
- Auth, quota/billing, validation, context overflow, and caller abort are not retried.
- A failed assistant response may be retried only before any Tool from that response begins execution.
- Every Attempt has a distinct identity inside the same Turn and emits retry reason and delay events.

### Attempt events

```text
turn_start
→ attempt_start
→ message_start | message_update
→ attempt_end(success | error | aborted)
→ retry_scheduled
→ next attempt_start ...
→ successful message_end
→ Tool events
→ turn_end
```

- Every Attempt has its own `AttemptId` and candidate assistant `MessageId`.
- Failed partial output is observable but marked discarded and never enters the transcript.
- JSONL event output retains Attempt partial events and outcomes; Session persistence retains Attempt boundaries and retry schedule but not deltas.
- Only a successful Attempt produces a committed assistant Message.

## Agent Seed

```ts
interface AgentSeed {
  version: 1;
  messages: readonly AgentMessage[];
  pendingFollowUps: readonly FollowUp[];
}
```

The Seed contains no Model, Credential, active operation, Steering, pending Tool, or persistence detail. Session recovery resolves interrupted Tools and Message/ToolResult relationships before creating it, and the Agent validates it again.

## Deferred

- `SessionRepository` implementation
- durable operations
- session restore
- compaction
- filesystem and shell capabilities
- coding Tools

Filesystem, Shell, and coding Tools belong to `@coda/coding-agent`. Deferred persistence concepts must not force incomplete behavior into the first Agent API.

## Public control errors

Public control-plane failures use `AgentError` with one of these stable codes:

```text
busy
invalid_input
invalid_seed
invalid_lifecycle
queue_item_not_found
queue_item_not_cancellable
listener_failed
```

Model terminal errors, expected Tool rejection, and normal abort remain Run or Tool outcomes rather than control-plane exceptions.

## Design status

The first-milestone design frontier is closed and implemented in `packages/agent`.

## Milestone 1 result

- `@coda/agent` is a private, ESM-only workspace package whose only Coda dependency is `@coda/ai`.
- The root runtime surface is limited to `Agent` and `AgentError`; all identities, events, Tool capabilities, retry seams, Seed types, and state snapshots are type exports.
- The runtime implements in-memory Runs and Turns, immutable streaming events, stable identities, cancellation, ordered listener dispatch, Tool preflight/execution, Steering, Follow-up, validated idle Seeds, opt-in transient whole-turn retry, and opt-in bounded Run execution.
- Tool execution is sequential unless consecutive Tools explicitly declare `parallelSafe`. Completion events retain completion order while the reducer commits Tool Results in model-source order.
- Listener failures prevent later model or Tool effects, cancel and await already-running parallel Tools, complete Tool Result relationships best-effort, emit final lifecycle events, restore idle state, and reject through `AgentError("listener_failed")`.
- The package does not expose reducer/dispatch internals and does not implement sessions, durable operations, compaction, filesystem, shell, coding Tools, terminal behavior, credentials, settings, or Model selection.
- The implementation is Coda-defined. It uses the frozen Pi Agent as behavioral research and does not claim Pi drop-in compatibility.
