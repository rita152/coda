# MCP Host Tools milestone

Implement Coda as an MCP Host/Client that gives external Server Tools to the Coding Agent. The normative protocol is MCP 2026-07-28 through the exact-pinned official TypeScript SDK v2, with tested legacy compatibility for 2025-11-25 and 2025-06-18.

## Scope

- Add a private leaf `@coda/mcp` package that owns protocol negotiation, stdio and Streamable HTTP transports, discovery, Tool subscriptions, calls, MRTR, Schema validation, normalized results, bounded execution, and connection recovery.
- Keep Server Definition sources, Workspace trust, credential resolution, process authority, Permission decisions, Run snapshots, Session audit, and interactive presentation in `@coda/coding-agent`.
- Support user- and Workspace-scoped Server Definitions with stable IDs and no silent shadowing. Workspace Definitions are inert until their exact revision is trusted.
- Maintain an application-level Registry with fault-isolated Server connections. Enabled Servers connect during catalog load so their Tools can be discovered; Tool changes update the live catalog but only affect the next Run's immutable Tool Snapshot.
- Use `(serverId, remoteToolName)` as canonical Tool identity and a deterministic provider-safe namespaced model name. Normalization collisions are diagnostics, never discovery-order winners.
- Support form and URL Elicitation with explicit Server identity and accept, decline, and cancel outcomes. Print/non-interactive mode declines safely.
- Preserve typed MCP results at the protocol seam and project bounded text/image model content without silently dropping unsupported content.

## Security and reliability

- Treat launching a stdio Server as code execution requiring Server Trust. Use an explicit cwd and sanitized environment; do not inherit credentials by default.
- Gate Tool visibility with include/exclude rules and every invocation through the Permission Engine. Server annotations are advisory only.
- Default MCP Tools to sequential execution and unsafe replay. Do not retry a call once it may have been dispatched.
- Isolate Server failures, use bounded reconnect backoff, and keep the current Run snapshot unchanged.
- Accept bounded, self-contained JSON Schema 2020-12 with local references. Reject remote references and quarantine only the invalid Tool.
- Enforce configurable connect, discovery, call, Elicitation, pagination, Schema, result-size, and MRTR limits. Progress never extends the absolute deadline.
- Persist bounded, redacted audit projections only. Credentials, Elicitation values, and opaque `requestState` never enter the Session journal.
- Support unauthenticated and externally supplied static HTTP credentials. Full OAuth is deferred behind an authentication seam.

## Operations

- Declarative configuration is the source of truth.
- Add `/mcp status`, `/mcp doctor`, `/mcp inspect`, `/mcp reload`, and `/mcp reconnect`; these commands do not edit configuration.
- HTTP defaults to modern discovery with legacy fallback. stdio defaults to 2026-07-28; `auto` and `legacy` require an explicit Server setting.

## Non-goals

- Resources and Prompts
- Complete OAuth 2.1
- Roots, Sampling, and Logging
- Legacy HTTP+SSE
- A generic plugin framework
- A long-lived-process Sandbox guarantee

## Acceptance

- Pass the exact-pinned official 2026 conformance requirements applicable to the declared client capabilities with no expected-failure baseline.
- Pass integration tests against 2025-11-25 and 2025-06-18 fixtures.
- Cover negotiation, pagination, subscriptions, MRTR, cancellation, timeouts, result bounds, schema attacks, process failure, disconnect ambiguity, reconnect, trust, permissions, and Session redaction through public seams.
