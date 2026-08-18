# Support SubagentStart and SubagentStop

Status: resolved
Blocked by: 01

## Objective

Make `SubagentStart` / `SubagentStop` runtime-supported Lifecycle Hooks at
child Work Item `running` and terminal boundaries. Keep `PermissionRequest`
deferred. Record the hook-algebra change in a new ADR.

## Scope

- `packages/runtime/src/lifecycle-hooks.ts`: add the two methods to
  `LifecycleHookHost` and `LIFECYCLE_HOOK_EVENTS`.
- Worker lifecycle: fire Start when a child enters `running`; fire Stop when it
  reaches a terminal state. Timing in Runtime, execution in coding-agent
  adapter.
- `packages/coding-agent/src/hooks/config.ts`: remove those events from
  `DEFERRED_EVENTS`; delete the `SubagentEnd` alias.
- Adapter: Codex command-hook stdin/stdout, matcher on `executionMode`,
  trust, timeout, async limits unchanged.
- New ADR superseding ADR-0053's "SubagentStart/Stop remain outside" clause
  without rewriting that ADR's body.
- Capability contract: Subagent hooks move onto the supported lifecycle-hooks
  capability; `PermissionRequest` stays a separate deferred capability. Run
  `npm run capabilities:update` and review the generated diff.

## Acceptance

- Trusted SubagentStart handlers run when a child Work Item enters `running`.
- Trusted SubagentStop handlers run at that child's terminal state.
- `PermissionRequest` still produces `hooks.event-deferred`.
- `SubagentEnd` is not a recognized event name.
- `capabilities:check` passes after the contract split.

## Comments

- Runtime `LifecycleHookHost` now includes `subagentStart` / `subagentStop`. Worker lifecycle fires Start after a child `run_started` makes `running` durable, and Stop from `noteChildTerminal` at a child terminal Work Result. Hook errors are diagnosed and do not fail the Graph.
- Coding-agent adapter: `DEFERRED_EVENTS` is only `PermissionRequest`. `SubagentEnd` is an unknown event, not a deferred alias. Matcher is `executionMode`; stdin follows the Codex command-hook JSON. `additionalContext` queues on the child Session.
- New [`ADR-0059`](../../../docs/adr/0059-runtime-subagent-lifecycle-hooks.md) supersedes ADR-0053's "SubagentStart/Stop remain outside" sentence without rewriting that ADR's body.
- Capability split: `coding-agent.lifecycle-hooks` is runtime-supported for SubagentStart/Stop; `coding-agent.deferred-permission-request-hook` stays deferred.
- Verification: `npx vitest run test/subagent-lifecycle-hooks.test.ts test/public-contract.test.ts test/work-graph.test.ts` in `packages/runtime`; `npx vitest run test/hooks.test.ts test/hooks-application.test.ts` in `packages/coding-agent`; `npm run capabilities:check` passed.
