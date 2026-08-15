# `@coda/coding-agent`

Coda's private terminal Coding Agent application. It composes `@coda/ai`,
`@coda/agent`, `@coda/runtime`, `@coda/tui`, `@coda/skills`, and `@coda/mcp`.
The package owns CLI and terminal policy, host Adapters, durable Session storage,
Model configuration, Credentials, and application presentation; the headless
Work Graph and Worker Runtime policies live in `@coda/runtime`.

This package is a CLI application, not an application SDK. Its npm export map is
intentionally empty; composition seams under `src/` are private and may change
without compatibility guarantees. The generated [Capabilities](#capabilities)
section below is the current product-status inventory.

## Local use

```sh
npm install
npm run build
node_modules/.bin/coda
```

The first interactive launch explicitly authenticates OpenCode Go when needed,
asks the user to select a Model, and saves that selection. Persisted Credentials
use macOS Keychain service `coda.cli.credentials.v1` or Linux Secret Service via
`secret-tool`; they are never written to settings or Session files. If Secret
Service is unavailable, Coda reports that Credentials remain process-local.

Text print mode writes only the final assistant text to stdout; JSON print mode
writes the event stream described below:

```sh
coda --print --model opencode-go/<model-id> "explain this repository"
coda --print --image ./diagram.png "explain this image"
coda --print --json "run the configured Model and emit Agent events"
coda --print --json --json-mode semantic "emit compact terminal events for evaluation"
coda --no-tui "use print mode even when stdin and stdout are terminals"
```

In the interactive TUI, dropping an absolute PNG, JPEG, GIF, or WebP path into
the Composer stages the image for upload and inserts an atomic `[filename]` at
the current edit position instead of exposing the path. The brackets are only
presentation: submitted Prompt text contains `filename`, while the image is
sent through its Attachment identity. Hover only highlights the element. Click
it to open a borderless, full-resolution terminal preview when Kitty graphics
are available; unsupported terminals open the image in the system viewer.

`--json` retains the raw JSONL v2 contract, including incremental message and
Tool progress events. `--json-mode semantic` omits those transient deltas while
retaining Run, Turn, Attempt, terminal Message, Tool lifecycle, and Run Evidence
events. Use `--json --json-mode raw` when diagnostics explicitly require every
delta.

`--run-control-work-ms` and `--run-control-grace-ms` opt into a two-phase wall-clock envelope; optional
`--run-control-stationary-turns` can request the same bounded finalization after consecutive no-progress Turns.
RunControl remains active with `--no-run-budget`. Controlled JSON event envelopes use schema v3 and their Run
Evidence uses schema v4; unconfigured Agent output remains JSON v2 and Run Evidence v3.

`--no-tui` is an explicit alias for print mode. `--color-scheme auto|light|dark`
controls terminal appearance detection; `--no-color` and `NO_COLOR` take
precedence and emit no color sequences. `--no-animations` selects reduced
motion for one invocation. Persistent UI defaults can be set in
`~/.coda/settings.json`:

```json
{
  "version": 1,
  "ui": {
    "colorScheme": "auto",
    "motion": "full"
  }
}
```

### Print completion semantics

Print mode keeps Agent lifecycle settlement separate from evidence-backed task
completion. `RunOutcome.success` still means that the Run ended normally; it
does not claim that a hidden evaluator will accept the work. After every
`run_evidence` record, `--json` emits a versioned
`completion_disposition` record with independent `modelTermination`,
`evidenceCompleteness`, and local `verification.result` fields. Its
`verification.hiddenVerifier` is always `not_evaluated`.

The v1 dispositions are `verified`, `partial`, `blocked`, and `unverified`.
A read-only or diagnosis Run may be `verified` without a test command when its
public evidence is complete and it has no relevant open failure. A mutating Run
requires a relevant successful local verification after the latest mutation
and complete final Git diff/status evidence. Assistant phrases such as “Done”
are never parsed as proof. When a terminal candidate lacks actionable
post-mutation evidence, Coda injects at most one completion-repair Steering by
default; reaching the bound settles and emits the remaining disposition.

Text print mode continues to write the final assistant text to stdout. It exits
0 only for `verified`; lifecycle failure, `partial`,
`blocked`, or `unverified` exits 1. Non-verified text runs add a concise status
to stderr, while their workspace patch and Run Evidence remain intact.
Interactive behavior is unchanged by this gate.

Custom Provider Model metadata is persisted beside the discovered Model ID and
labels every value as either `provider` discovery or an explicit `user`
override. Missing fields stay omitted; Coda applies source-labelled
Compatibility Mode caps at runtime without serializing them as Provider facts.
Prices are USD per million tokens, matching `@coda/ai` Model pricing:

```json
{
  "id": "model-a",
  "name": "Model A",
  "contextWindow": { "source": "provider", "value": 128000 },
  "maxTokens": { "source": "user", "value": 16384 },
  "reasoning": { "source": "provider", "value": true },
  "input": { "source": "user", "value": ["text", "image"] },
  "price": {
    "source": "user",
    "value": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1.25 }
  }
}
```

Credentials remain in the injected Credential Store and are never valid Model
configuration fields.

The Composer's borderless upper list exposes the core Slash commands:

<!-- coda:core-commands:start -->
Visible core commands are `/auth`, `/model`, `/effort`, `/skill`, `/mcp`, `/session`, `/new`, and `/follow-up`.

Hidden compatibility or management names are `/skills`.
<!-- coda:core-commands:end -->

Selector commands open nested menus and do not accept
trailing arguments; `/mcp` instead accepts `status`, `doctor`, `inspect`,
`reload`, and `reconnect` operations.
`/effort` lists the Reasoning Effort levels supported by the current Model and
applies the selected level to future Runs in the Session. The selection is
translated for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses.
`/follow-up` is available only for a running Session, while unknown Slash text is
submitted as ordinary Prompt text.

Useful maintenance commands are `coda sessions` and `coda cleanup`. Run
`coda skills validate <path>` for strict Agent Skills validation without a Model
or Session.

Local Agent Skills are discovered only from `<Workspace>/.agents/skills` and
`~/.agents/skills`; Coda does not scan client-specific or ancestor directories.
The project root has deterministic precedence over the global root. Global Skills
are user-managed, and project Skills are shown directly in `/skill` for the user
to select. Coda does not make a separate Skill safety decision. Explicit Composer
Skill references are user-selected context; model-selected Skills use the `skill`
Tool to load exact-revision instructions.

## MCP Servers

Coda can act as an MCP Host and expose external Server Tools to the Coding
Agent. User-managed Server Definitions live in `~/.coda/settings.json` under
`mcpServers`. Workspace Definitions live in `<Workspace>/.coda/mcp.json` and
remain inert until the exact file hash is reviewed interactively or admitted
with `--trust-project-mcp`. A changed Workspace file requires review again.

```json
{
  "version": 1,
  "mcpServers": [
    {
      "id": "docs",
      "transport": {
        "kind": "http",
        "url": "https://docs.example.com/mcp",
        "bearerTokenEnvironment": "DOCS_MCP_TOKEN"
      },
      "tools": { "include": ["search*"] }
    },
    {
      "id": "local-tools",
      "protocol": "2026-07-28",
      "transport": {
        "kind": "stdio",
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/server.mjs"],
        "cwd": ".",
        "environmentFrom": ["PATH"]
      }
    }
  ]
}
```

A Workspace file uses the same Server objects:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "workspace-tools",
      "transport": {
        "kind": "stdio",
        "command": "/absolute/path/to/server",
        "args": []
      }
    }
  ]
}
```

HTTP defaults to modern discovery with legacy fallback; stdio defaults to an
explicit `2026-07-28` pin. Set `protocol` to `auto` or `legacy` only when the
Server requires it. A stdio child receives only `environment` plus variables
named in `environmentFrom`; ambient credentials are not inherited. HTTP bearer
tokens are read from the named Coda process environment variable and are never
stored in the Definition.

Every admitted Tool is namespaced as `mcp__<server>__<tool>` and frozen for one
Run. Server annotations do not change how Coda invokes the Tool. Form and URL Elicitation identify the requesting Server; Coda never
prefetches or opens an Elicitation URL. Print mode declines Elicitation.
Use `/mcp status`, `/mcp doctor`, `/mcp inspect`, `/mcp reload`, and
`/mcp reconnect` for read-only inspection and operational control.

The macOS pseudo-terminal E2E test launches the built CLI with an isolated home
and Workspace, then verifies full-screen entry, Prompt-card geometry, multiline
Editor input, Timeline wheel navigation, resize and signal handling, protocol
cleanup, cooked-mode restoration, and a post-exit shell sentinel without making
a model request:

```sh
npm run test:e2e
```

## Capabilities

Regeneration is a final integration step: after capability-affecting branches
have merged, run `npm run capabilities:update`, review the generated diff, and
then run `npm run capabilities:check`. Do not resolve drift by editing content
inside the marker blocks by hand.

<!-- coda:capabilities:start -->
This status block is generated from executable runtime contracts. See the
[versioned manifest](../../capabilities.v1.json) for exact facts, sources, and tests.

### Runtime-supported

- **Bounded Agent Runs** (@coda/agent) — Immutable per-Run budgets cap Turns, Model Attempts, Tool invocations, elapsed time, token and USD usage, and repeated equivalent Tool batches with explicit exhaustion events.
- **Agent runtime** (@coda/agent) — In-memory Runs and Turns, immutable events, Tool execution, cancellation, Steering and Follow-up queues, and opt-in whole-Turn retry.
- **Model access** (@coda/ai) — OpenCode Go and custom API-key Providers, streaming text, Thinking, Tool calls, structured Diagnostics, cancellation, and explicit model-catalog refresh. Custom Provider protocols: `openai.chatcompletions`, `openai.responses`, and `anthropic.messages`.
- **Built-in Tools** (@coda/coding-agent) — Workspace-relative and absolute-path reading, search, atomic single-file and structured multi-file mutation, direct host Shell execution, and recoverable continuation of omitted Tool output. Built-ins: `read_session_history`, `read`, `read_tool_output`, `grep`, `find`, `ls`, `patch`, `edit`, `write`, `bash`, `process_start`, `process_poll`, `process_write`, and `process_stop`.
- **Evidence-backed print completion** (@coda/coding-agent) — Print and JSON Runs emit a versioned completion disposition that keeps lifecycle, evidence completeness, local verification, and hidden-verifier scope separate, with one bounded repair Steering by default.
- **Durable Context Compaction** (@coda/runtime) — Private Worker Runtimes automatically compact at safe model-call boundaries and durably persist Tool-pair-safe Compaction Checkpoints before replacing the model-visible Context Window.
- **Secure platform Credential storage** (@coda/coding-agent) — API credentials use macOS Keychain or Linux Secret Service when available, never persist plaintext fallback secrets, redact helper failures, and otherwise remain process-local.
- **MCP Host** (@coda/mcp) — MCP Tools over stdio and Streamable HTTP with version negotiation, Workspace trust, immutable Run catalogs, progress, cancellation, subscriptions, and form or URL Elicitation.
- **Media Assets** (@coda/coding-agent) — Bounded image Attachments use content-addressed Session storage, model-ready renditions, Kitty previews, and a system-viewer fallback.
- **Context Overflow fallback** (@coda/coding-agent) — After local and Provider overflow recovery is exhausted, interactive mode can open a fresh empty Session in the same Workspace without inheriting Messages, summaries, media, queues, Tool state, or Run evidence.
- **Long-running process Sessions** (@coda/coding-agent) — Process-local background Shell Sessions execute directly on the host and support bounded start, poll, stdin, stop, and recoverable omitted output.
- **Prompt and event formats** (@coda/coding-agent) — Deterministic per-Run System Prompt snapshots and stable opt-in JSONL v2 Agent events with optional media data.
- **Custom Provider metadata** (@coda/coding-agent) — Custom Provider models retain configured context, output, image-input, reasoning, status, and tiered-cost metadata across settings, catalog refresh, selection, and runtime consumers.
- **Objective Run evidence** (@coda/coding-agent) — Completed Runs project bounded, sanitized evidence from lifecycle events, authoritative Tool Observations, generic mutation facts, and the final Git-visible Workspace diff, separating completeness, changed-path provenance, terminal/recovered/open failures, pending operations, retries, token usage, and price-data completeness.
- **Bounded Session history recovery** (@coda/coding-agent) — The `read_session_history` Tool pages through committed historical Messages with bounded, cursor-based windows and authoritative Observations without exposing pending Draft state.
- **Durable Sessions** (@coda/coding-agent) — Append-only workspace-scoped Sessions restore Messages, queues, Composer and Extension facts, Media Assets, Model selection, Tool Observations, and Compaction Checkpoints. Current Session format: v10.
- **Agent Skills** (@coda/skills) — Agent Skills-compatible validation, bounded project and global discovery, exact-revision activation, project-first collision handling, and immutable per-Run catalogs.
- **Terminal experience** (@coda/tui) — Full-screen semantic Timeline and Transcript View, CommonMark/GFM rendering, Thinking Blocks, a multiline Composer, Prompt History, Slash completion, and background Session activity.
- **User Shell Adapter and input queues** (@coda/coding-agent) — Explicit `!command` User Shell execution remains outside model Context and Session persistence; the CLI Adapter owns its local FIFO and submits Prompt, Steering, and Follow-up input through the public Work Item command seam.
- **Offline Agent evaluation harness** (@coda/evals) — Deterministic Faux Model fixtures score observable task behavior, acceptance checks, Tool recovery, repetition, compaction continuity, latency, tokens, and price data without network access.
- **Durable Work Graph orchestration** (@coda/runtime) — A closed submit/observe/close Interface coordinates durable Work Graphs, deterministic DAG scheduling, bounded parallel Work Items, isolated Worker Sessions and observations, ordered causal control, cancellation, recovery, structured results, and pluggable Direct or Git-worktree Workspace Publication while keeping serial Worker Runtimes private.

### Type-only (not runtime support)

- **Selected compatibility type closure** (@coda/ai) — Dormant OAuth, deferred-response, ModelsStore, alternate Provider, and other known-Api shapes remain expressible without promising runtime behavior. The manifest accounts for 29 exact type-only exports.

### Experimental/private

- **Application composition seams** (@coda/coding-agent) — The CLI and its source-level composition seams are private, have an empty npm export map, and carry no application SDK compatibility promise.
- **Experimental Skill metadata** (@coda/skills) — The standard parser preserves `allowed-tools`, but Coda deliberately does not interpret it as Tool, filesystem, process, or network authority.

### Explicitly deferred

- **Deferred model responses** (@coda/ai) — Fetching or cancelling deferred Provider responses has type-level representation but no supported OpenCode Go runtime implementation.
- **Additional AI runtimes** (@coda/ai) — Complete OAuth, image generation, Providers beyond OpenCode Go or explicit custom Providers, and Browser or Bun entries are not implemented.
- **Remote application interfaces** (@coda/coding-agent) — RPC, client/server mode, and a public Coding Agent SDK are not implemented.
- **Advanced editing** (@coda/tui) — Autocomplete, selection, clipboard protocols, redo, durable drafts, and syntax highlighting are not implemented.
- **Additional MCP primitives** (@coda/mcp) — Resources, Prompts, Roots, Sampling, Logging, complete OAuth, and legacy HTTP+SSE transport are outside the current MCP Host.
- **Advanced Session management** (@coda/coding-agent) — Session branching, rename, archive, and delete operations are not implemented.
- **Remote Skill distribution** (@coda/skills) — Remote Skill installation and registries are not implemented; discovery is local and caller-rooted.
- **Additional terminal input and image protocols** (@coda/tui) — General mouse UI, Sixel, iTerm2 graphics, multiplexer image passthrough, and a generic terminal-image protocol are not implemented.
<!-- coda:capabilities:end -->

Model File Tools accept Workspace-relative or explicit absolute paths. Model `bash`, `process_start`, native search helpers, and file mutation workers execute directly on the host as the current user; Shell and background processes inherit Coda's complete process environment. Long-running processes use opaque process-local identities with `process_poll`, `process_write`, and `process_stop`; they cannot be restored as live after restart.

Explicit interactive `!command` remains a separate direct-user entry point. It inherits the full environment, stays outside model Context and Session data, and uses bounded terminal-sanitized output, timeout, and process-group cancellation.
