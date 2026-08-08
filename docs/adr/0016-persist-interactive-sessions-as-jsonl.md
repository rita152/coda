---
status: accepted
---

# Persist interactive Sessions as append-only JSONL

Interactive Coda Sessions are workspace-scoped, versioned append-only JSONL with stable identities, explicit `0600` files, and a single-writer lock; print mode remains in-memory unless persistence is requested. The first format supports linear list, resume, and continuation while deliberately deferring branching, compaction, and summaries. Only a truncated final record is recoverable; earlier structural corruption refuses resume, and Credentials, environments, raw provider responses, and default stack traces are never stored.

The v1 log uses a header followed by typed Records linked with `previousRecordId`; Follow-up state is durable while Steering and active execution are not restored.
