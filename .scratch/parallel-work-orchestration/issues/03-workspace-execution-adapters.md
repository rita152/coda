# Add Direct and Git worktree Workspace Execution Adapters

Status: resolved
Blocked by: 01

Implement the Workspace Execution Seam, Direct read/write leasing, shared Workspace mutation coordination, Session-bound Process leases, Git worktree placement, nested child placement, source-anchored artifacts, deterministic Publication, conflict preservation, and recovery artifacts described in `../spec.md`.

Do not describe worktrees as sandboxing and do not retain a per-Runtime mutation coordinator.

## Comments

- Implemented a FIFO Workspace lease coordinator. Direct placements share the source Workspace, overlap reads, serialize write/unknown effects, and retain Process-start leases until the Session process lifetime settles.
- Added one Workspace-scoped `TargetMutationCoordinator`; tool construction no longer creates a coordinator per Worker Runtime. All static and dynamic tools cross the Workspace binding seam, and `read_only` Workers receive only read-effect tools.
- Implemented Git worktree placement with source-anchored commit artifacts, real sibling isolation, nested child publication into the parent placement, deterministic publication ordering, changed-source/conflict detection, and preservation of unpublished worktrees/refs for recovery.
- Post-review: production Workspace composition now selects the Git worktree Adapter for Git Workspaces, falls back to Direct outside Git, and exposes one construction-time factory for replacing that policy. A full Session/Coordinator integration test proves nested Git Publication reaches the source Workspace.
- Final review: every Placement carries a persisted Workspace-wide Publication ordinal. The Git Adapter owns one sequencer per Publication target, so fingerprint/check/apply is deterministic across independent Graph roots as well as siblings while unrelated parent targets remain parallel.
- Recovery review: Placement and successful Publication records persist the target's full content identity. Target-local mutation gates cover reserve and publish, external changes cannot be adopted by later reservations, and restart recovery uses the latest durable identity rather than the Adapter's process-start snapshot.
- Verified `@coda/runtime` typecheck, 12 Work Graph contract tests, 7 durable journal/Direct/Git Adapter tests, and scoped Biome checks. Remaining coding-agent type errors are exclusively the deleted legacy Runtime public-surface callers assigned to issues 04/06.
