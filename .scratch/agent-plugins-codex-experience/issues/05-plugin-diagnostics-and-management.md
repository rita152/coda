# Add Plugin diagnostics and management surfaces

Type: task
Status: resolved
Priority: P1

Expose the effective Plugin Inventory through headless and interactive
management surfaces so users can browse, install, inspect, enable, upgrade,
disable, remove, and diagnose Plugins without inferring state from separate
Skill and MCP lists.

## Dependencies

- Issues 01 through 04 define the authoritative state and lifecycle.

## Acceptance

- Headless commands cover source listing/management, available and installed
  Plugin listing, add, inspect, enable, disable, upgrade, and remove, with
  deterministic JSON output suitable for automation.
- The interactive `/plugins` surface projects the same Plugin Inventory and
  lifecycle results as the headless commands.
- List/detail output distinguishes available, installed, enabled, invalid,
  update-available, untrusted, disconnected, and failed-to-start states.
- Each entry exposes stable installation and Plugin Namespace identity,
  manifest version, source, scope, selected digest/revision, contribution names,
  trust state, and bounded diagnostics without making cache paths primary.
- Lifecycle failures are atomic and actionable. A failed operation cannot leave
  management output disagreeing with the next Run's effective capabilities.
- Machine schemas are versioned and contract-tested; terminal rendering covers
  narrow widths, long diagnostics, duplicate names, and unavailable sources.
- A live HTTPS source is browsed and one fixture completes the full lifecycle
  through both management surfaces. Commands, JSON excerpts, screenshots or
  terminal evidence, and redacted failures are appended under `## Comments`
  before resolution.

## Ownership

Project one application-owned Plugin management service into CLI and TUI
adapters. Do not make presentation code scan package directories or maintain a
second lifecycle state.

## Comments

- 2026-08-19 offline evidence: `management.test.ts` supplies one immutable
  application projection for local, Git, Git-subdirectory, moving-ref,
  unavailable, invalid, ambiguous, committed-prefix, and atomic rollback
  cases. `plugins/application.test.ts` covers headless lifecycle without Model
  authentication, versioned committed/non-committed JSON failures, direct
  Workspace enablement, runtime refresh failure, and a valid installed HTTP
  Plugin whose MCP startup is separately reported as HTTP 401.
  `plugins-flow.test.ts` and `interactive-command.test.ts` project the same
  snapshot into `/plugins`, including diagnostics and state-valid actions.
- 2026-08-19 current live-harness evidence encodes versioned JSON marketplace,
  add, inspect, disable, upgrade, enable, and remove results; the interactive
  `/plugins` view is checked against the same revision and stable Plugin ID. A
  separate unavailable Git source returns a versioned non-committed error, and
  malformed/foreign packages remain inspectable as invalid with zero
  `.codex-plugin` probes.
- 2026-08-20 final evidence: interactive and machine-readable surfaces agreed
  on the exact Plugin ID, revision, contributions, validity, trust/health, and
  disable/upgrade/enable/remove transitions. The unavailable Git source
  returned a versioned, non-committed
  `plugin_marketplace_operation_failed` JSON envelope without credentials or
  raw transport data. Malformed and foreign packages remained diagnosable but
  inadmissible with zero foreign-manifest probes. The full offline and live
  command record is in [`../conformance.md`](../conformance.md).
