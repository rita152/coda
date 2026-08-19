# Add explicit Interrupted Tool re-execution

Status: resolved

Interactive recovery currently supports cancel or a durable `skipped` Tool
result, after which the user may request a new invocation. Design a direct
`re-execute` choice without exposing the Agent reducer or adding the unfinished
Harness action API to Coda's public contract.

Constraints:

- never replay automatically;
- `replay: never` remains skip-only;
- re-run lookup, schema validation, execution, and cancellation;
- allocate a new Tool Invocation identity while preserving the Provider Tool
  Call relationship required by the transcript;
- journal the new start before side effects and finish immediately after
  settlement;
- keep restored Agent Seeds idle and fully resolved.

## Seam

### When execution happens

Re-execute runs **during** `SessionRecovery.recover()`, while the journal
appender is open and **before** `ManagedSession` builds the Agent Seed.
Recovery after that point always yields an idle Seed: every Interrupted Tool
window is closed, and the transcript has exactly one Tool Result for the
Provider Tool Call.

Execution cannot wait until after Seed construction. `validateAgentSeed`
rejects unresolved Tool Calls, and ADR-0026 restores only idle Seeds. Starting
a Run to re-execute would expose the Agent executor and would not be idle.

Closing the old invocation with Skip and later starting a new Run is the
existing “request a new invocation” path, not this choice.

### Who owns `execute`

`@coda/agent` publishes `settleToolInvocation`. It is the same lookup → schema
validation → `execute` → cancel path the Agent uses for a live Tool
Invocation. It does not emit Agent events, does not start a Run, and does not
export the reducer.

Call chain:

1. Interactive `InterruptedToolRecovery` returns `"cancel" | "skip" | "re-execute"`.
2. `SessionRecovery` refuses `"re-execute"` unless journaled `replaySafety` is
   `"safe"` (missing/`"never"` stay Cancel or Skip).
3. `SessionRecovery` allocates a new Tool Invocation `id` and `resultMessageId`,
   copies `providerToolCallId`, `toolName`, `arguments`, and `sourceIndex`.
4. Journal `tool_finished` on the **old** invocation (`outcome: "interrupted"`,
   `reason: "reexecuted_by_user"`) so `startedTools` cannot contain two windows.
5. `settleToolInvocation({ beforeExecute })` looks up and validates. On
   accepted lookup, `beforeExecute` appends the **new** `tool_started` (ADR-0025)
   and only then calls `execute()`. Settlement is journaled immediately as
   `tool_finished` plus a `message_committed` Tool Result.
6. Existing `run_finished` interrupted recovery still runs after every Tool
   window is closed.

`@coda/coding-agent` does not copy `#executeSingleTool`. FileSessionManager
injects a `recoveryTools` catalog used only on `"re-execute"`. That catalog is
the built-in `replaySafety: "safe"` host Tools that can be constructed without
a Prepared Run (`read`, `read_tool_output`, `grep`, `find`, `ls`). `skill` and
`read_session_history` are absent until a Prepared Run exists; lookup then
settles as `missing` through the same port. `edit` / `write` / `bash` /
`process` / MCP stay `"never"` and are not offered.

This is not a Run: Command Permission and Lifecycle Hooks stay on the Worker
Runtime path. Recovery is not automatic replay.

### UI and return type

`InterruptedToolRecovery` becomes `Promise<"cancel" | "skip" | "re-execute">`.

`interruptedToolRecoveryChoices(replaySafety)` returns Cancel and Skip always,
and Re-execute only when `replaySafety === "safe"`. The handler must not
invent `"re-execute"` for `"never"`; `SessionRecovery` rejects that even if a
caller does.

Print mode and a missing handler still fail closed.

### Test seams

- `@coda/agent` `settleToolInvocation` (lookup, validation, execute, abort).
  Do not test Agent private methods.
- `SessionRecovery.recover` decision type, journal start/finish pair, new
  identity, preserved `providerToolCallId`, idle Seed, `"never"` refusal,
  print fail-closed, existing skip/cancel.
- `interruptedToolRecoveryChoices` for the interactive third option.
- `FileSessionManager.open` integration for a safe Tool re-execute.

## Comments

The deep seam needs architectural review before implementation; duplicating the
Agent's private Tool executor in the Coding Agent is not acceptable.

### 2026-08-19 — seam selected

Execution happens during recovery, before the idle Agent Seed is built. The
Agent public port is `settleToolInvocation`; Coding Agent journals ADR-0025
order and supplies a recovery Tool catalog. `"re-execute"` is interactive and
`"safe"` only.

### 2026-08-19 — implemented

Interactive resume offers re-execute for `replaySafety: "safe"`. New Tool
Invocation identity, preserved `providerToolCallId`, journal-before-execute,
idle Seed after recovery. Verified by `packages/agent/test/tool-settlement.test.ts`,
`packages/coding-agent/test/session-recovery.test.ts`, and
`packages/coding-agent/test/session-file.test.ts`. ADR-0061 records the decision.

