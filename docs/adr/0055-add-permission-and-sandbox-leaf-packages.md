---
status: accepted
---

# Add Command Permission and Process Confinement as leaf packages

Coda adds `@coda/permission` and `@coda/sandbox` as workspace leaves so Command Permission policy and Process Confinement can be tested without the Coding Agent application, then composed by `coding-agent` the same way MCP and Skills are. This supersedes ADR-0047's eight-package count; the direction “applications may know foundations; foundations never know applications” remains. Permission hangs on `LifecycleHookHost` and resolves `permissionDecision:ask` before the runtime sees the outcome. Confinement wraps Bash, User Shell, and Process Session scripts through `wrapScript` and uses `@anthropic-ai/sandbox-runtime` as the engine; it does not wrap the generic `ProcessRunner`, File Tools, hook handlers, or credential helpers. ADR-0056 replaces the original boolean switches with Codex's three-way Approval Policy and Process Confinement Mode.
