# Make Plugin Run snapshots and hot refresh coherent

Type: bug
Status: resolved
Priority: P0

Eliminate split Skill/MCP refresh behavior. Derive every Plugin contribution
for one Prepared Run from one versioned Plugin Inventory and retire superseded
MCP resources only after their Run Capability Leases release them.

## Dependencies

- Issues 01 through 03 define installation identity, enablement, and names.

## Acceptance

- One serialized refresh resolves installed revisions, package snapshots,
  selection, enablement, namespaces, and diagnostics into one immutable Plugin
  Inventory revision.
- Run preparation derives Plugin Skill and MCP contributions from that same
  revision and retains both through one Run Capability Lease.
- Install, upgrade, disable, invalidation, and removal during an active Run do
  not mutate it. The next Run observes the complete new state, never a mixture.
- Creation of a Plugin root that did not exist at process start is observed.
  Updates and removals refresh both Skill and MCP views without a required
  process restart or manual MCP-only repair step.
- New Runs cannot invoke superseded or removed MCP Tools. Existing leases may
  finish, after which connections/processes dispose exactly once.
- A manually corrupted selected revision fails closed for later Runs with an
  actionable diagnostic; stale capabilities are not retained as last-known-good
  state outside an atomic installer rollback.
- Deterministic tests cover watcher races, overlapping refresh requests, install
  during Run, update during MCP call, remove during Run, initially absent roots,
  process disposal, and process restart.
- A live network sequence performs install, Run, upgrade during an active Run,
  next Run, and remove; Inventory revisions, names, MCP results, and process
  retirement evidence are appended under `## Comments` before resolution.

## Ownership

Keep the Plugin Inventory manager in the Coding Agent application layer and
reuse the existing Run Capability Lease. Do not introduce a generic Plugin
runtime or let filesystem watchers mutate executable Run state directly.

## Comments

- 2026-08-19 offline evidence: `project-runtime.test.ts` exercises one
  serialized Plugin/Skill/MCP publication, failed-refresh rollback, watched
  package change, overlapping reload ordering, in-process disable/re-enable,
  active-Run removal, Tool-catalog refresh, and exact-once MCP process
  retirement after the final lease. `inventory.test.ts` serializes overlapping
  discovery refreshes, while `project-capability-bundle.test.ts` and Skill Run
  assertions bind the coherent Project, Skill candidate, and MCP revisions used
  by each Prepared Run.
- 2026-08-19 current live-harness evidence encodes a real MCP call held open
  while the installed official package is upgraded. The active Run must finish
  with its old Skill body and MCP lease, its connection must close once after
  release, and the next Run must see only the upgraded Skill/MCP projection.
  This scenario is checked in but its final timed network rerun has not yet
  been appended.
- 2026-08-20 final evidence: during the live upgrade, the already Prepared Run
  retained its old Skill body and real MCP lease, completed successfully, and
  closed that old connection exactly once on release. The next Run observed
  only the upgraded Skill/MCP revision. The complete offline suite also passed
  watcher creation/update/retarget/removal, serialized publication, rollback,
  cross-process durable leases, and post-publication retirement contracts.
  Exact commands and worktree identity are in
  [`../conformance.md`](../conformance.md).
