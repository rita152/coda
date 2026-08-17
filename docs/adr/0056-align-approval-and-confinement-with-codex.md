---
status: accepted
---

# Align Approval Policy and Process Confinement Mode with Codex

Coda replaces the boolean Command Permission and Process Confinement switches with Codex's wire names and decision tree: Approval Policy is `untrusted` / `on-request` / `never`, and Process Confinement Mode is `read-only` / `workspace-write` / `danger-full-access`. The leaf packages own those rules so coding-agent only resolves CLI, settings, and legacy `enabled` flags into the same two enums. Process Confinement stays opt-in (`danger-full-access` when unset) because Coda File Tools still run on the host and Sandbox Runtime is not a guaranteed platform sandbox; that is the one product default that does not copy Codex's type-level `read-only`.
