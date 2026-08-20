# Agent Plugins with a Codex-equivalent client experience

Status: implemented

> Historical implementation record, completed 2026-08-20. Current behavior is
> defined by ADR-0063, ADR-0064, ADR-0065, the generated capability manifest,
> package READMEs, and executable tests; see
> [`conformance.md`](./conformance.md) for the sealing evidence.

## Goal

Make Agent Plugin discovery, installation, enablement, presentation, use,
refresh, and diagnosis feel equivalent to desktop Codex while preserving Agent
Plugins 1.0.0 as Coda's only Plugin package protocol.

Codex is the behavioral reference for client semantics. It is not a package
format dependency. Every package admitted by this effort must remain a valid
Agent Plugins 1.0.0 package rooted at `plugin.json`.

## Protocol boundary

- `@coda/plugins` continues to interpret only Agent Plugins 1.0.0.
- A Plugin Source must resolve an installation candidate to an Agent Plugins
  package root; the source may not rewrite a foreign package into that shape.
- Coda does not scan, parse, import, translate, or fall back to
  `.codex-plugin/plugin.json`.
- Distribution metadata, installed state, enablement, namespaces, cached
  revisions, diagnostics, and refresh are Coda client state, not portable
  package content.
- Agent Plugin validity grants no execution authority. Existing Skill policy,
  MCP Server Trust, Tool visibility budgets, and Prepared Run admission remain
  authoritative. An MCP Mention is an immutable presence assertion under
  ADR-0064, not a permission or Tool-visibility grant.

The durable decision is recorded in
[`ADR-0063`](../../docs/adr/0063-keep-agent-plugins-protocol-independent-from-codex-experience.md).

## Client experience contract

### Distribution and installation

- The client can enumerate available Plugin revisions from configured Plugin
  Sources and distinguish available, installed, enabled, invalid, and
  update-available states.
- One Plugin Installation records its canonical manifest name, version, exact
  package revision, source identity, scope, and enabled state. Installation
  location is an implementation detail, never identity.
- Installing or upgrading validates the complete staged Agent Plugin before an
  atomic revision switch. An interrupted or invalid update leaves the previous
  valid revision selected.
- Removing an installation prevents it from contributing to later Runs and
  retires its client-owned cached revisions safely. Persistent Plugin data may
  survive an upgrade of the same installation identity but may never be
  inherited by a different manifest identity that reuses a location.
- A configured source without a valid root `plugin.json` produces one
  actionable invalid-Agent-Plugin diagnostic. Coda does not inspect sibling or
  nested foreign manifests to guess their format, and never triggers a
  compatibility scan or fallback loader.

### Enablement and precedence

- A newly completed installation is enabled by default unless an explicit
  client policy says otherwise.
- Enablement is recorded against the Plugin Installation identity, not a
  directory path. Disabling an installation excludes every one of its Skill,
  MCP, prompt, and presentation contributions and never starts its MCP process.
- Workspace precedence remains deterministic. An explicitly disabled selected
  Workspace installation blocks accidental fallback to a same-name user
  installation; disabled must not mean "silently activate another copy."
- Installation, validity, enablement, Project Trust, and MCP Server Trust remain
  separate states and are presented separately.

### Stable namespace and model guidance

- The validated manifest `name` is the Plugin Namespace. It remains stable
  across source, installation path, cache path, scope, and version changes.
- A Plugin Skill's canonical client-visible name is
  `<plugin-name>:<skill-name>`. A Plugin MCP Server has the corresponding
  semantic identity `<plugin-name>:<server-name>`; any transport-safe encoding
  used internally must preserve that identity and remain path-independent.
- Component collisions are resolved at Plugin Installation selection. Coda does
  not expose absolute paths or opaque path hashes as component identity.
- The Prompt Builder emits Codex's deterministic generic Plugin guidance only
  when at least one enabled, valid installation contributes a capability. The
  generic fragment does not duplicate the inventory: Plugin Skill names remain
  in the Skills catalog, while admitted MCP Tools retain their normal Tool
  identifiers and Plugin provenance.
- Explicit references and management surfaces use the same canonical names as
  the model-visible catalog. Disabled or invalid installations are absent from
  model guidance but remain visible in diagnostics.

### Coherent Run snapshots and refresh

- One refresh resolves installed state, package revisions, Plugin Snapshots,
  precedence, enablement, and diagnostics into one versioned Plugin Inventory.
- Run preparation derives Plugin Skill Candidates and MCP Server Definitions
  from the same Plugin Inventory revision. Their existing Run snapshots are
  retained together by one Run Capability Lease.
- Package, source, installation, or enablement changes never mutate an active
  Prepared Run. The next Run observes the newest successfully refreshed
  Inventory.
- Refresh observes creation of a previously absent Plugin root as well as
  updates and removal. Skill and MCP contributions change as one unit for the
  next Run.
- Superseded MCP connections remain usable only by leases that already retain
  them, then dispose. They are absent from new Runs and cannot survive removal
  as stale Tools.
- A manually changed installation that no longer validates is excluded from
  later Runs and diagnosed. The client does not silently retain stale
  capabilities from that invalid revision.

### Diagnostics and management

- Headless and interactive management views expose, at minimum, installation
  identity, manifest name/version, source, scope, enabled state, selected
  package revision, validity, update state, contributed Skill/MCP names, trust
  state, and diagnostics.
- Lifecycle operations have deterministic machine-readable results and clear
  distinctions among unavailable, not installed, disabled, invalid, untrusted,
  and failed-to-start states.
- Diagnostics identify the owning Plugin Installation and component by stable
  namespace. A cache path or generated hash may appear as supporting detail but
  never as the primary identity.
- Management operations and automatic refresh converge on the same Plugin
  Inventory result; a restart is not required to repair disagreement between
  the Skill and MCP views.

## Codex experience baseline

The recorded sealing baseline is desktop Codex
`0.148.0-alpha.15`. Its Agent Plugins code path already admits a root
`plugin.json`, fixed `skills/` and `mcp.json`, stable
`<plugin>@<marketplace>` identity, per-Plugin enablement, isolated data roots,
and staged cache activation. Coda follows that portable path while deliberately
omitting the legacy manifest overlay and fallback paths that remain in this
Codex build.

The conformance target is semantic rather than file-compatible:

| Dimension | Required Coda observation |
| --- | --- |
| Browse | Available and installed Plugins are distinguishable before use. |
| Install/update/remove | Lifecycle operations are explicit, atomic, and diagnostically visible. |
| Enable/disable | One state change consistently controls prompt, Skill, and MCP contributions. |
| Names | Plugin and component names are stable, readable, and source-path independent. |
| New work | A later Run receives the latest coherent enabled Plugin set. |
| Active work | An active Run keeps the exact capabilities with which it was prepared. |
| Failure | Invalid packages, trust denial, connection failure, and stale revisions are distinguishable. |
| Discovery | Model guidance and user-facing management views describe the same enabled capabilities. |

Where desktop Codex exposes a component kind that Agent Plugins 1.0.0 cannot
represent, Coda reports that component as outside this protocol. Format
expansion is not a parity technique.

## Verification policy

- Every implementation issue begins with deterministic offline contract tests
  and ends with a live network smoke test before it is resolved.
- The live fixture is a reviewed Agent Plugins 1.0.0 package obtained over
  HTTPS, pinned by version and digest, with a harmless Skill and a controlled
  MCP Server. It requires no personal credential and performs no external
  mutation.
- Each optimization round records the Coda revision, desktop Codex build used as
  the semantic reference, fixture source/version/digest, commands or UI path,
  observed names and states, MCP result, and redacted failure output under the
  issue's `## Comments`.
- A passing localhost-only test is useful but does not satisfy the required
  network smoke test. A network outage leaves the issue open with evidence; it
  is not converted into a pass.
- The final acceptance run covers browse, install, enable, Run use, upgrade,
  disable, removal, process restart, and malformed/foreign-package rejection in
  both interactive and machine-readable surfaces.

## Non-goals

- supporting `.codex-plugin/plugin.json`, `.app.json`, or any other Codex package
  component as an Agent Plugin
- executing arbitrary Plugin code or adding a generic Plugin runtime
- moving Skill format ownership, MCP protocol lifecycle, trust, or Tool
  visibility policy into `@coda/plugins`
- mutating an active Run to imitate a live global registry
- treating UI similarity as proof without package, Run, and MCP lifecycle
  evidence

## Implementation issues

1. [Plugin Sources, identity, and atomic installation](issues/01-plugin-sources-and-installation.md)
2. [Enablement and deterministic selection](issues/02-plugin-enablement-and-selection.md)
3. [Stable namespaces and Plugin guidance](issues/03-stable-namespaces-and-guidance.md)
4. [Coherent Run snapshots and hot refresh](issues/04-run-snapshots-and-hot-refresh.md)
5. [Plugin diagnostics and management surfaces](issues/05-plugin-diagnostics-and-management.md)
6. [Networked Codex-experience conformance](issues/06-networked-experience-conformance.md)

## Completion criteria

- All six issues are resolved with their offline and live verification evidence.
- The complete repository typecheck, lint, and test suite passes.
- An official-format Codex manifest is rejected without scanning or fallback.
- One enabled Plugin revision contributes stable names and one coherent set of
  Skill and MCP capabilities to a later Run.
- Disable, upgrade, invalidation, and removal cannot leave stale prompt, Skill,
  MCP Tool, process, or Plugin data identity in a new Run.
- Interactive and machine-readable management views agree with the effective
  Plugin Inventory.
- The final network conformance matrix has no unexplained semantic difference
  from the recorded desktop Codex client baseline within Agent Plugins 1.0.0's
  representable Skill and MCP scope.
