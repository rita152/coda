---
status: accepted
---

# Separate lifecycle and evidence-backed completion

Print and JSON Runs retain the Agent's lifecycle `RunOutcome` unchanged and add
an application-owned, versioned `CompletionDisposition`. Model termination,
public evidence completeness, and local verification result are orthogonal
fields; `verified`, `partial`, `blocked`, and `unverified` are derived from
those fields rather than encoded into `RunOutcome`.

The gate consumes authoritative Tool Observations, a live public Run Evidence
snapshot, and bounded hashes/path summaries of initial and final Git
diff/status. A successful verification predating the latest mutation is stale.
Read-only and diagnosis Runs do not require a test command merely to complete.
Assistant prose is not inspected for completion phrases, and local
verification explicitly records the hidden verifier as `not_evaluated`.
Failure reconciliation remains owned by versioned Run Evidence: a narrow
adapter prefers its explicit open-failure view and retains a conservative v1
compatibility fallback instead of re-reducing failures in the completion gate.

At a terminal candidate, insufficient actionable post-mutation evidence may
enqueue one repair Steering by default. The bound is terminal: Coda then emits
the remaining disposition and preserves the final assistant message, workspace
patch, and Run Evidence. Text print mode returns zero only for `verified`;
interactive Runs keep their existing behavior.
