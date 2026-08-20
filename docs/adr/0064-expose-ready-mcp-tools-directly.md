---
status: accepted
---

# Expose ready MCP Tools directly in each Prepared Run

Coda exposes every ready, model-visible Tool from an admitted ordinary MCP
Server directly in each Prepared Run. Agent Plugin MCP Tools use the same
direct exposure path, with the Codex-compatible limits of 8,000 serialized
bytes per Tool and 64,000 serialized bytes across Agent Plugin Tools. Ordinary
MCP Tools do not consume that Plugin budget. Visibility metadata, MCP Server
Trust, connection health, and these budgets still determine whether a Tool is
model-visible.

An explicit `$name` MCP Mention is an immutable presence assertion carried by
the Work Item's Desired Runtime Configuration into Run preparation. It does
not grant permission, trust, or visibility. If the asserted Tool or Server is
not present in the frozen catalog, preparation fails closed instead of silently
running with different capabilities. Follow-ups retain their own assertions,
and child Work Items inherit and union the assertions of their parent Prepared
Run without consulting mutable Workspace-global selection.

One Run Capability Lease retains the exact Tool descriptors, Plugin
provenance, assertion set, and catalog revision used for that Prepared Run.
Refreshing MCP or Plugin state affects only later Runs; existing leases remain
isolated until disposal.

This decision supersedes ADR-0057. Coda currently has no deferred `tool_search`
surface, so direct exposure matches the applicable desktop Codex behavior and
keeps the model-visible catalog independent from Composer timing and concurrent
Sessions.
