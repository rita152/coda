---
status: accepted
---

# Journal Tool start before side effects

A Tool may execute only after its `tool_started` Record is durable and records its finish immediately after settlement. Recovery treats an unmatched start as an Interrupted Tool Invocation with unknown side effects and never replays it automatically in the first release, forcing interactive resolution and failing non-interactive resume rather than risking duplicated local actions.
