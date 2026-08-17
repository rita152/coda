---
status: accepted
---

# Own the Coda contracts above the AI layer

ADR-0047 supersedes this decision's original package graph, ADR-0050 makes
that boundary mechanically derive and check the workspace DAG, and ADR-0055
adds the Command Permission and Process Confinement leaves. The
compatibility-ownership decision below remains accepted.

Only `@coda/ai` promises compatibility with Pi. `@coda/tui`, `@coda/agent`, and `@coda/coding-agent` may use Pi as design research but will define their own public contracts so Coda can remove known global state, application leakage, and UI/execution coupling instead of preserving them for compatibility.

The original allowed Coda dependency graph was `agent → ai` and
`coding-agent → ai, tui, agent`; `ai` and `tui` were workspace leaves.
