---
status: accepted
---

# Own the Coda contracts above the AI layer

Only `@coda/ai` promises compatibility with Pi. `@coda/tui`, `@coda/agent`, and `@coda/coding-agent` may use Pi as design research but will define their own public contracts so Coda can remove known global state, application leakage, and UI/execution coupling instead of preserving them for compatibility.

The allowed Coda dependency graph is `agent → ai` and `coding-agent → ai, tui, agent`; `ai` and `tui` are workspace leaves.
