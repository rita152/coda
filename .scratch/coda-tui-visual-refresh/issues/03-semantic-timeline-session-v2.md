# Build the Semantic Timeline and Session v2

Type: task
Status: resolved
Blocked by: 02

Replace Chat's string transcript with typed Message, Thinking, Tool Invocation, and Attachment entries; expose semantic Session history; hydrate live and restored state through one reducer; add atomic v1-to-v2 migration and media references.

## Acceptance

- Restored and live timelines have identical identity, order, state, and content semantics.
- Parallel Tool completion never reorders entries.
- Discarded partial attempts leave no durable Message.
- Migration preserves a validated v1 backup and never exposes a partially written v2 journal.
- JSON media descriptors do not leak base64 unless explicitly requested.

## Comments

## Answer

Implemented one Semantic Timeline reducer for restored and live state, stable in-place Tool lifecycle updates, discarded-attempt cleanup, Session v2 content references, atomic v1 migration with backup, and JSON v2 media projection.
