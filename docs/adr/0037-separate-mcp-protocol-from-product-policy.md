---
status: accepted
---

# Separate MCP protocol mechanics from Coding Agent policy

Coda implements MCP client protocol mechanics in a private leaf `@coda/mcp` package while `@coda/coding-agent` owns MCP Server Definition sources, Workspace trust, credential resolution, process-launch authority, Permission decisions, Run snapshots, Session audit, and UI. This seam was chosen over both embedding the SDK directly throughout the application and introducing a generic plugin framework: the leaf package can deeply hide version negotiation, transports, discovery, subscriptions, MRTR, Schema validation, result normalization, and connection recovery without exporting product policy or a speculative Extension model.

The first production milestone is a Tools-only MCP Host based on the official TypeScript SDK v2. Protocol revision 2026-07-28 is canonical; Streamable HTTP may auto-negotiate and stdio defaults to an explicit modern pin, while 2025-11-25 and 2025-06-18 remain tested compatibility paths. Legacy HTTP+SSE and the deprecated Roots, Sampling, and Logging features are excluded, as are Resources, Prompts, and complete OAuth until later milestones.

Each configured Server has stable local identity, faults independently, and contributes namespaced Tools to an application-level catalog. Every Run freezes an MCP Tool Snapshot. Server metadata is untrusted, Tool calls are sequential and non-replayable unless local policy says otherwise, and a request is never retried after it may have crossed the transport seam. Trusting a stdio Server authorizes launching that executable but never grants its Tool Invocations execution authority.
