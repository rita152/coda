# `@coda/permission`

Command Permission policy for one Tool Invocation. This private package is a
workspace leaf: it does not know Lifecycle Hooks, the TUI, or process execution.

Callers supply an Approval Policy (`untrusted`, `on-request`, or `never`),
optional filesystem bounds, and remembered decisions. The policy returns
`allow`, `deny`, or `ask` using Codex's unmatched-command and patch-safety
rules: untrusted auto-allows known-safe read-only Shell; on-request asks only
for dangerous commands, sandbox overrides, or writes outside writable roots;
never never asks and denies those same escalations. Remembered decisions are
keyed by Tool name and canonical input, and workspace-scoped records do not
apply to another Workspace.
