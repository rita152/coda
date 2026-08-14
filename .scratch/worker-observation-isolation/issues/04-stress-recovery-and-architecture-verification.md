# Verify isolation, recovery, and parallel streaming

Status: resolved
Blocked by: 02, 03

## Objective

Prove the new seams through failure injection, recovery, high-volume streaming, and repository-wide verification, then delete all obsolete generic event paths and shallow tests.

## Scope

- Event-matrix contract tests.
- Model/Tool pre-effect barrier gates and parallel open-effect failures.
- v2 recovery of Attempt/Tool windows and budget usage.
- Two-Session high-volume delta/progress stress tests with slow and failing consumers.
- Static/architecture assertions and repository-wide checks.

## Acceptance

- Journal traffic is independent of transient event count and payload size.
- The required failure, recovery, parallelism, bounded-memory, Control ordering, and consumer-isolation tests in the spec pass.
- `rg` finds no `worker_event`, `fatal_barrier_failed`, generic persistence callback, compatibility codec, or unbounded Observation tail in production code.
- Repository format, typecheck, lint, unit, integration, relevant end-to-end, and `git diff --check` all pass.
- Append exact commands and outcomes below, set every issue Status to `resolved`, and leave the implementation ready for review.

## Comments

- Added replacement contract suites for the exhaustive event matrix, 10,000+ transient deltas and 10,000 Tool progress reports per Session, Fact-before-Model/Tool gates, Fact-before-Control ordering, first-failure cleanup suppression, parallel open-Tool classification, Session isolation, and shared-Journal fail-stop. Two concurrent Sessions settle under both large-stream and progress pressure while journal traffic remains 5 bounded semantic Facts per simple stream Run and 10 per Tool Run; slow consumers resynchronize.
- Added v2 recovery coverage proving shared-reducer restoration of model-Attempt/Tool-Invocation/token counters, structured budget exhaustion, `unclosed_model_attempt`, and `unclosed_tool_invocation`, with no replay. A separate assertion proves a terminal `item_result` overrides reconstructed Fact counters. File codec tests reject hidden payloads at append and decode boundaries.
- Added an architecture guard over Runtime and application Runtime sources. `rg -n "worker_event|fatal_barrier_failed|WorkerRuntimeEvent|controlWorkerEvent|observationTail|progressQueue|observeWorkerEvent" packages/*/src` returned no matches; no generic persistence callback, v1 migration decoder, or compatibility export remains.
- Repository verification passed: `npm run check`; `npm test` (Agent 72, AI 101, Coding Agent 493, Evals 28 + Pier 7, MCP 36, Runtime 79, Skills 26, TUI 107); `npm run test:e2e` (3); `npm run pack:dry-run`; and `git diff --check`. The Pier timeout-cleanup test printed its expected shielded-future diagnostic while the suite and top-level command exited successfully.
