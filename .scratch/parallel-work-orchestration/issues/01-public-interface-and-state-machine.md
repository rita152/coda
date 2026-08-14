# Build the Work Graph Interface and state machine

Status: resolved

Implement the closed `submit/observe/close` Coding Agent Interface, Work Graph and Work Item identities, atomic command validation, deterministic DAG scheduling, concurrency budgets, cancellation tree, structured settlements, and data-only snapshots described in `../spec.md`. Start with in-memory Session, journal, and Workspace Execution Adapters and contract tests at the public Seam.

Delete or privatize the old Runtime-facing control types immediately; do not add a compatibility layer.

## Comments

- Added the closed, serializable Work Graph command algebra and the `openCodingAgent()` `submit/observe/close` Interface.
- Implemented atomic identity/Session/resource/placement reservation, deterministic DAG scheduling, graph and process concurrency caps, cancellation cascade, source-order structured results, isolated observations, and slow-consumer resynchronization.
- Post-review: made the durable `batch_accepted` Journal append the explicit acceptance linearization point. Failures in already-accepted cancellation bookkeeping are diagnosed and settled asynchronously but can no longer return a contradictory rejected receipt or roll back accepted ownership.
- Final review: added one Coordinator mutation fence around live revalidation, durable acceptance, mailbox/cancellation mutation, terminal lifecycle boundaries, Publication start, and result settlement. Existing-item commands now have no reserve/journal TOCTOU window, and parallel graph terminal paths share one settlement owner.
- Removed the old Runtime factories, input queue, executable snapshot, and Context Window values from the `@coda/runtime` package Interface; deleted the replaced shallow Runtime tests.
- Contract verification: `@coda/runtime` typecheck, Biome, build, and all 44 tests pass.
