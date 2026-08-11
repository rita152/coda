---
status: accepted
---

# Make Tool Observations authoritative

Coda represents every completed Tool Invocation with one Provider-neutral Tool Observation containing operation status, completeness, bounded safe facts, and an optional continuation reference. The same observation drives model input, Session persistence, and Timeline state; Tool output is untrusted data, while Tool Settlement separately records whether the implementation returned, threw, or was aborted. Compatibility `isError` is derived from the observation for new results, and legacy Session results synthesize a bounded observation at the consumption boundary.

This was chosen over parsing output text, trusting process exit codes alone, or maintaining Provider-specific error projections, all of which allowed an inner denial or failure to appear successful. Exploration limits are not a substitute for reliable evidence: Bash previewing is post-execution and cannot change the command's exit status, truncation is explicit, and omitted output is recoverable through an opaque reference when storage is available.

## Consequences

Session v8 persists Tool Observations and execution settlement without rewriting legacy result content. Every Api Adapter must prepend the same authoritative observation to model-visible Tool output, and Tools must expose precise status and truncation facts rather than relying on prose or presentation-only details.
