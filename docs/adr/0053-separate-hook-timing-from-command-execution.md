---
status: accepted
---

# Separate Hook timing from command execution

Lifecycle Hook timing belongs to the runtime modules that own Tool, Context Window, Run, and Session boundaries, while hook discovery, exact-handler trust, shell selection, and process execution belong to the Coding Agent application adapter. Coda uses the Codex command-hook JSON and stdin/stdout contracts at its own `~/.coda/hooks.json` and `<Workspace>/.coda/hooks.json` roots, rather than making the runtime depend on files, shells, or Codex-owned configuration. `PermissionRequest`, `SubagentStart`, and `SubagentStop` remain outside the event algebra until Coda has the permission and delegated-worker capabilities that can give those events truthful lifecycle boundaries.
