---
status: accepted
---

# Journal Tool start before side effects

A Tool may execute only after its `tool_started` Record is durable and records its finish immediately after settlement. Recovery treats an unmatched start as an Interrupted Tool Invocation with unknown side effects and never replays it automatically. Interactive resume may skip or, for `replaySafety: "safe"` only, explicitly re-execute as a new Tool Invocation; print resume still fails closed.
