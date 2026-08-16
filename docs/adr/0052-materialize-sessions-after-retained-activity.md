---
status: accepted
---

# Materialize Sessions after retained activity

A newly opened persistent Session allocates its stable identity and exclusive lease without immediately publishing a JSONL journal. Model selection, Project Trust, and MCP Server Trust records are setup choices: the Session buffers them in memory until the first non-setup semantic fact. That fact atomically materializes the current Session header and all buffered records before execution continues. Closing a setup-only Session releases its lease and discards the provisional records, so opening the application, running local commands, or exiting before model-directed work cannot create resumable history.

`SessionManager.list` and `listSummaries` expose only journals containing retained activity. Existing header-only or setup-only journals remain untouched and directly resumable by identity, but are not discoverable history. This preserves local data while repairing old list pollution. The setup allowlist is deliberately narrow: every current or future Session Record that is not explicitly classified as setup activity materializes and retains the Session, preserving the fatal persistence barrier for Runs, Messages, Tools, Follow-ups, Compaction, and other semantic work.

A persistent `SessionDescriptor.path` is now the logical journal destination and may precede the file itself. Callers must use the Session's retained-activity projection when advertising resume behavior and must not infer materialization from the path. The lifecycle and listing policy operate on Provider-neutral Session Records, so OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages share identical behavior without Api-specific branches.

This decision narrows ADR-0016's persistence point and ADR-0024's durability statement: setup choices become Session-durable only when the Session acquires retained activity. Their owning settings and trust stores remain responsible for persisting the underlying user decisions independently of Session history.
