# Add the durable Work Journal and recovery model

Status: resolved
Blocked by: 01

Define the Work Journal Interface, versioned file and in-memory Adapters, ordered transition barriers, graph restoration, interruption classification, and never-auto-replay behavior from `../spec.md`. Persist graph/item definitions, ownership, causality, evidence, artifacts, Publication, cancellation, and cleanup facts.

## Comments

- Post-review: production recovery now recreates the necessarily empty private Session of pending/ready child Work Items from journaled ownership. Durable file-journal encoding is owned by one Adapter and concurrent appends are serialized and crash-tail tested.
- Final review: the production Session Adapter now lazily reopens missing durable root Sessions through the Workspace SessionManager with single-flight loading and exactly-once ownership release. Input-resource settlement is journaled separately; accepted input with unknown settlement is interrupted and never replayed.
- Recovery review: a failed file append poisons the fatal barrier instead of skipping an envelope sequence. Publication target identities advance only in settled Journal records; unclosed Publication targets are treated as uncertain during recovery.

- Added versioned in-memory and durable file Work Journal Adapters with ordered append barriers, per-record sync, monotonic envelopes, corruption detection, and incomplete crash-tail repair.
- Persisted accepted graph/item definitions, dependency and ownership descriptors, Worker events, structured results/evidence, Publication phases, cancellation, recovery interruption, and ownership release facts.
- Recovery reconstructs data-only graph state; uncertain preparation, Run, Tool, settlement, or Publication work becomes `interrupted` and is never automatically replayed. Never-started descendants are re-evaluated against recovered causality.
- Fixed settlement-slot release so a quiescent parent waiting for accepted descendants cannot deadlock the graph concurrency budget.
- Verification: `@coda/runtime` typecheck/Biome/build and all 49 tests pass; durable file Adapter integration test passes.
