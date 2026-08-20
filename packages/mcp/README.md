# `@coda/mcp`

Private MCP client runtime for Coda. The package is a deep protocol module: it
owns MCP negotiation, stdio and Streamable HTTP transports, Tool discovery and
subscriptions, calls, MRTR, Schema validation, bounded result normalization,
and connection recovery. Product configuration, trust, credentials,
Session state, and UI remain in `@coda/coding-agent`; `@coda/runtime` owns the
per-Run capability lease that retains an acquired MCP connection generation.

The canonical protocol is MCP `2026-07-28`. The official TypeScript SDK is
exact-pinned at `2.0.0`; callers must still choose `2026-07-28`, `auto`, or
`legacy` explicitly because the SDK package version alone does not select the
wire era. Legacy compatibility is tested for `2025-11-25` and `2025-06-18`.

## Public seam

- `createSdkMcpConnector()` hides the official SDK and both supported
  transports.
- A stdio transport may carry an optional runtime-only `beforeLaunch(signal?)`
  guard. The SDK connector awaits it immediately before constructing and
  connecting the stdio transport. Callers must exclude this function from
  persisted configuration, hashes, revisions, and machine-readable output;
  rejection is an ordinary per-Server connection failure.
- `createMcpHost()` owns isolated Server connections and the live Tool
  catalog.
- `host.acquireTools()` returns an immutable, revision-bound Run lease that retains its connection generation until disposal.
- `projectMcpToolResult()` converts the typed MCP result into bounded text and
  image model content while explicitly describing unsupported content.

Tool identity is `(serverId, remoteToolName)`. Model-facing names are stable,
bounded `mcp__server__tool` names; normalized names use content hashes instead
of discovery-order conflict resolution. A definition may separately carry a
`semanticName`; snapshots, Tool descriptors, and diagnostics always project it
(falling back to `serverId`) while connection, reconnect, and Tool routing keep
using the internal `serverId`.

## Security boundary

This package validates bounded self-contained Schemas, rejects network
`$ref`s, validates Tool arguments and declared structured output, treats
annotations as untrusted metadata, and never retries a Tool call after
dispatch. It does not decide whether a Server is trusted, authorize a Tool
invocation, inherit process credentials, persist protocol state, or render
Elicitation. Those are Host responsibilities.

`beforeLaunch` closes deterministic application-level validation-to-launch
windows, but it is not an OS file-descriptor lease. A small guard-to-spawn
window remains on platforms without an `openat`/descriptor-based process-launch
primitive and must not be described as mathematically eliminated.

The current scope excludes Resources, Prompts, complete OAuth,
Roots, Sampling, Logging, and legacy HTTP+SSE.

## Verification

`npm run test:conformance` runs the official MCP conformance client scenarios
for `2026-07-28`. The harness is exact-pinned at `0.2.0-alpha.10`; the gate has
no expected-failure baseline. Product-level tests separately cover both legacy
protocol versions, transport faults, bounded projection, trust, redaction, and
Run lease lifetime behavior.
