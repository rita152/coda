---
status: accepted
---

# Keep the Agent Plugins protocol independent from the Codex experience baseline

Coda accepts exactly the Agent Plugins 1.0.0 package protocol: one package is
rooted at `plugin.json`, and only the fixed Skill and MCP components defined by
that protocol are portable package content. Desktop Codex is an observational
baseline for the client experience around those packages, not a second package
protocol. Coda therefore neither scans nor falls back to
`.codex-plugin/plugin.json`, and it does not translate legacy or current Codex
plugin manifests into Agent Plugins.

Distribution, installation, upgrade, removal, enablement, stable Plugin
Namespaces, diagnostics, refresh, and presentation are Coda client policy.
Those policies operate on validated Agent Plugins without changing their
portable meaning. An installation or enablement decision grants no execution
authority: Skill policy, MCP Server Trust, Tool visibility budgets, and Run
admission remain owned by their existing Coding Agent seams.

One refresh produces a coherent Plugin Inventory. A Prepared Run retains the
exact Skill and MCP projections derived from one Inventory revision through its
Run Capability Lease; later installation, enablement, or package changes apply
only to a later Run. Stable component identity derives from the validated
manifest identity and component-local name, never from an installation slot,
cache path, or content hash.

This decision extends ADR-0062. `@coda/plugins` remains the neutral Agent
Plugins 1.0.0 interpreter, while `@coda/coding-agent` owns every client policy
needed to provide a Codex-equivalent installation and use experience.
