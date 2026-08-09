---
status: accepted
---

# Make Permissions and Sandbox the execution authority

Coda replaces its advisory, host-authority Policy Gate with a Codex-compatible Permission Profile, Approval Policy, and operating-system Sandbox for every model-requested file or process operation. `@coda/sandbox` is a deep leaf module with macOS and Linux adapters, while `@coda/coding-agent` owns presets, command and network rules, approvals, caches, and presentation; `@coda/agent` remains generic. This deliberately supersedes ADR-0004's package graph and ADR-0015, ADR-0018, ADR-0019, and ADR-0029 because approval without confinement cannot provide the promised security boundary.

The semantic oracle is the public Codex checkout at commit `f93109615ff27ab58007601434b27c940d5500c7`, used as a behavioral reference rather than a runtime dependency or mechanical Rust translation. Model work and explicit User Shell use separate execution capabilities, so the model cannot acquire the unsandboxed `!command` path. Restricted profiles fail closed when their platform adapter is unavailable; explicit Full Access is the only profile allowed to run without an outer Sandbox.

## Consequences

The package graph becomes `agent → ai` and `coding-agent → ai, tui, agent, sandbox`; `ai`, `tui`, and `sandbox` are workspace leaves. Project Trust may select a default Permission Profile but never serves as execution authority. Transient approvals and `/permissions` overrides are process-local, while only explicit Command Rules and Network Rules persist.
