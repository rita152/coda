# Privatize and deepen the Worker Runtime lifecycle

Status: resolved
Blocked by: 01, 02

Replace the old public Runtime Interface with a private Worker Runtime driven by host-only Submission envelopes. Make preparation cancellable and observable, keep executable Prepared Run capabilities private, remove in-band Skill snapshot binding, and split fatal barriers from isolated observations.

## Comments

- The Work Graph now owns a private serial Worker built directly over `@coda/agent`; the old instance Runtime is no longer used by orchestration. Each Run is driven by a host-only Submission containing graph/item causality, resource references, and an opaque preparation identity that never enters model input.
- Added preparation `AbortSignal`, deadline, per-Run budget freezing, observable preparation phases, cancellation before `run_start`, and exactly-once Prepared Run disposal after ordered Session and Work Journal Run barriers.
- Removed content hashing, in-band Skill snapshot tokens, and the Run Skills coordinator. Skills, MCP, Tools, prompt, Model/auth, and Context Window execution capabilities stay inside the private Worker.
- Session/Journal failures after possible external effects now produce interrupted Work Results, while observer callback failures are detached diagnostics and cannot fail a Run.
- Verified 7 atomic Prepared Run tests, 15 Work Graph interface tests, 2 recovery/journal tests, and clean `@coda/agent` plus `@coda/runtime` typechecks.
