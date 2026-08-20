# Agent Plugins / Codex client conformance record

Date: 2026-08-20

This record closes the [implemented specification](./spec.md) with the final
offline and live acceptance evidence for the identified worktree below.

## Reference boundary

The sealing semantic reference is desktop Codex `0.148.0-alpha.15`, observed from
`/Applications/ChatGPT.app/Contents/Resources/codex` and its matching source.
The effort began against `0.148.0-alpha.9`; the relevant Plugin, Skill, and MCP
client semantics were unchanged in the sealing build.
The relevant client behavior is:

- source-aware `<plugin>@<marketplace>` installation identity, per-Plugin
  enablement, isolated Plugin data, staged activation, and later-Run refresh;
- one generic `<plugins_instructions>` fragment when an effective Plugin
  contributes a capability, without copying the Plugin inventory into the
  prompt;
- Plugin Skill names under `plugin-name:skill-name`, Codex Skill catalog and
  explicit activation fragments, structured `agents/openai.yaml` sidecars, and
  exact `Install` / `Continue anyway` consent for missing Skill MCP
  dependencies;
- ready MCP Tools exposed through the ordinary MCP Tool surface, with Plugin
  provenance and per-Run retention rather than a separate Plugin invocation;
- management state that distinguishes available, installed, enabled, invalid,
  untrusted, disconnected, failed-to-start, and update-available conditions.

Codex is not an input format. Under
[ADR-0063](../../docs/adr/0063-keep-agent-plugins-protocol-independent-from-codex-experience.md),
Coda accepts only Agent Plugins 1.0.0 rooted at `plugin.json`, with portable
`skills/` and `mcp.json` components. It does not scan, parse, translate, or
fall back to `.codex-plugin/plugin.json`. Codex-only apps, hooks, commands, or
other component kinds are non-representable in this protocol; client parity
does not authorize a compatibility overlay.

The implementation worktree is based on Git
`e7cd0c5f859e567ceed6f1a5c46b026f63c418d7` plus uncommitted changes. Its
deterministic worktree identity is
`sha256:883b0631ab8c79ea4ba622f806e8d2273109c6943d8c24ec26b1ff3dc014aa66`
over 1,734 tracked or untracked, non-ignored entries. The fingerprint enumerates
`git ls-files --cached --others --exclude-standard -z`, excludes this
`.scratch/agent-plugins-codex-experience/` evidence directory, sorts paths by
UTF-8 byte order, and hashes length-prefixed path, entry kind, worktree mode,
and file bytes or symlink target. The exclusion lets this record embed the
identity without changing it; the base commit alone is not the implementation
revision.

## Skill / MCP / Plugin matrix

| Surface | Portable Agent Plugins 1.0.0 content | Coda client/host policy | Prepared Run observation | Checked-in evidence |
| --- | --- | --- | --- | --- |
| Plugin package | Root `plugin.json`; optional fixed `skills/` and `mcp.json` | Sources, installation records, content-addressed revisions, enablement, precedence, diagnostics, and retirement are application-owned | One coherent Plugin Inventory revision contributes only enabled, valid capabilities | [`fixture-corpus.test.ts`](../../packages/coding-agent/test/plugins/fixture-corpus.test.ts), [`installation-store.test.ts`](../../packages/coding-agent/test/plugins/installation-store.test.ts), [`inventory.test.ts`](../../packages/coding-agent/test/plugins/inventory.test.ts) |
| Plugin identity | Manifest name/version, not a cache path | Stable installation ID is `<plugin>@<marketplace>`; manifest name is the Plugin Namespace; duplicate selection is deterministic | Names and capability revision are path-, scope-, and cache-independent | [`marketplace.test.ts`](../../packages/coding-agent/test/plugins/marketplace.test.ts), [`management.test.ts`](../../packages/coding-agent/test/plugins/management.test.ts), [`run-capability.test.ts`](../../packages/coding-agent/test/plugins/run-capability.test.ts) |
| Plugin guidance | No portable prompt fragment | Emit Codex's generic `<plugins_instructions>` only for an effective Skill or ready MCP contribution | Guidance is frozen with the Project capability lease and contains no inventory dump | [`run-capability.test.ts`](../../packages/coding-agent/test/plugins/run-capability.test.ts), [`project-runtime.test.ts`](../../packages/coding-agent/test/app/project-runtime.test.ts) |
| Plugin Skill | Agent Skills-compatible bundle under `skills/` | Canonical client name is `<plugin-name>:<skill-name>`; direct and Plugin Skills share product gating, precedence, sidecar, palette, and activation policy | Catalog contains bounded metadata and a `SKILL.md` locator; explicit activation injects the exact selected body/revision | [`inventory.test.ts`](../../packages/coding-agent/test/skills/inventory.test.ts), [`context.test.ts`](../../packages/coding-agent/test/skills/context.test.ts), [`run-assertions.test.ts`](../../packages/coding-agent/test/skills/run-assertions.test.ts) |
| Skill sidecar | Optional `agents/openai.yaml` beside the Skill | 64-KiB pre/post-read limit, sixteen-read concurrency, whole-sidecar fail-open for typed known-field errors, forward-compatible unknown fields, and single-line interface strings; typed OAuth callback metadata is retained but authentication is explicitly client-managed | Product/implicit policy is resolved before catalog collision; the model catalog uses `SKILL.md` frontmatter description while `interface.short_description` remains UI metadata; Plugin-relative stdio dependencies are root-contained and consent shows canonical target plus Plugin provenance | [`invocation.test.ts`](../../packages/coding-agent/test/skills/invocation.test.ts), [`inventory.test.ts`](../../packages/coding-agent/test/skills/inventory.test.ts), [`mcp-dependencies.test.ts`](../../packages/coding-agent/test/skills/mcp-dependencies.test.ts), [`skills-flow.test.ts`](../../packages/coding-agent/test/skills-flow.test.ts) |
| Skill MCP dependency | A declarative Tool requirement, not authority | Only an explicitly selected Skill plans missing dependencies; canonical user, Workspace, disabled/untrusted declarations, and effective Plugin MCP definitions suppress duplicates | One Session prompts once per canonical dependency; accepted changes persist and trigger one serialized coherent refresh before the same input is re-prepared | [`mcp-dependencies.test.ts`](../../packages/coding-agent/test/skills/mcp-dependencies.test.ts), [`skill-mcp-dependencies.test.ts`](../../packages/coding-agent/test/app/skill-mcp-dependencies.test.ts), [`mcp-dependency-application.test.ts`](../../packages/coding-agent/test/skills/mcp-dependency-application.test.ts) |
| Plugin MCP Server | `mcp.json` stdio or Streamable HTTP declaration | Semantic identity is `<plugin-name>:<server-name>`; the host-safe server ID remains deterministic; Workspace MCP Trust, startup, OAuth, and Tool visibility remain host/client policy | Every ready model-visible Tool is directly exposed under [ADR-0064](../../docs/adr/0064-expose-ready-mcp-tools-directly.md); Plugin Tools have 8,000-byte per-Tool and 64,000-byte aggregate spec budgets | [`mcp.test.ts`](../../packages/coding-agent/test/plugins/mcp.test.ts), [`run-capability.test.ts`](../../packages/coding-agent/test/mcp/run-capability.test.ts), [`application.test.ts`](../../packages/coding-agent/test/mcp/application.test.ts) |
| Coherent refresh | No portable lifecycle | One serialized Project transition publishes Plugin, Skill, and MCP state; successful refresh is the commit point, while known failures roll back and diagnose | Active leases keep old Skill/MCP capability; later Runs acquire the next complete revision; removed processes retire after the last lease | [`project-runtime.test.ts`](../../packages/coding-agent/test/app/project-runtime.test.ts), [`project-capability-bundle.test.ts`](../../packages/coding-agent/test/runtime/project-capability-bundle.test.ts) |
| Management | No portable UI/CLI | `plugin ... --json` and interactive `/plugins` project the same application service and versioned state | Lifecycle mutation is visible before the next Run is admitted; post-commit notification failure is distinguished from rollback | [`application.test.ts`](../../packages/coding-agent/test/plugins/application.test.ts), [`plugins-flow.test.ts`](../../packages/coding-agent/test/plugins-flow.test.ts), [`interactive-command.test.ts`](../../packages/coding-agent/test/plugins/interactive-command.test.ts) |

## Consent and failure semantics

[ADR-0065](../../docs/adr/0065-align-skill-client-policy-with-codex.md)
defines the Skill client boundary. The production path now records the
following contract in deterministic tests:

- dynamic `never` approval plus `danger-full-access` Process Confinement is
  auto-approved before any interactive decision; other profiles show the exact
  choices interactively or continue headlessly;
- interactive Skill dependency consent handles Install, Continue anyway, and
  Escape in the active chat TUI, while the standalone terminal fallback is
  disabled whenever a full-screen output lease is active;
- continuing headlessly emits a bounded
  `skill-mcp-dependency-not-installed` diagnostic instead of hiding the missing
  capability;
- a successful serialized Project refresh is the commit point even if the
  prompt signal aborts immediately afterward;
- settings load, persistence, or refresh failure warns and continues when the
  durable state is known or has been rolled back; only an unreconciled durable
  state fails closed;
- after installation, the current input re-resolves its Skill and MCP
  selections from the newly published Project revision rather than reusing a
  stale Skill object.

These are client consent and publication rules. They do not grant MCP Server
Trust or Tool-call permission.

## MCP wire version and authentication scope

Agent Plugins 1.0.0 MCP declarations do not choose an MCP wire version. Coda
maps them to the ordinary MCP Host's automatic negotiation. The current host
advertises `2026-07-28`, `2025-11-25`, and `2025-06-18`; support for a server
that only negotiates `2025-03-26` belongs to `@coda/mcp` host compatibility,
not to Agent Plugin package discovery, installation, namespace, enablement, or
Run projection. A final AIUP/Context7 probe that reaches this boundary must
record the exact negotiation result, but a `2025-03-26` host gap is not an
Agent-Plugins-client blocker for this iteration.

OAuth is likewise v1 client-managed. A portable Plugin may identify an MCP
endpoint, but it does not own OAuth credentials, callbacks, or durable tokens;
client-owned authorization headers are not accepted as portable package
authority. Coda currently projects authentication/startup failures separately
from Plugin validity, including a deterministic HTTP 401 case. Complete OAuth
remains an MCP client capability outside this implementation round rather than
a reason to translate or reject an otherwise valid Agent Plugin.

## Evidence recorded so far

The checked-in live harness
[`agent-plugins.live.test.ts`](../../packages/coding-agent/test/live/agent-plugins.live.test.ts)
contains seven network scenarios:

1. the pinned AIUP combined Plugin's six-Skill/Context7 Prepared Run;
2. browse/install/refresh/upgrade of an exact-SHA remote Git source;
3. persisted browse-to-remove lifecycle across two reviewed revisions;
4. an active Run retaining its old Skill and MCP lease across upgrade;
5. matching machine-readable and interactive management surfaces;
6. a versioned, non-committed network failure; and
7. malformed and foreign-package rejection with zero `.codex-plugin` probes.

The reviewed `agentplugins/agent-plugins-example` evidence already recorded in
the issues includes real HTTPS retrieval, content digest verification, managed
installation, stable Skill/MCP projection, and a non-empty read-only OpenAI
Docs MCP result. The current harness pins initial Git SHA
`8ecba107a5f2b2727d4a9c5c9ba53cc846d8d2bf` and upgraded SHA
`96eb8c1b473f54d50662b934e1c75dabf927edd9`; its selected remote installation
digests are `b2e043bdf4a19a2d426fe7221bc927b1821aa2cf189f2ecb60f91554858dbc29`
and `3f9a6f3e65d88511bda96a0366617ae643e0f4222e9041c9e0cdade1c657346f`.
The dereferenced local-fixture lifecycle expectations for those revisions are
`d6ea40261347b56ea2c4eda2e950803b09bc5352f2ce0d29d627b8de3f3d2a6f` and
`5cbea0e77cb2a6a58b87988e5c3b563956efb835a764120795ebc93af087f0c1`.

The combined fixture pins
`https://github.com/AI-Unified-Process/marketplace.git` at SHA
`69c475edf8f2eae5fcdb0e54181e4fc00a9ae955`, package and manifest name
`aiup-core`, version `2.5.1`, subdirectory `aiup-core`, and installation digest
`001a1e53e9503edaf9fc8f159f05eed34725273b447297fd0f19afc07c7d7384`.
Its namespaced Skills are `aiup-core:entity-model`, `aiup-core:requirements`,
`aiup-core:reverse-engineer`, `aiup-core:test-case`,
`aiup-core:use-case-diagram`, and `aiup-core:use-case-spec`. The same Prepared
Run selects `$aiup-core:requirements`, exposes Context7 as
`aiup-core:context7`, verifies the model-visible `resolve-library-id` Tool
description contains `Agent Plugin MCP Server aiup-core:context7 —`, performs
the real anonymous read-only React lookup, observes a non-empty successful MCP
result, and completes as `AIUP Context7 Run complete`.

## Final sealing evidence

All commands ran from `/Users/zp/Desktop/coda` on 2026-08-20 in `+08:00`,
except the live command whose working directory was
`packages/coding-agent`:

- `npm run capabilities:update`: 15:28:28–15:28:28, exit 0; generated
  `capabilities.v1.json` and README sections were current.
- `git diff --check`: 15:28:34–15:28:34, exit 0.
- `npm run check`: 15:28:39–15:29:20, exit 0; boundary checks and all nine
  planted violations, capability verification, every Workspace build, all
  TypeScript checks, and Biome over 624 reported files passed.
- `npm test`: 15:29:25–15:31:45, exit 0; 227 Vitest files with 1,771 tests
  passed, plus seven Python `unittest` cases. Coding Agent contributed 143
  files and 1,132 tests; `@coda/plugins` passed 74/74, `@coda/mcp` 48/48,
  `@coda/skills` 26/26, and `@coda/runtime` 141/141.
- `npx vitest run --config vitest.live.config.ts
  test/live/agent-plugins.live.test.ts`: 15:31:56–15:32:41, exit 0; one file,
  seven scenarios, 43.73 seconds.

The final live run confirmed all seven checked-in observations:

1. `aiup-core@aiup-pinned` at exact SHA
   `69c475edf8f2eae5fcdb0e54181e4fc00a9ae955`, version `2.5.1`, and digest
   `001a1e53e9503edaf9fc8f159f05eed34725273b447297fd0f19afc07c7d7384`
   exposed all six namespaced Skills and semantic MCP Server
   `aiup-core:context7`. The Prepared Run selected
   `$aiup-core:requirements`, saw model provenance
   `Agent Plugin MCP Server aiup-core:context7 —`, called anonymous read-only
   `resolve-library-id` for React, received a non-empty successful result, and
   completed.
2. The exact-SHA official Git source browsed, installed, refreshed, upgraded,
   and restarted with remote installation digests
   `b2e043bdf4a19a2d426fe7221bc927b1821aa2cf189f2ecb60f91554858dbc29`
   and `3f9a6f3e65d88511bda96a0366617ae643e0f4222e9041c9e0cdade1c657346f`.
3. The local reviewed lifecycle persisted install, disable, re-enable, upgrade,
   restart, removal, and post-removal restart without stale capabilities.
4. A Prepared Run retained its old Skill body and MCP lease across upgrade,
   closed the old connection exactly once on release, and the next Run saw
   only the upgraded revision.
5. Machine-readable and interactive management surfaces agreed on Plugin ID,
   revision, state, contributions, and disable/upgrade/enable/remove results.
6. `https://unavailable.agent-plugins.invalid/source.git` produced a versioned
   non-committed `plugin_marketplace_operation_failed` JSON result with no
   credential or transport leakage.
7. Malformed Agent Plugins and a constructed foreign
   `.codex-plugin/plugin.json` package failed closed; the foreign subtree had
   zero probes and was never parsed, translated, installed, or admitted.

No personal credentials or remote mutation were used. The live acceptance run
did not encounter an MCP `2025-03-26` negotiation limit; that wire-version
scope remains correctly separate from Agent Plugins package conformance.
