# `@coda/sandbox`

Process Confinement for one Shell script. This private package is a workspace
leaf: it does not know Lifecycle Hooks, Tools, or the TUI.

The public seam is `openProcessConfinement` plus `wrapScript`. Process
Confinement Mode is `read-only`, `workspace-write`, or `danger-full-access`.
Read-only writes nowhere; workspace-write allows the Workspace and `/tmp` and
denies `.git`, `.agents`, and `.coda`; danger-full-access does not open
confinement. The Anthropic Sandbox Runtime engine is an adapter behind that
seam. Callers pass absolute Workspace paths; relative allow/deny paths are
rejected because the engine resolves them against `process.cwd()`. Windows is
unsupported. The package confines descendant processes only — in-process File
Tools are outside this interface.
