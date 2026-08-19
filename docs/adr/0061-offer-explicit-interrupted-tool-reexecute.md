---
status: accepted
---

# Offer explicit Interrupted Tool re-execute on interactive resume

Interactive Session recovery already asked the user to cancel resume or skip an
Interrupted Tool Invocation. The historical Tool crash barrier also required an
explicit re-execute choice for Tools that declare `replaySafety: "safe"`.

Re-execute runs during `SessionRecovery.recover()`, before the idle Agent Seed
is built. The Agent publishes `settleToolInvocation` for lookup, schema
validation, `execute()`, and cancellation. Coding Agent journals the old
Interrupted Tool as `reexecuted_by_user`, appends a new `tool_started` with a
new Tool Invocation identity (same `providerToolCallId`) before side effects,
then journals finish and the Tool Result. `replaySafety: "never"` remains
Cancel or Skip. Print mode still fails closed. Automatic replay remains
forbidden.

This deepens ADR-0025 and ADR-0026 without exposing the Agent reducer or
adding a Harness action API.
