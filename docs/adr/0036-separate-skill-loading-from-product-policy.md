---
status: accepted
---

# Separate Skill loading from product policy

Coda implements Agent Skills format handling, bounded local discovery, canonical identity, strict validation, and exact-revision activation in a new leaf `@coda/skills` package. `@coda/coding-agent` continues to own roots, precedence, model catalog rendering, invocation, Run snapshots, watchers, and UI. This boundary was chosen over both a fully stage-pluggable source pipeline and a host-owned local inventory because it keeps the common runtime interface deep without turning Coda product behavior or speculative remote distribution into the loader's public contract.

The neutral Agent Skills specification and its official client guide are the sole compatibility target. Coda discovers only `<Workspace>/.agents/skills` and `~/.agents/skills`, with project precedence, and does not scan `.coda`, Codex, Pi, Grok Build, OpenCode, ancestor, or other client-specific roots. The loader interprets only standard frontmatter fields; non-standard top-level fields and companion vendor manifests have no product semantics.

Workspace Skills Trust is deliberately separate from AGENTS.md Project Trust and binds the exact hash of a Workspace Skill Inventory. A changed Skill inventory disables only Workspace Skills until review; it neither blocks the Coding Agent nor grants execution authority. Each Run freezes an admitted Skill Snapshot, and activation rejects revision changes rather than silently applying new instructions. Remote registries and installers remain a separate future module.
