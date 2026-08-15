---
status: accepted
---

# Separate Skill loading from product policy

ADR-0051 supersedes this decision's Workspace Skills Trust paragraph and makes
Skill safety user-controlled. ADR-0043 moves Run-scoped Skill contribution
acquisition, lifetime, and final prompt assembly into `@coda/runtime`; the leaf
loader boundary, roots, precedence, and exact-revision activation remain
accepted.

Coda implements Agent Skills format handling, bounded local discovery, canonical identity, strict validation, and exact-revision activation in a leaf `@coda/skills` package. `@coda/coding-agent` owns roots, precedence, discovery management, the Skill capability source, watchers, and UI; `@coda/runtime` acquires that source and retains its exact-revision Tool and prompt contributions in the Run Capability Lease. This boundary was chosen over both a fully stage-pluggable source pipeline and a host-owned local inventory because it keeps the common runtime interface deep without turning Coda product behavior or speculative remote distribution into the loader's public contract.

The neutral Agent Skills specification and its official client guide are the sole compatibility target. Coda discovers only `<Workspace>/.agents/skills` and `~/.agents/skills`, with project precedence, and does not scan `.coda`, Codex, Pi, Grok Build, OpenCode, ancestor, or other client-specific roots. The loader interprets only standard frontmatter fields; non-standard top-level fields and companion vendor manifests have no product semantics.

The original decision introduced Workspace Skills Trust, separate from
AGENTS.md Project Trust, for the exact hash of a Workspace Skill Inventory.
ADR-0051 removes that review gate. Each Run still freezes an exact-revision
Skill contribution, and activation rejects revision changes rather than
silently applying new instructions. Remote registries and installers remain a
separate future module.
