---
status: accepted
---

# Compact Context Windows with durable checkpoints

ADR-0043 moves Context Window and Compaction orchestration into each private
Worker Runtime; the durable checkpoint and recovery semantics below remain
accepted.

Coda compacts automatically at a safe model-call point after a Context Window crosses its threshold or after a Provider reports a recoverable Context Overflow. ADR-0044's closed Work Graph command algebra supersedes the former user-invoked compaction entry point: Context Window control is private to each Worker Runtime and is not exposed through an application command or compatibility alias. Both automatic triggers use one compaction implementation; selection, summarization, validation, checkpoint commit, Context Window replacement, and recovery semantics may not fork.

Coda preserves the complete append-only Session history and compacts only the model-visible Context Window. A Worker Runtime-owned deep module selects a Tool-pair-safe exact recent Message tail, iteratively summarizes the older active history, regenerates the current system prompt and Tool set, and durably appends a Compaction Checkpoint before activating the replacement Context Window; the checkpoint carries window identity, covered and retained Message identities, the exact replacement projection, Usage and Model metadata, and summary prompt provenance so resume never reruns compaction.

Provider-reported Context Overflow may force one compact-and-retry only before Provider output or Tool execution. Summary input is reduced through explicit structure-preserving stages and may be chunked, but committed Session Messages are never silently deleted or rewritten; if summary validation or checkpoint persistence fails, the old Context Window remains active and the request fails closed. Once a checkpoint exists, a bounded read-only Session-history Tool may recover omitted detail from the preserved journal.

This supersedes ADR-0017 only for that one successful-compaction recovery path: an unchanged Context is still never retried after Context Overflow, and the existing prohibition after Tool execution remains intact. It supersedes ADR-0028's temporary prohibition on Compaction; when no safe compressible prefix exists, summary validation fails, or checkpoint persistence fails, Coda still fails closed.

## Considered options

- Replacing the whole Context Window with only a summary loses too much immediate Tool and editing state.
- Keeping only a recent tail makes earlier constraints and decisions unrecoverable.
- Mutating or pruning Session records breaks audit, resume, and future branching.
- Arbitrarily splitting serialized Messages can break Tool-call/result relationships.
- Provider-native compaction and speculative two-pass summaries add portability and stale-state complexity, so they are outside the first implementation.

## Consequences

Agent state and Timeline continue to expose the complete committed transcript while model calls use a separate Context Window projection. Session schema, recovery, private Worker model-call orchestration, and Context Overflow handling must all adopt the checkpoint, and tests must prove atomic commit, deterministic resume, safe cut points, repeated compaction, model downshift, and exactly-one overflow recovery.
