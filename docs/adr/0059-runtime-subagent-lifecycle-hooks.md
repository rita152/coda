---
status: accepted
---

# Runtime Subagent lifecycle Hooks

`SubagentStart` and `SubagentStop` are runtime-supported Lifecycle Hook events.
Timing belongs to `@coda/runtime` Worker lifecycle: `SubagentStart` after a child
Work Item's `run_started` Fact makes `running` durable, and `SubagentStop` after
that child reaches a terminal Work Result. Command discovery, exact-handler
trust, matcher, stdin JSON, timeout, and async limits stay on the Coding Agent
adapter.

Stdin follows the Codex command-hook JSON. `session_id` is the graph-root
parent Session. `agent_id` is the child Work Item id. `agent_type` is
`executionMode`. `SubagentStart` may contribute `additionalContext` to the child
Worker; `continue: false` is parsed and ignored. `SubagentStop` uses the Stop
output algebra. `PermissionRequest` stays outside the event algebra. Command
Permission still hangs on `PreToolUse`.

This supersedes ADR-0053's sentence that SubagentStart and SubagentStop remain
outside until delegated-worker lifecycle exists. ADR-0053's body is otherwise
unchanged.
