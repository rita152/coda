# Show child Work Items under parent delegate

Status: resolved
Blocked by: 01

## Objective

Present each child Work Item under the in-progress parent `delegate` on
Timeline and Transcript, and make Activity say the parent is waiting on N
children.

## Scope

- `packages/coding-agent/src/ui/semantic-timeline.ts` and transcript rendering.
- Activity projection / Chat Activity row.
- `/session` must keep listing only user Sessions (Worker-private children stay
  off the picker). Do not add a DAG view.

## Acceptance

- Under one running `delegate`, two write siblings show objective,
  executionMode, and live state together.
- Current Tool is visible while a child is running.
- Terminal summary shows Work Result state, Publication, and diagnostics — not
  assistant prose as success.
- Transcript can expand child Tool details.
- Activity text distinguishes "delegate waiting for N children" from a lone
  spinning parent Tool.
- Child Sessions do not appear as `/session` peers.

## Comments

- `SemanticTimeline.acceptObservation` / `resynchronizeObservation` project each child under the in-progress parent `delegate`: objective, executionMode, state, current Tool, and terminal Work Result (state, Publication, diagnostics). Assistant prose is not treated as success.
- Transcript rendering expands `child.tools`. Activity says `Waiting for N child Work Item(s)` and ignores the graph-root Work Item (`root` / snapshot `rootItemId`).
- `/session` still lists only persistent user Sessions. Worker-private children stay `persistent: false`.
- Verification: `npx vitest run test/delegated-work-timeline.test.ts test/session-manager-router.test.ts test/interactive-mode.test.ts` in `packages/coding-agent`.
