# Project parent Timeline from CodingAgent Observation

Status: resolved

## Objective

Route every Observation for the parent Session's active Work Graph to that
Session's `SessionWorkController`, and project Timeline / Transcript / Activity
from `CodingAgentObservation` instead of a root-only `AgentEvent` filter.

## Scope

- `packages/coding-agent/src/runtime/workspace-work-coordinator.ts` observation
  pump: stop dispatching only by child `sessionId`.
- `SessionWorkController`: accept Graph-scoped Observations; keep root Run
  state for the parent Session; retain child Work Item projections without
  treating child events as the parent Run.
- Slow consumers stay on existing `resync_required`. Projection failure must
  not become a Work Graph barrier.
- Public observer seam used by Interactive Input Adapter and Chat.

## Acceptance

- Parallel sibling `work_item_event` / `item_state_changed` / `work_item_settled`
  Observations reach the parent Session controller.
- Child `AgentEvent`s are not accepted as the parent Session's Run events.
- A throwing or slow parent observer yields `resync_required` and does not
  delay Run or Graph settlement.
- After resync, parent projection matches the Coding Agent snapshot for child
  state, Publication, and Work Result.

## Comments

- `WorkspaceWorkCoordinator` routes Graph Observations to the Graph owner's `SessionWorkController`, not the child `sessionId`. Root `work_item_event`s still go through `acceptWorkerEvent`; child events reach `acceptObservation` only and are never replayed as the parent Run.
- `SessionWorkController` tracks child Work Items, exposes `cancelItem`, and swallows throwing `acceptObservation` so projection is not a Graph barrier. Slow consumers stay on `resync_required`.
- Child MCP Elicitation falls back to the parent Session handler via `parentSessionByChild`.
- Verification: `npx vitest run test/delegated-work-observation.test.ts` in `packages/coding-agent` (parent delivery, parallel siblings, cancel one child, throwing consumer does not block the Graph).
