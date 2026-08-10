# Freeze runtime selection per Run

Type: task
Status: resolved
Blocked by: 01

Add Run-bound Model, Credential, Permission, and Prompt preparation so active Runs remain immutable while later Prompt and Follow-up Runs use current Session/global selections.

## Acceptance

- Steering uses the active Run snapshot.
- A queued Follow-up resolves current state immediately before its Run begins.
- Model, Credential, and Permission changes cannot leak into a live Run.
- Preparation failure leaves an unstarted Follow-up recoverable.

## Answer

Implemented immutable per-Run Model, Credential, Permission, and Prompt selection through `RunRuntimeSlot`, `RunPermissionRouter`, Agent preparation hooks, and request-level authentication snapshots. Active Runs remain stable and queued Follow-ups prepare against the latest selections.
