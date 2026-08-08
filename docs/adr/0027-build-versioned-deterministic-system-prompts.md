---
status: accepted
---

# Build versioned deterministic system prompts

Only `@coda/coding-agent` owns a versioned Prompt Builder. It freezes one deterministic prompt per Run from injected runtime facts, registry-derived capabilities, the canonical Workspace, and size-bounded trusted project instructions; lower packages accept the resulting Context without knowing Coda prompt policy. The Run records the builder version and prompt hash without persisting Credentials or a second copy of the prompt.
