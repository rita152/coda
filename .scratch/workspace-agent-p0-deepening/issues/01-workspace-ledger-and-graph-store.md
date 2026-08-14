# Replace the monolithic Work Journal

Status: ready-for-agent

Implement the `WorkspaceLedger` and per-Graph `WorkGraphStore` architecture in `../spec.md`.

Required outcomes:

- one production Workspace lease prevents two processes from coordinating the same Workspace;
- active Graph discovery is Workspace-global, while Graph facts are persisted independently;
- terminal Graphs are archived/closed and are absent from default active restore and snapshots;
- Graph-local append/fsync operations do not serialize unrelated Graphs;
- one Graph log failure interrupts only that Graph, while ledger failure remains Workspace-fatal;
- Runtime owns record schemas/codecs and the Node Adapter owns bytes, filesystem layout, repair, and locking;
- old monolithic FileWorkJournal code and obsolete Interface are deleted rather than wrapped;
- in-memory and Node Adapters share contract tests.

Do not redesign scheduler fairness or Run capability composition. Destructive schema and filesystem changes are allowed.

## Comments

