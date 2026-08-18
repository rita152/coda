# Interactive Delegated Work

Status: implemented

Current behavior is recorded by
[`ADR-0059`](../../docs/adr/0059-runtime-subagent-lifecycle-hooks.md),
the [`@coda/coding-agent` README](../../packages/coding-agent/README.md)
Lifecycle Hooks section, and the generated capability manifest
(`coding-agent.lifecycle-hooks`, `coding-agent.deferred-permission-request-hook`,
`coding-agent.terminal`, `runtime.work-graph-orchestration`). Implementation
and verification completed on 2026-08-18. The design below is retained as
implementation history.

Parent: none. This effort sits above the implemented Work Graph / Worker
Observation / Workspace Agent history. Do not edit those historical specs.

## Goal

Make delegated Work Items a first-class experience of the current Coding Agent
Session. When a parent Worker calls `delegate`, the focused parent Session's
Timeline, Transcript View, Activity row, Command Permission, and MCP
Elicitation cover every child Work Item in that Graph. Users can cancel one
child or the whole Graph. SubagentStart / SubagentStop become runtime-supported
Lifecycle Hooks at child running and terminal boundaries.

Do not rebuild the orchestration kernel. Do not draw a DAG. Child Sessions stay
Worker-private and never enter `/session` as peer Sessions.

## Problem

`@coda/runtime` already delegates, opens a private child Session per Work Item,
and publishes through Direct or Git worktree Publication. The interactive TUI
drops that observation:

- `WorkspaceWorkCoordinator` pumps `observe()` by `sessionId` into
  `SessionWorkController`.
- `SessionWorkController.acceptWorkerEvent` keeps only events whose `itemId`
  matches the root.
- `SemanticTimeline.accept()` therefore never sees child Worker Observations.
- Child MCP Elicitation declines when the child Session has no handler.
- Child Command Permission ask fail-closes without an interactive adapter.
- `LifecycleHookHost` has Session / Prompt / Tool / Compact / Stop only.
  `SubagentStart` / `SubagentStop` (and the dead `SubagentEnd` alias) are
  deferred and inert.

## Vocabulary

Use `CONTEXT.md` terms only: Work Graph, Work Item, Worker Observation, Worker
Control, Publication, Timeline, Transcript View, Interactive Input Adapter,
Command Permission, MCP Elicitation, Lifecycle Hook.

A child Work Item is still a Work Item. Do not call it a subagent in product
prose. `SubagentStart` / `SubagentStop` are Codex hook event names only.

## Non-goals

- Interrupted Tool re-execution (`.scratch/interrupted-tool-reexecution`)
- Restoring the deleted patch Tool
- Session rename / delete / archive / branch, cross-Workspace switch, daemon
  Sessions
- Whole Work Graph DAG UI
- Child Sessions as `/session` first-class entries
- Concurrent `@coda/agent`, shared Sessions, or calling a worktree a sandbox
- RPC / SDK / OAuth / Windows / remote Skills
- Rewriting implemented historical spec bodies

## Required architecture

### Observation seam

The parent Session Timeline, Transcript, and Activity project from
`CodingAgentObservation`. They do not replay child `AgentEvent`s as if they
belonged to the parent Run. They do not import Agent reducer or private
executor types.

`SessionWorkController` owns one user Session and one active Work Graph. The
Workspace observation pump delivers every Observation for that Graph — including
`item_state_changed`, `work_item_event`, `work_item_settled`, `diagnostic`,
`snapshot`, and `resync_required` — to the parent controller, not only to a
controller keyed by the child `sessionId`.

Child Worker Observations stay attributed to their Work Item identity. A slow
consumer uses the existing bounded `resync_required` path. Observation
projection failure drops that Observation and emits a bounded diagnostic. It
must not block a Run, Worker Control, or a Work Graph barrier.

After resync, the parent projection rebuilds from the Coding Agent snapshot plus
the parent Session seed. Child tool detail that existed only in discarded
process-local Observations is gone; Work Item state, Publication, and Work
Result remain.

### Timeline and Activity

Under the in-progress parent `delegate` Tool, the parent Timeline projects each
child:

- objective
- executionMode
- state (`pending` / `ready` / `preparing` / `running` / `settling` /
  `succeeded` / `failed` / `canceled` / `interrupted` / `blocked`)
- current Tool while running
- terminal Work Result summary: state, Publication, diagnostics

Assistant prose is not a success criterion.

Transcript View can expand a child's Tool details. Parallel siblings appear
together under the same `delegate`. The Activity row says the parent is waiting
on N child Work Items, not only that the parent Tool is spinning.

`/session` lists only user Sessions. Worker-private child Sessions stay
`persistent: false` and never become switchable peers.

### User control

Worker Control remains the only path that can cancel or submit Steering.

- Cancel one child: `cancel_work` with `target.type: "item"`.
- Cancel the Graph: existing `cancel_work` with `target.type: "graph"`.

Cancel and deny do not claim to roll back Tool or Publication side effects that
already happened.

Child Command Permission ask and child MCP Elicitation surface on the focused
parent Session through the existing `/permissions` overlay and elicitation UI.
Do not add a second approval stack for children. A child without its own handler
must not decline or fail-closed while the parent Session is interactive.

### Subagent Lifecycle Hooks

Add `SubagentStart` and `SubagentStop` to Runtime `LifecycleHookHost` and to
the Worker lifecycle:

- `SubagentStart` when a child Work Item enters `running`.
- `SubagentStop` when that child reaches a terminal state.

Timing belongs to Runtime. Command discovery, trust, matcher, stdin JSON,
timeout, and async limits stay on the coding-agent adapter (ADR-0053, superseded
in part by the new ADR for these two events).

Remove `SubagentStart` and `SubagentStop` from `DEFERRED_EVENTS`. Delete the
dead `SubagentEnd` alias. Do not keep a half-implemented synonym.

`PermissionRequest` stays deferred. Command Permission still hangs on
`PreToolUse`.

Matcher input for both events is the child's `executionMode`
(`read_only` | `write`). Stdin follows the Codex command-hook JSON:

- common fields: `session_id` (parent Session), `transcript_path`, `cwd`,
  `hook_event_name`, `model`
- `agent_id`: child Work Item id
- `agent_type`: `executionMode`
- `SubagentStop` also: `agent_transcript_path`, `stop_hook_active`,
  `last_assistant_message`

`SubagentStart` may contribute `additionalContext` to the child Worker. Its
`continue: false` is parsed and ignored for start (Codex-compatible).
`SubagentStop` uses the existing Stop output algebra (`decision: block`
continuation, `continue: false`). Continuation is Worker Control after the
lifecycle Fact is durable; it is not an Observation barrier.

Write a new ADR that replaces ADR-0053's sentence "SubagentStart and
SubagentStop remain outside until delegated-worker lifecycle exists." Do not
rewrite ADR-0053's body. Landed as
[`ADR-0059`](../../docs/adr/0059-runtime-subagent-lifecycle-hooks.md).

## Seams under test

Confirmed by this spec (TDD skill):

1. `CodingAgent.observe` — parent Graph Observations include child Work Items;
   observation failure and `resync_required` do not block the Graph.
2. Timeline / Activity projection — public `SemanticTimeline` / Activity
   projection from those Observations, including parallel siblings, failure,
   interrupt, and resync consistency.
3. `LifecycleHookHost` — SubagentStart at child `running`, SubagentStop at
   terminal; PermissionRequest remains absent.
4. Interactive approval — child Command Permission ask and MCP Elicitation
   answer on the focused parent Session; cancel child / Graph through Worker
   Control.

Do not test private Agent reducers or private executor internals.

## Acceptance

In an interactive Session, when the model delegates two write children:

1. The parent Timeline shows both children under that `delegate` at once.
2. If one child fails or is interrupted, the parent Timeline shows that
   terminal Work Result summary.
3. The user can cancel the other child, or cancel the Graph.
4. A child's dangerous-command ask and MCP Elicitation appear on the parent
   Composer / approval UI and can be answered there.
5. Configured SubagentStart handlers run when a child enters `running`;
   SubagentStop handlers run at the child's terminal state.
6. Observation projection failure does not interrupt the Graph.
7. After `resync_required`, the rebuilt projection matches the snapshot.
8. Child Sessions do not appear in `/session`.
9. `npm run capabilities:check` passes. Work-graph, hooks, and interactive
   tests that this effort touches pass.

## Durable outcome

- [`ADR-0059`](../../docs/adr/0059-runtime-subagent-lifecycle-hooks.md) for Subagent hook timing.
- Capability: Subagent hooks become `runtime-supported` on
  `coding-agent.lifecycle-hooks`. `PermissionRequest` stays a separate deferred
  capability.
- Tests at the four seams above.
- This spec is `implemented`. Issues 01–04 are `resolved`.
- Tests: `packages/coding-agent/test/delegated-work-observation.test.ts`,
  `delegated-work-timeline.test.ts`, `delegated-work-approval.test.ts`,
  `cancel-work-flow.test.ts`, `session-manager-router.test.ts`,
  `hooks.test.ts`; `packages/runtime/test/subagent-lifecycle-hooks.test.ts`.
