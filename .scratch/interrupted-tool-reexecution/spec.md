# Direct Interrupted Tool re-execution

Status: active

## Objective

Decide whether and how interactive Session recovery can offer a direct
`re-execute` choice for an Interrupted Tool Invocation without weakening the
journal-before-side-effects barrier or exposing Agent internals.

Current recovery supports cancel or a durable skipped Tool result, after which
the user may request a new invocation. Automatic replay remains forbidden.

## Tracking

- [`01-direct-interrupted-tool-reexecution.md`](./issues/01-direct-interrupted-tool-reexecution.md)
  is awaiting architectural triage.

This effort is complete when its issue is resolved and any accepted behavior is
captured in current code tests and an ADR or package README.
