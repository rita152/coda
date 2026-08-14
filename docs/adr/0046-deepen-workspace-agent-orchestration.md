---
status: accepted
---

# Isolate Work Graph state and lease executable Run capabilities

Coda replaces the Workspace-wide Work Journal with one small Workspace Ledger and an independent Work Graph Store for every active Graph. Only identities and ordering that are genuinely Workspace-global enter the Ledger; Graph lifecycle Facts and fsync remain Graph-local, terminal stores are archived, and a failed Graph store interrupts only its Graph while a failed Ledger fail-stops the Workspace. This trades a single simple append tail for bounded recovery cost, failure containment, and parallel Graph progress.

`WorkGraphFact` is one closed, versioned semantic algebra and `WorkGraphAggregate.apply` is the authoritative interpretation for both live execution and replay. Durable acceptance, input settlement, Worker Facts, lifecycle transitions, cancellation, Publication, ownership release, recovery interruption, and terminal Results are all Facts; opaque lifecycle payloads and a second recovery reducer are rejected. The Coordinator may retain process-local handles and scheduling projections, but they cannot define durable state independently of the Aggregate.

Every Prepared Run acquires one immutable Run Capability Lease containing its bound Model driver, deterministic Tool and prompt contributions, exact Skill and MCP revisions, and idempotent disposal. A catalog reload publishes a generation only for future acquisitions; active Runs retain and dispose the executable resources they acquired. Coda deliberately uses this narrow trusted-contributor Seam instead of a generic dependency-injection or plugin container.

Scheduling is bounded-fair across Work Graphs and deterministic within each Graph under one explicit capacity policy. Planning and resource reservation may overlap, durable acceptance keeps one atomic linearization point, and slow input-resource commit gates only its affected deliveries outside the Workspace-global mutation fence. Graph-local settlement and persistence do not occupy that fence.

This decision supersedes ADR-0044's shared Work Journal, Coordinator-wide journal failure, graph-order scanning, and global terminal mutation-fence clauses, while preserving its serial Agent, exclusive Session ownership, Workspace Placement, Publication ordering, and public command/observation boundary. It also supersedes ADR-0045's references to a fatal global Work Journal barrier: Worker Facts remain bounded and distinct from Observations and Control, but they are now nested in Graph-local Work Graph Facts.
