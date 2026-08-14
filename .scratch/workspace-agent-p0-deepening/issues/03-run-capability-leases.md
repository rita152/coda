# Bind executable capabilities to each Run

Status: resolved

Implement `RunCapabilityHost` and `RunCapabilityLease` as described in `../spec.md`.

Required outcomes:

- a Prepared Run owns a bound Model driver rather than looking up a mutable Provider registry during streaming;
- MCP Tool snapshots retain their connection generation until every active lease is disposed;
- reload affects the next lease and cannot invalidate active Runs;
- Skills refresh is single-flight/coalesced per dirty generation;
- Worker preparation does not synchronously mutate the UI command registry;
- Built-in, Skill, and MCP contributions enter through one deterministic Run capability assembly path;
- all acquired resources are disposed exactly once on success, failure, cancellation, and preparation failure;
- focused tests exercise Model replacement, MCP reload, concurrent Skill refresh, and disposal races.

Do not introduce dynamic untrusted plugin loading, a generic DI container, scheduling changes, or Work Journal changes. Delete replaced snapshot/pass-through code.

## Comments

Implemented a generic Runtime Run capability lease with bound Model drivers, deterministic trusted contributors, and idempotent rollback/disposal. MCP now retains connection generations across reload, Skills acquisitions coalesce dirty-generation scans without Worker-owned UI mutation, and focused tests cover provider replacement, reload lifetimes, refresh concurrency, and success/failure/cancellation/preparation disposal paths.
