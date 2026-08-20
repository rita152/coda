# Add Plugin Sources, stable installation identity, and atomic lifecycle

Type: task
Status: resolved
Priority: P0

Build the Coda-owned distribution and installation layer described in
`../spec.md`. Keep `@coda/plugins` as the strict Agent Plugins 1.0.0 package
interpreter; source discovery and installed state belong above it.

## Acceptance

- A Plugin Source can enumerate available versions and resolve one selected
  version to an exact Agent Plugins package root plus immutable source and
  revision metadata.
- One Plugin Installation has a durable identity independent of its cache or
  installation path and records manifest name/version, source, scope, digest,
  selected revision, and lifecycle state.
- Install and upgrade stage, validate, and atomically select the complete
  package. Interruption, digest mismatch, traversal, or invalid Agent Plugins
  content leaves the previous valid revision selected.
- Remove prevents later admission and retires cached revisions without deleting
  unrelated installations. Data continuity is allowed only across revisions of
  the same installation and manifest identity.
- Duplicate manifest names from different sources produce deterministic
  selection/conflict state rather than path-order behavior.
- A source without a valid Agent Plugin root manifest receives an actionable
  package-invalid diagnostic. `.codex-plugin/plugin.json` and other foreign
  manifests are never probed, scanned, translated, or used as fallback.
- Offline fixtures cover local and HTTPS source adapters, atomic interruption,
  digest mismatch, duplicate identity, update rollback, and safe removal.
- A reviewed HTTPS fixture is installed and upgraded in a live network smoke
  test; version, digest, commands, and redacted evidence are appended under
  `## Comments` before resolution.

## Ownership

Prefer a Coding Agent client module for source and installation state plus one
small adapter into the existing Plugin loader. Do not add registry, download,
or state-store concerns to `@coda/plugins`, and do not change its public package
protocol.

## Comments

- 2026-08-19 offline evidence: `installation-store.test.ts` covers bounded
  staging, validation through `@coda/plugins`, deterministic content hashing,
  atomic revision selection, invalid/interrupted upgrade rollback, safe
  removal, retained active-Run revisions, and strict omission of the foreign
  `.codex-plugin` subtree. `marketplace-store.test.ts`, `marketplace.test.ts`,
  and `management.test.ts` cover canonical local/Git sources, exact HEAD and
  Git-subdirectory selection, digest revalidation, concurrent serialization,
  traversal/symlink rejection, and last-valid-revision retention. The
  checked-in fixture corpus covers Skill-only, MCP-only, combined, duplicate,
  malformed, malicious, and foreign packages without compatibility probing.
- 2026-08-19 observed network evidence: the official Agent Plugins example at
  commit `5f3f5084a821aefa792e79500dd8f0462ab83473` was downloaded over HTTPS,
  installed as `agent-plugins-example@official-example`, and selected at digest
  `26fd8f2eec08b0c139d60f73627c19f64cbaf78b69ec6b499ff618d031e4bb99`.
  The managed revision then loaded into the Skill/MCP Inventory and completed a
  real non-empty read-only OpenAI Docs MCP call.
- 2026-08-19 current live-harness evidence: the seven-scenario harness now pins
  remote Git revisions `8ecba107a5f2b2727d4a9c5c9ba53cc846d8d2bf` and
  `96eb8c1b473f54d50662b934e1c75dabf927edd9`, with expected selected remote
  digests `b2e043bdf4a19a2d426fe7221bc927b1821aa2cf189f2ecb60f91554858dbc29`
  and `3f9a6f3e65d88511bda96a0366617ae643e0f4222e9041c9e0cdade1c657346f`.
  It encodes browse, install, refresh, upgrade, restart, and remove. A final
  timed run has not yet been recorded, so this issue is not being marked
  resolved here.
- 2026-08-20 final evidence: the complete offline suite and the immediately
  following seven-scenario live run passed. The exact-SHA official Git source
  browsed, installed, refreshed, upgraded, and restarted with both remote
  digests above. The pinned AIUP `aiup-core` combined fixture installed at
  digest `001a1e53e9503edaf9fc8f159f05eed34725273b447297fd0f19afc07c7d7384`.
  Cross-process state, exact content identity, atomic rollback, durable Run
  leases, safe retirement, and `.codex-plugin` zero-probe boundaries are
  covered by the resolved offline contracts. Exact commands, times, and
  worktree identity are in [`../conformance.md`](../conformance.md).
