# Add a semantic JSONL evaluation mode

Type: task
Status: ready-for-agent
Priority: P1

Extract a `JsonEventWriter` and add an explicit semantic/eval stream that omits token-level `message_update` deltas while retaining authoritative lifecycle, terminal message, Tool, and evidence events. Preserve existing raw `--json` behavior for compatibility; make DeepSWE choose semantic mode explicitly.

## Acceptance

- Existing raw JSON fixtures and event shapes remain unchanged.
- A stress fixture with 100,000 deltas emits no per-delta rows in semantic mode but retains run/turn/attempt terminal events, Tool start/end/rejection, `run_end`, and `run_evidence`.
- Final assistant text and Tool calls remain reconstructable from retained terminal events; order and schema version are stable.
- Output size/line count scales with attempts and Tools, not token count.
- Raw deltas remain an explicit diagnostics option. DeepSWE lock/config records the selected stream mode and defaults its adapter to semantic mode.

## Ownership

Prefer new `packages/coding-agent/src/event-output/*`, with a thin `application.ts` integration. Only add the minimum adapter flag so issue 04 can rebase cleanly. Pi's JSON projector is a useful compatibility reference.
