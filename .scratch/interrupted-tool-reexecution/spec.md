# Direct Interrupted Tool re-execution

Status: implemented

This spec is a historical implementation record. Current behavior is in
[ADR-0061](../../docs/adr/0061-offer-explicit-interrupted-tool-reexecute.md),
the Durable Sessions capability, and the tests linked below.

## Objective

Interactive Session recovery offers a direct `re-execute` choice for an
Interrupted Tool Invocation without weakening the journal-before-side-effects
barrier or exposing Agent internals.

Automatic replay remains forbidden. `replaySafety: "never"` remains Cancel or
Skip. Re-execute runs during recovery, before the idle Agent Seed is built.

## Tracking

- [`01-direct-interrupted-tool-reexecution.md`](./issues/01-direct-interrupted-tool-reexecution.md)
  is resolved.

Accepted behavior lives in [ADR-0061](../../docs/adr/0061-offer-explicit-interrupted-tool-reexecute.md),
the Durable Sessions capability, `@coda/agent` `settleToolInvocation`, and
`packages/coding-agent/test/session-recovery.test.ts`.
