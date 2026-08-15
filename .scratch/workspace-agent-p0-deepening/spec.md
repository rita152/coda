# Workspace Agent P0 Deepening

Status: implemented

The durable outcome is recorded in
[`ADR-0046`](../../docs/adr/0046-deepen-workspace-agent-orchestration.md) and the
[`@coda/runtime` README](../../packages/runtime/README.md). Implementation and
verification completed on 2026-08-14. The design below is retained as
implementation history.

## Goal

Remove the four P0 architecture failures that prevent Coda from becoming a long-lived, multi-Session, pluggable coding agent:

1. replace the Workspace-wide monolithic Work Journal with isolated Work Graph persistence plus a small Workspace ledger;
2. make one closed Work Graph fact algebra and reducer authoritative for both live execution and recovery;
3. make every Prepared Run own executable Model, Tool, Skill, and MCP capability leases whose lifetime survives catalog reload;
4. make scheduling fair across Work Graphs and keep slow admission/resource work outside global mutation serialization.

This is a destructive refactor. There is no source, type, journal-schema, or on-disk compatibility requirement. Delete replaced code rather than layering adapters over obsolete interfaces.

## Preserved invariants

- `@coda/agent` remains a serial kernel.
- One Work Item owns one private Worker Runtime and one exclusive Session lease.
- Worker Fact, Worker Observation, and Worker Control remain separate closed algebras.
- `CodingAgent` keeps the operational `submit / observe / close` Interface unless a smaller equivalent is proven.
- Direct and Git worktree Workspace Adapters retain their current correctness properties. Worktrees are not security sandboxes.
- No sandbox, approval, privilege, policy-prompt, or untrusted dynamic-extension system is introduced.
- Assistant prose is not a Work Result and completion order does not determine Publication order.

## Design rules

- Prefer a few deep Modules with small Interfaces. Do not add a generic DI container, event bus, repository framework, or universal Plugin Interface.
- Runtime owns domain facts, reducers, schemas, and codecs. Host Adapters own files, locks, processes, and byte I/O.
- Active Runs own leases to executable resources. A reload only changes the next acquired generation.
- Workspace-global serialization is reserved for facts that are truly global: coordinator lease, active Graph index, Session ownership, Publication ordinals, and target identities.
- Graph-local facts and fsync operations must not serialize unrelated Graphs.
- Terminal Graph history is not loaded into the active scheduler or included in default snapshots.
- All close, release, rollback, abort, and dispose operations are idempotent.
- Prefer deletion and replacement over compatibility wrappers.

## Target Modules

### WorkspaceLedger and WorkGraphStore

The production host owns one Workspace lock/epoch and a small durable ledger. The ledger records active Graph identities and the minimum Workspace-global ordering/ownership facts. Each Work Graph has its own durable log. Terminal Graphs are archived and opened only by explicit historical lookup.

One Graph log failure interrupts that Graph. A ledger failure fail-stops the Workspace because global ordering can no longer be proven. A second process that cannot acquire the Workspace lease fails explicitly before accepting Work.

The storage Interface exposes semantic operations rather than filesystem paths. The Node Adapter may use files, but tests use an in-memory Adapter at the same Seam.

### WorkGraphAggregate

`WorkGraphFact` is a versioned, closed discriminated union. `WorkGraphAggregate.apply(fact)` is the only state transition mechanism for accepted Graph/Item definitions, input settlement, lifecycle transitions, Worker Facts, cancellation, Publication, ownership release, interruption, and terminal results.

The reducer is pure and shared by live execution and replay. All decoded facts are fully schema-validated before application. Mutable runtime handles and Promises stay outside durable aggregate state.

### RunCapabilityLease

`RunCapabilityHost.acquire(context)` returns one immutable `RunCapabilityLease`. The lease owns a bound Model driver, Tool contributions, deterministic Prompt contributions, revision descriptors, and idempotent disposal. Catalog reload publishes a new generation without closing resources retained by older leases.

Built-in Tools, Skills, and MCP are trusted contributors behind this Seam. The Runtime must not directly know MCP connection or Skill loader implementation types. UI command registration is not part of Worker Run preparation.

### WorkScheduler and admission pipeline

The scheduler is deterministic within a Graph and fair across Graphs. Round-robin or deficit round-robin are acceptable; an older Graph cannot consume every process slot while another Graph remains ready. Graph and process concurrency limits remain enforced.

Submission planning and ownership reservation may run concurrently. The durable acceptance linearization point remains atomic. Slow input-resource commit happens outside the short global mutation fence and gates only the affected deliveries/Items. Scheduling unrelated accepted Work must continue while another batch performs resource settlement.

## Parallel task ownership

- Task 01 owns Workspace persistence and process locking. It may alter persistence slices of Runtime ports, Coordinator recovery, Node composition, and File Journal code. It must not redesign scheduling or Run capability assembly.
- Task 02 owns the closed fact algebra, codec, pure aggregate, and replay/property tests. It should concentrate durable state in new Modules and avoid unrelated host work. Coordinator integration may be completed during final integration if doing it in-task creates excessive overlap.
- Task 03 owns Run capability leases, Model binding, Skills/MCP generation lifetimes, and Worker Runtime preparation. It must not alter scheduling or Work Graph persistence semantics.
- Task 04 owns fair scheduling and the submission/admission critical section. It must not alter durable fact schemas or Run capability assembly.

Each task works in an isolated worktree, commits its changes, and reports the commit plus tests. Final integration happens in the parent task in this order: aggregate, persistence, capabilities, scheduler. Replaced tests should be deleted and rewritten at the new deep Module Interfaces.

## Required verification

- Live execution state equals replayed state for the same WorkGraphFact sequence.
- Invalid, out-of-order, or malformed facts fail before aggregate mutation.
- Restart cost and active snapshot size are bounded by active Graphs, not terminal history.
- A failure in one Graph log does not interrupt an unrelated Graph.
- Concurrent processes cannot both coordinate the same Workspace.
- An active MCP Run survives MCP reload; the next Run observes the new revision.
- An active Model Run remains bound to the Provider generation it acquired.
- Concurrent Skills refreshes coalesce by dirty generation and do not mutate UI from Worker preparation.
- At least 32 ready Sessions make bounded scheduling progress under a process cap.
- Slow input-resource settlement for one batch does not stop an unrelated ready Graph.
- Existing Session isolation, delegation, cancellation, Worker barrier, Direct Adapter, and Git worktree Publication tests continue to pass.
- Repository checks, builds, and tests pass with no compatibility layer for the replaced architecture.
