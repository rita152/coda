# Bubble child approval and cancel through Worker Control

Status: resolved
Blocked by: 01

## Objective

Let the focused parent Session answer child Command Permission asks and MCP
Elicitations, and cancel one child or the whole Graph, without a second
approval stack.

## Scope

- Workspace elicitation map: child Session without a handler must use the
  focused parent Session handler instead of declining.
- Command Permission ask for a child Worker must use the existing interactive
  adapter bound to the parent TUI (`/permissions` overlay).
- `SessionWorkController` cancel stays Graph-wide; add item-targeted
  `cancel_work` for one child.
- Copy and UI must not claim Tool / Publication rollback.

## Acceptance

- A child dangerous-command ask appears on the parent Composer / approval UI
  and can be allowed or denied there.
- A child MCP Elicitation is answered on the focused parent Session.
- Canceling one child leaves siblings running unless they depend on it.
- Canceling the Graph cancels remaining children.
- Deny / cancel do not assert that already-applied side effects were rolled
  back.

## Comments

- Child Command Permission ask uses the process-wide `PermissionLifecycleHookHost` and the parent TUI ask port. Asks queue instead of deny-if-pending; `onWait` drives the focused parent Activity override.
- Child MCP Elicitation uses the parent Session handler when the child Session has none.
- `/cancel-work` cancels one child (`cancel_work` item target) or the Graph. Copy: does not roll back Tool or Publication side effects that already happened.
- Verification: `npx vitest run test/delegated-work-approval.test.ts test/cancel-work-flow.test.ts test/command-permission.test.ts` in `packages/coding-agent`.
