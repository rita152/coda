---
status: accepted
---

# Allow concurrent process epochs in one Workspace

Coda allows multiple CLI processes to share one Workspace. A lifetime-wide process lease is replaced by per-process epoch records, atomically reserved Workspace ordinals, and short Ledger transactions; active Work Graphs carry their owner epoch so another live process neither recovers nor mutates them, while Work from a dead epoch remains recoverable.

Git Workspace Adapters adopt the latest target state when reserving or recovering a Placement and serialize only the target mutation itself across processes. Non-conflicting Artifacts may therefore publish after another process changes the source, while `git apply` conflict detection still preserves conflicting Artifacts. Cross-process Publication completion is determined by target-transaction acquisition rather than waiting on another process's Publication Order. This supersedes ADR-0044's external-target rejection and process-wide Publication sequencing assumptions while preserving ordered Publication within each process epoch.
