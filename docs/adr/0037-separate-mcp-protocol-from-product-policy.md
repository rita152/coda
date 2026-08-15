---
status: accepted
---

# Separate MCP protocol mechanics from Coding Agent policy

ADR-0043 moves Run-scoped MCP contribution acquisition and lifetime into
`@coda/runtime`; Server definitions, trust, credentials, Session state, UI, and
the `@coda/mcp` protocol boundary remain as decided here.

Coda implements MCP client protocol mechanics in a private leaf `@coda/mcp`
package. `@coda/coding-agent` owns MCP Server Definition sources, Workspace
trust, credential resolution, the MCP capability source, Session state, and UI;
`@coda/runtime` acquires that source and retains its connection generation in
the Run Capability Lease. This seam was chosen over both embedding the SDK
directly throughout the application and introducing a generic plugin framework:
the leaf package can deeply hide version negotiation, transports, discovery,
subscriptions, MRTR, Schema validation, result normalization, and connection
recovery without exporting product behavior or a speculative Extension model.

The current production scope is a Tools-only MCP Host based on the official TypeScript SDK v2. Protocol revision 2026-07-28 is canonical; Streamable HTTP may auto-negotiate and stdio defaults to an explicit modern pin, while 2025-11-25 and 2025-06-18 remain tested compatibility paths. Legacy HTTP+SSE and the deprecated Roots, Sampling, and Logging features are excluded, as are Resources, Prompts, and complete OAuth.

Each configured Server has stable local identity, faults independently, and
contributes namespaced Tools through a revision-bound lease. Every Run retains
that lease until settlement. Server metadata is untrusted, Tool calls are
sequential and non-replayable, and a request is never retried after it may have
crossed the transport seam. Trusting a stdio Server admits and launches that
exact Server definition.
