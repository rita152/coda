---
status: accepted
---

# Build versioned deterministic system prompts

ADR-0043 moves Prompt preparation from `@coda/coding-agent` into the private
Worker Runtime while preserving this decision's versioning, determinism, and
per-Run freezing requirements.

`@coda/runtime` owns the versioned Prompt Builder. It freezes one deterministic
prompt per Run from injected runtime facts, Run Capability contributions, the
canonical Workspace, and size-bounded trusted project instructions supplied by
the application; `@coda/agent` accepts the resulting Context without knowing
Coda prompt policy. The Run records the builder version and prompt hash without
persisting Credentials or a second copy of the prompt.
