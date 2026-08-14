# `@coda/runtime`

Durable, headless Work Graph orchestration for Coda. `openCodingAgent()` exposes
the closed `submit`, `observe`, and `close` Work Graph operations, while
`createRunCapabilityHost()` deterministically binds trusted executable
contributions to one disposable Run lease.

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

For a new Graph, its initial fact segment is flushed before the Workspace Ledger
indexes it; that index update is the acceptance linearization point. Existing
Graph commands append only to that Graph, with Workspace-global Publication
ordinals reserved first when new Items are added. Reservations may reject before
these boundaries; later cancellation or projection bookkeeping cannot change an
accepted receipt back to `rejected`. Input resources settle before Worker
visibility, and uncertain settlement is never replayed automatically.
Publication order is enforced per target by the injected Workspace Execution
Adapter across independent Work Graphs. Placement and successful Publication
records carry the durable target identity used during recovery; a changed or
uncertain target interrupts pending Work instead of silently rebasing it.
