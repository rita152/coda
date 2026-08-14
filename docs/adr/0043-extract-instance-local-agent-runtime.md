---
status: accepted
---

# Extract an instance-local Agent Runtime behind atomic Run preparation

`@coda/agent` remains a serial Agent kernel and replaces its split stream, Tool factory, system-prompt factory, and pre-Run hook with one `prepareRun` Interface that returns an immutable Prepared Run. Preparation occurs exactly once before `run_start`; the Prepared Run is disposed in settlement cleanup. Desired Runtime Configuration may change concurrently but can affect only later Runs.

A new `@coda/runtime` package owns the reusable headless Agent Runtime Module: Agent construction, per-Run Model/authentication and Tool/prompt/catalog snapshots, Session attachment, Context Window and overflow recovery, input commands, event routing, and lifecycle cleanup. Each instance owns stable Runtime and Session identities and serializes its own Runs; no process-global or workspace-global selected/active pointer is permitted. Multiple instances may execute concurrently.

The dependency direction is `coding-agent Adapter -> runtime -> agent/ai/mcp/skills`. Host filesystem and process Tool Implementations enter through an immutable base-Tool port; Skills, MCP, and durable Session storage enter through headless source/event ports. The Session Interface accepts Agent events and never receives the private Agent object. Runtime resource transactions and Follow-up FIFO behavior live in the Runtime input queue, while Composer history and User Shell presentation remain Adapter concerns.

This decision supersedes only the package-ownership clauses in ADR-0027, ADR-0036, and ADR-0037 that assigned prompt construction and application-level Skill/MCP Run snapshots to `@coda/coding-agent`. Their determinism, trust, precedence, exact-revision, protocol, and persistence decisions remain in force. `@coda/runtime` is the complete Coda Runtime product Module rather than a policy-neutral infrastructure leaf: it owns those Run policies behind injected Skill/MCP sources and an optional deterministic Prompt preparation port, while discovery, trust decisions, credentials, terminal presentation, and host Tool Adapters remain in `@coda/coding-agent`.

CLI print and interactive modes are Adapters at the Agent Runtime Seam. They translate configuration, terminal input, presentation, and exit status without constructing Agents or Context Window controllers. A non-CLI evaluation Adapter uses the same public Interface. Runtime Implementation modules cannot import `@coda/tui`, CLI parsing, terminal I/O, or interactive presentation.

One Workspace Runtime factory is the sole Node/Workspace Adapter into the public Runtime factory for print, primary interactive, and secondary interactive Sessions. Each complete Runtime instance constructs and disposes its own durable input lifecycle; an interactive controller receives that lifecycle instead of constructing it. The evaluation harness consumes the same complete `openCodingAgentRuntime` Interface through its own deterministic Model, Session, prompt, Tool, Skill, and MCP Adapters.

This replaces the private `RunRuntimeSlot` and duplicated primary/secondary assembly. The new Module earns Depth by concentrating the lifecycle and snapshot invariants behind one small Interface; it gives callers Leverage across CLI, eval, and future SDK Adapters, and gives maintainers Locality for Run preparation and recovery changes.
