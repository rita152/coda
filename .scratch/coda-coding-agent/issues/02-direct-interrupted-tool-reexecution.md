# Add explicit Interrupted Tool re-execution

Status: needs-triage

Interactive recovery currently supports cancel or a durable `skipped` Tool
result, after which the user may request a new invocation. Design a direct
`re-execute` choice without exposing the Agent reducer or adding the unfinished
Harness action API to Coda's public contract.

Constraints:

- never replay automatically;
- `replay: never` remains skip-only;
- re-run lookup, schema validation, execution, and cancellation;
- allocate a new Tool Invocation identity while preserving the Provider Tool
  Call relationship required by the transcript;
- journal the new start before side effects and finish immediately after
  settlement;
- keep restored Agent Seeds idle and fully resolved.

## Comments

The deep seam needs architectural review before implementation; duplicating the
Agent's private Tool executor in the Coding Agent is not acceptable.
