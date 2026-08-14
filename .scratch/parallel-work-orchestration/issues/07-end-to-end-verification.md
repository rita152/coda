# Verify coordinated parallel coding work end to end

Status: resolved
Blocked by: 06

Implement every contract test listed in `../spec.md`, add a real temporary-Git integration scenario with parallel delegated writers and deterministic Publication, run the complete repository verification suite, inspect the final dependency graph and public exports, and resolve all remaining architectural escape hatches.

## Comments

- Added the complete public Work Graph contract matrix: root Prompt ownership, deterministic randomized DAG completion, graph/process concurrency budgets, nested delegation, atomic rejection and reservation rollback, exclusive Session/Runtime ownership, later-Run configuration, cancellation in every required phase, dependent blocking, data-only snapshots, fatal barrier classification, isolated observer failure/stall behavior, ordered Worker Control, recovery, idempotent close, and dropped-input accounting.
- Added Direct and Git Workspace execution coverage for read overlap, global write/unknown serialization, shared mutation coordination, retained/reentrant Process leases, cancellation quiescence, parent/delegate deadlock freedom, sibling isolation, nested Publication, conflicts, changed-source detection, and recoverable artifact preservation.
- Added a real temporary-Git end-to-end Work Graph: a bound root `delegate` creates two sibling writers in distinct worktrees, both execute concurrently, the later child completes first, Publication still occurs in accepted `alpha`, `beta`, `root` order, all Runtime/Session identities are unique, and the source Workspace receives both files.
- Post-review coverage adds accepted-barrier failure consistency, production child-Session recovery, Runtime-owned input resources, concurrent durable Journal append ordering, public-observer failure/stall isolation at the application Adapter, and automatic Git-vs-Direct production composition.
- Final review coverage adds rejected-barrier resource rollback without commit, accepted resource-commit interruption and crash recovery, live-state revalidation under delayed reservation, single-owner graph settlement, durable root Session lazy loading, and reversed-completion Publication across independent Work Graphs.
- Split journaled causal completion repair into ordered, failure-isolated Worker Control while keeping presentation/JSON/eval observers outside Run and Work Journal barriers. Observer failure detaches with a diagnostic; a permanently stalled observer cannot block graph settlement or `close()`.
- Removed the remaining executable prompt-construction escape hatch: callers may inject only a data-only `SystemPromptSnapshot`; Tool catalogs and Prepared Run capabilities never leave the private Worker. Removed unused Worker descriptor/in-memory compatibility types and stale generated legacy Runtime files.
- Final architecture audit: the `@coda/runtime` root has exactly one value export, `openCodingAgent`; no command target contains a Runtime identity; no application/eval caller constructs Agent, Worker Runtime, input queue, Prepared Run, or Context Window capability; one Workspace coordinator owns the mutation coordinator; dependency direction is headless; old Runtime names remain only in negative tests, the superseding ADR/spec, and historical ADR-0043.
- Final verification passed: `git diff --check`; `npm run check`; `npm test` (156 Vitest files / 908 tests plus 7 Pier tests); `npm run pack:dry-run`; and a final `@coda/runtime` dry-run package audit with no legacy Runtime files. No commit or PR was created.
