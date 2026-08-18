---
status: accepted
---

# Separate Hook timing from command execution

ADR-0059 supersedes this decision's deferral of SubagentStart and SubagentStop. The rest of this decision is unchanged.

Lifecycle Hook timing belongs to the runtime modules that own Tool, Context Window, Run, and Session boundaries, while hook discovery, exact-handler trust, shell selection, and process execution belong to the Coding Agent application adapter. Coda uses the Codex command-hook JSON and stdin/stdout contracts at its own `~/.coda/hooks.json` and `<Workspace>/.coda/hooks.json` roots, rather than making the runtime depend on files, shells, or Codex-owned configuration. Command Permission now hangs on `PreToolUse` and resolves `permissionDecision:ask` before the runtime sees the outcome. `PermissionRequest` remains outside the event algebra because that Codex event is a different lifecycle boundary. This decision deferred `SubagentStart` and `SubagentStop` until delegated-worker lifecycle existed; ADR-0059 later made them runtime-supported Worker lifecycle events.
