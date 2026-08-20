# Agent Plugins conformance fixtures

These checked-in packages exercise Coda's Agent Plugins 1.0.0 boundary without
network access:

- `skill-only`, `mcp-only`, and `combined` are valid portable packages.
- `duplicate-a` and `duplicate-b` deliberately declare the same manifest name.
- `malformed` has an invalid root `plugin.json`.
- `malicious-source` has marketplace metadata whose local source escapes the
  marketplace root and must be rejected before package access.
- `foreign-only` contains only `.codex-plugin/plugin.json`; tests install a
  poisoned filesystem guard and prove that subtree is never probed.

The foreign fixture is rejection evidence only. It is never translated or
treated as an Agent Plugin package.
