# Verify the networked Codex-equivalent Plugin experience end to end

Type: task
Status: resolved
Priority: P0

Build the final conformance matrix and live harness that compare Coda's Agent
Plugin client semantics with a recorded desktop Codex baseline while proving
that Coda still admits only Agent Plugins 1.0.0 packages.

## Dependencies

- Issues 01 through 05 must be resolved with their own network evidence.

## Acceptance

- A checked-in offline fixture set covers valid Skill-only, MCP-only, combined,
  duplicate-name, malformed, malicious-path, and foreign
  `.codex-plugin/plugin.json` packages.
- A reviewed HTTPS Agent Plugins 1.0.0 fixture is pinned by source, version, and
  digest and exposes a harmless Skill plus a controlled, read-only MCP Tool.
- One repeatable live script or documented harness exercises browse, install,
  enable, Run use, upgrade, disable, removal, process restart, network failure,
  invalid package, and foreign-manifest rejection in interactive and
  machine-readable modes.
- The conformance record names the desktop Codex build and captures its client
  semantics for discoverability, lifecycle state, names, new-session behavior,
  disabled behavior, and diagnostics without treating its package format as
  input to Coda.
- Coda's matrix has no unexplained semantic difference within Agent Plugins
  1.0.0's representable Skill and MCP scope. Out-of-protocol Codex component
  kinds are labeled non-representable rather than translated.
- Network calls require no personal credentials, perform no remote mutation,
  redact transport data, and fail visibly when the endpoint is unavailable.
- Repository checks and the complete offline suite pass immediately before the
  final live run. Exact revisions, commands, timestamps, results, and redacted
  evidence are appended under `## Comments`.

## Ownership

Keep conformance fixtures and orchestration outside production package parsing.
The harness may observe desktop Codex and Coda as clients and may construct a
foreign `.codex-plugin` negative fixture solely to prove the zero-read
boundary. Coda must never probe, read, parse, translate, install, or admit that
fixture or any other `.codex-plugin` content.

## Comments

- 2026-08-19 baseline: `/Applications/ChatGPT.app/Contents/Resources/codex
  --version` reported `codex-cli 0.148.0-alpha.9`. The matching source tree was
  inspected for Plugin prompt rendering, Skill host aliases, CLI/TUI lifecycle
  surfaces, staged installation, enablement, and MCP Tool exposure. This is the
  semantic comparison build; its `.codex-plugin` compatibility paths are
  explicitly outside Coda's protocol input.
- 2026-08-19 partial live harness: `test/live/agent-plugins.live.test.ts`
  downloaded the official
  [`agentplugins/agent-plugins-example`](https://github.com/agentplugins/agent-plugins-example/tree/5f3f5084a821aefa792e79500dd8f0462ab83473)
  fixture over HTTPS at commit
  `5f3f5084a821aefa792e79500dd8f0462ab83473`. Recorded SHA-256 values were
  `febc5269ac2154f2ca38257e15e126dfb481a5f4558a35bdf126d1ce10aff885`
  for `plugin.json` and
  `cbcfa4804eaf880593f382f8e873d5c59f57dbb0762e481891c5b1ca1d1db41c`
  for the Skill. Coda loaded only the Agent Plugin root, exposed the stable
  Plugin Skill/MCP identities, connected to the real read-only OpenAI Docs
  HTTPS MCP endpoint, listed Tools, and completed `search_openai_docs`. The
  focused live test passed in 4.4 seconds at 19:12 +08. This proves the portable
  load/use path, not yet the complete lifecycle matrix required to resolve this
  issue.
- 2026-08-19 19:46 +08 installation round: the same pinned HTTPS fixture was
  copied through the atomic Plugin Installation Store before discovery. The
  selected package digest was
  `26fd8f2eec08b0c139d60f73627c19f64cbaf78b69ec6b499ff618d031e4bb99`,
  the effective identity was
  `agent-plugins-example@official-example`, and the managed installation fed
  the same Skill and MCP Inventory used by the Run path. The real OpenAI Docs
  MCP `search_openai_docs` call passed again. Command:
  `npx vitest run --config vitest.live.config.ts
  test/live/agent-plugins.live.test.ts`; result: 1/1 in 4.88 seconds.
- 2026-08-19 conformance snapshot: [`../conformance.md`](../conformance.md)
  records the Codex `0.148.0-alpha.9` semantic baseline, the strict Agent
  Plugins 1.0.0-only boundary, and the Plugin/Skill/MCP evidence matrix. The
  checked-in offline corpus covers Skill-only, MCP-only, combined, duplicate,
  malformed, malicious-path, and foreign packages. The live harness now
  contains seven scenarios spanning the pinned AIUP combined Plugin's
  six-Skill/Context7 Prepared Run, exact-SHA Git browse/install/upgrade,
  persisted lifecycle and restart, active-Run lease isolation, CLI/TUI parity,
  network failure, and foreign-manifest rejection. These are current test
  contracts, not a claim that the final sealing run has completed.
- 2026-08-19 scope note: Agent Plugin MCP declarations do not own the MCP wire
  revision. A Context7 endpoint that only negotiates `2025-03-26` exposes an
  `@coda/mcp` host-compatibility gap, not a failure of Plugin discovery,
  installation, identity, enablement, or Run projection, and is not a blocker
  for this Agent-Plugins-client iteration. OAuth is Agent Plugins v1
  client-managed; complete OAuth remains host/client scope, while Plugin
  validity and authentication/startup diagnostics stay separate.
- 2026-08-20 final sealing: desktop Codex
  `0.148.0-alpha.15` was the semantic baseline. `npm run check` passed from
  15:28:39 to 15:29:20 +08; `npm test` passed from 15:29:25 to 15:31:45 +08
  with 227 Vitest files/1,771 tests plus seven Python cases. The immediately
  following live command passed all seven scenarios from 15:31:56 to 15:32:41
  +08 in 43.73 seconds. It reconfirmed AIUP SHA
  `69c475edf8f2eae5fcdb0e54181e4fc00a9ae955`, manifest/version
  `aiup-core`/`2.5.1`, digest
  `001a1e53e9503edaf9fc8f159f05eed34725273b447297fd0f19afc07c7d7384`,
  all six namespaced Skills, `aiup-core:context7`, model-visible provenance,
  the completed `$aiup-core:requirements` Prepared Run, and a real non-empty
  React `resolve-library-id` result. No wire-version limit occurred. Exact
  worktree fingerprint, commands, and all observations are recorded in
  [`../conformance.md`](../conformance.md).
