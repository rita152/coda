# `@coda/runtime`

Durable, headless Work Graph orchestration for Coda. The public Interface is one
`openCodingAgent()` construction function plus serializable Work Graph data and
the closed `submit`, `observe`, and `close` operations.

Each Work Item privately owns one serial Worker Runtime, one exclusively leased
Session, and one Workspace Placement. The Module coordinates deterministic DAG
scheduling, bounded concurrency, cancellation, durable recovery, structured Work
Results, nested delegation, and Publication without exposing Agent instances,
input queues, Prepared Run capabilities, or Context Window controllers.

Session and Work Journal writes are ordered fatal barriers. Presentation,
JSON, evaluation, telemetry, and Extension consumers are isolated observations
that cannot block a Run or graph settlement. A causal completion repair is
classified separately as ordered Worker Control and can only feed Steering back
through the Work Item command path.

The durable `batch_accepted` Journal record is the acceptance linearization
point. Reservations may reject before it; once it is written, later cancellation
or projection bookkeeping cannot change the receipt back to `rejected`. A short
Coordinator mutation fence revalidates live state and records accepted mailbox
changes at that point. Input resources commit only after the durable record and
before Worker visibility; uncertain settlement interrupts Work and is never
replayed automatically. Publication order is immutable at acceptance and is
enforced per target by the injected Workspace Execution Adapter, including
across independent Work Graphs. Placement and successful Publication records
also carry the durable target identity used during recovery; a changed or
uncertain target interrupts pending Work instead of silently rebasing it.
