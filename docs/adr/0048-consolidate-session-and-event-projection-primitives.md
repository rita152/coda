---
status: accepted
---

# Consolidate Session and event-projection primitives

Coda uses one append-only `Session` port from `agent` for every Agent Runtime. The port owns identity, Agent Seed, Compaction Checkpoint, semantic Session Event acceptance, and runtime Session changes. Application Sessions extend that exact port with journal-backed projections; widening `accept` back to observational Agent Events is rejected. Session Records form one closed discriminated payload algebra, and both the Event-to-Record mapping and per-type validators must be exhaustive. Historical formats advance through an explicit migration registry before the current schema is opened. Runtime-specific Session models, unknown payloads, catch-all event drops, and JSON clone adapters are rejected. Session lifetime is owned by the reservation or per-Session runtime resource, so `close` is deliberately not part of the foundation port.

Cross-package algorithms with one meaning have one owner. `agent` owns Context-independent immutable cloning, Run-limit validation, bounded Observation delivery, and live Agent Event trace reduction; `ai` owns Context token estimation and normalized Provider failure classification; and `runtime/work-graph/work-item-transition` owns the Work Item transition table used by both live orchestration and Aggregate replay. Agent retry policy consumes the normalized failure fact instead of reclassifying status codes or SDK errors. A consumer may project the shared Agent trace into Run Evidence or evaluation reports, but it may not independently reduce the Agent Event algebra. Journal reconstruction remains separate because it consumes versioned Session Records rather than live Agent Events.

The Coding Agent opens every primary and secondary UI Session through one `OpenedSessionRuntime` resource. That resource records Model Selection, opens the Session Work Controller, binds RunControl, restores Media, attaches Workspace-diff tracking, and owns the symmetric close sequence. Workspace resources own only shared Coordinator, Process, and MCP lifetimes.

This is an intentionally breaking consolidation. No compatibility aliases, parallel DTOs, JSON round trips, or legacy lifecycle paths are retained. JSON validation remains only at actual persistence and external protocol boundaries.

This decision supersedes ADR-0047's opaque `WorkerSession` clause while preserving its package dependency direction and the Coding Agent's ownership of Session journals. It does not expose the Agent's internal state reducer prohibited by ADR-0022; `AgentEventTraceReducer` is a bounded downstream projection over public immutable events.
