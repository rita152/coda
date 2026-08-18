# `@coda/runtime`

Durable, headless Work Graph orchestration for Coda. `openCodingAgent()` exposes
the closed `submit`, `observe`, and `close` Work Graph operations, while
`createRunCapabilityHost()` deterministically binds trusted executable
contributions to one disposable Run lease. `@coda/runtime/headless` composes an
in-memory Coding Agent for evaluation (`createHeadlessCodingAgent`,
`waitForGraph`). `@coda/runtime/workspace-persistence` exports the Workspace
Ledger and Work Graph Store codec and persistence ports.

Each Work Item privately owns one serial Worker Runtime, one exclusively leased
Session, and one Workspace Placement. The Module coordinates deterministic DAG
scheduling, bounded concurrency, cancellation, durable recovery, structured Work
Results, nested delegation, and Publication without exposing Agent instances,
input queues, or Context Window controllers. Each Prepared Run owns its bound
Model driver, Tools, Prompt fragments, and contributor revisions until its lease
is disposed.

Session and per-Graph store writes are ordered fatal barriers. Presentation,
JSON, evaluation, telemetry, and Extension consumers are isolated observations
that cannot block a Run or graph settlement. A causal completion repair is
classified separately as ordered Worker Control and can only feed Steering back
through the Work Item command path.

Child Work Item Lifecycle Hook timing belongs to Worker lifecycle:
`SubagentStart` after a child's `run_started` Fact makes `running` durable, and
`SubagentStop` after that child reaches a terminal Work Result. Command
discovery, exact-handler trust, matcher, stdin JSON, timeout, and process
execution stay on the Coding Agent adapter. `PermissionRequest` remains outside
the event algebra.

For a new Graph, its initial fact segment is flushed before the Workspace Ledger
indexes it; that index update is the acceptance linearization point. Existing
Graph commands append only to that Graph, with Workspace-global Publication
ordinals reserved first when new Items are added. Reservations may reject before
these boundaries; later cancellation or projection bookkeeping cannot change an
accepted receipt back to `rejected`. Input resources settle before Worker
visibility, and uncertain settlement is never replayed automatically.
Publication order is enforced per target by the injected Workspace Execution
Adapter across independent Work Graphs in one process epoch. File persistence
atomically reserves Workspace-global ordinals and merges Ledger mutations across
concurrent epochs while keeping each live Graph owned by its creating epoch.
Placement and successful Publication records carry durable target identities;
cross-epoch target changes are adopted inside a short target transaction, and
artifact applicability determines whether Publication succeeds or reports a
conflict.
