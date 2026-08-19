# `@coda/coding-agent`

Coda's private terminal Coding Agent application. It composes `@coda/ai`,
`@coda/agent`, `@coda/runtime`, `@coda/tui`, `@coda/skills`, `@coda/mcp`,
`@coda/permission`, and `@coda/sandbox`. The package owns CLI and terminal
policy, host Adapters, durable Session storage, Model configuration,
Credentials, and application presentation; the headless Work Graph and Worker
Runtime policies live in `@coda/runtime`.

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

Typing `@` at the beginning of the Composer, or typing ` @` after existing
Prompt text, opens file completion scoped to the current Workspace. Candidates
are relative file paths; Tab or Enter inserts the selected `@path` followed by
a space. Coda excludes `.git`, `.coda`, and `node_modules` directories and does
not follow symbolic links outside the Workspace.

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
Visible core commands are `/auth`, `/model`, `/effort`, `/skills`, `/mcp`, `/hooks`, `/permissions`, `/session`, `/cancel-work`, `/new`, and `/follow-up`.
<!-- coda:core-commands:end -->

Selector commands open nested menus and do not accept
trailing arguments; `/mcp` instead accepts `status`, `doctor`, `inspect`,
`reload`, and `reconnect` operations.
`/effort` lists the Reasoning Effort levels supported by the current Model and
applies the selected level to future Runs in the Session. The selection is
translated for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses.
`/permissions` opens Codex's Update Model Permissions presets — Read Only, Ask
for approval, and Full Access — and applies the selected Approval Policy and
Process Confinement Mode to the current Session. Full Access asks for
confirmation first. `/cancel-work` cancels one child Work Item or the entire
Work Graph through Worker Control and does not claim to roll back Tool or
Publication side effects that already happened. Child Command Permission asks
and MCP Elicitations answer on the focused parent Session. `/follow-up` is
available only for a running Session, while unknown Slash text is submitted as
ordinary Prompt text.

Useful maintenance commands are `coda sessions` and `coda cleanup`. Run
`coda skills validate <path>` for strict Agent Skills validation without a Model
or Session.

Local Agent Skills are discovered only from `<Workspace>/.agents/skills` and
`~/.agents/skills`; Coda does not scan client-specific or ancestor directories.
The project root has deterministic precedence over the global root. Global Skills
are user-managed, and typing `$` shows project and global Skills for explicit
selection. A plain `$name` in print or interactive text injects that Skill for
the current Run. Coda does not make a separate Skill safety decision. Explicit
Composer Skill references are user-selected context; model-selected Skills use
the `skill` Tool to load exact-revision instructions. Skills marked
`disable-model-invocation: true` or Codex `policy.allow_implicit_invocation: false`
stay in the `$` palette and can be `$`-injected, but they are omitted from the
model catalog. `/skills` remains the sole Skill management command.

## Lifecycle Hooks

Coda supports Codex-compatible command hooks from `~/.coda/hooks.json` and
`<Workspace>/.coda/hooks.json`. User configuration is merged before Workspace
configuration. Every command handler is inert until its exact definition hash
is confirmed interactively or admitted with `--trust-hooks`; changing one
handler invalidates only that handler's trust record. `/hooks` shows installed
and active counts for every event, source paths, matchers, trust state, and
configuration diagnostics.

The implemented events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd`,
`SubagentStart`, and `SubagentStop`.
Command Permission hangs on `PreToolUse` and can resolve a hook
`permissionDecision:ask` before the runtime sees the outcome. Approval Policy
is `untrusted`, `on-request`, or `never` (`--ask-for-approval`). Interactive
mode defaults to `on-request` when no CLI or settings override is present.
`/permissions` changes that policy together with Process Confinement Mode for
the current Session. Print mode defaults Approval Policy to `never` and denies
unresolved asks, matching Codex exec. `--strict-permissions` keeps that deny
path when `--ask-for-approval` is set in print mode.
`SubagentStart` runs after a child's `run_started` Fact makes `running`
durable; `SubagentStop` runs when that child reaches a terminal Work Result.
Timing belongs to `@coda/runtime` Worker lifecycle; discovery, exact-handler
trust, and process execution stay here. Matcher input is the child's
`executionMode`. `PermissionRequest` remains a recognized configuration event
but is not executed.

```json
{
  "description": "Workspace policy and feedback",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|Process",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-tool-policy.sh",
            "timeout": 30,
            "statusMessage": "Checking workspace policy"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/verify-before-stop.sh"
          }
        ]
      }
    ]
  }
}
```

Commands run in the active Workspace directory, inherit Coda's environment,
receive one JSON object on stdin, and use the same output protocol as Codex.
Handlers selected for a synchronous event run concurrently. Exit code `2` plus
stderr blocks `PreToolUse` and `UserPromptSubmit`, replaces `PostToolUse`
feedback, or supplies a `Stop` continuation. JSON output can use the universal
`continue`, `stopReason`, and `systemMessage` fields. Event-specific
`hookSpecificOutput` supports prompt/context contributions and `PreToolUse`
`permissionDecision`, `permissionDecisionReason`, and `updatedInput`. An
`updatedInput` is validated against the actual Coda Tool schema before use.

`async: true` runs a handler in the background with at most eight active async
handlers per Session; completed output is offered at the next model-call safe
point. `SessionEnd` always runs synchronously, defaults to a one-second timeout,
and is capped at three seconds. Other handlers default to 600 seconds. `Bash`
is the hook-facing shell Tool name. Coda's `edit`, `write`, and `process` Tools
are exposed as `Edit`, `Write`, and `Process`.

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

Every admitted Tool is namespaced as `mcp__<server>__<tool>`. A Tool enters a
Run only when the user names it with `$` — `$search`, `$docs-search`,
`$mcp__docs__search`, or `$docs` for every Tool on that Server. Server
annotations do not change how Coda invokes the Tool. Form and URL Elicitation identify the requesting Server; Coda never
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
- **Agent runtime** (@coda/agent) — In-memory Runs and Turns, immutable events, Tool execution, cancellation, Steering and Follow-up queues, opt-in whole-Turn retry, and a public settleToolInvocation port for isolated lookup, validation, and execution.
- **Model access** (@coda/ai) — OpenCode Go and custom API-key Providers, streaming text, Thinking, Tool calls, structured Diagnostics, cancellation, and explicit model-catalog refresh. Custom Provider protocols: `openai.chatcompletions`, `openai.responses`, and `anthropic.messages`.
- **Built-in Tools** (@coda/coding-agent) — Workspace-relative and absolute-path reading, search, atomic single-file create-or-replace and exact-text edit, direct host Shell execution, and recoverable continuation of omitted Tool output. Built-ins: `read_session_history`, `read`, `read_tool_output`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and `process`.
- **Command Permission** (@coda/permission) — A leaf Approval Policy (untrusted, on-request, or never) decides allow, deny, or ask for one Tool Invocation using Codex's known-safe and dangerous-command rules. The Coding Agent adapter hangs on Lifecycle Hooks, resolves ask before the runtime, and can remember Session, Workspace, or user decisions. Interactive `/permissions` applies Codex approval presets for the current Session. Print mode defaults to never and denies unresolved asks.
- **Evidence-backed print completion** (@coda/coding-agent) — Print and JSON Runs emit a versioned completion disposition that keeps lifecycle, evidence completeness, local verification, and hidden-verifier scope separate, with one bounded repair Steering by default.
- **Durable Context Compaction** (@coda/runtime) — Private Worker Runtimes automatically compact at safe model-call boundaries and durably persist Tool-pair-safe Compaction Checkpoints before replacing the model-visible Context Window.
- **Secure platform Credential storage** (@coda/coding-agent) — API credentials use macOS Keychain or Linux Secret Service when available, never persist plaintext fallback secrets, redact helper failures, and otherwise remain process-local.
- **Lifecycle Hooks** (@coda/coding-agent) — Codex-compatible command Hooks cover Session, Prompt, Tool, Compaction, Stop, and SubagentStart/SubagentStop boundaries with exact-handler trust, concurrent matching, async delivery, Tool guarding and rewriting, and automatic Stop continuation. SubagentStart fires when a child Work Item enters running; SubagentStop fires at that child's terminal state.
- **MCP Host** (@coda/mcp) — MCP Tools over stdio and Streamable HTTP with version negotiation, Workspace trust, mention-gated Run admission, progress, cancellation, subscriptions, and form or URL Elicitation.
- **Media Assets** (@coda/coding-agent) — Bounded image Attachments use content-addressed Session storage, model-ready renditions, Kitty previews, and a system-viewer fallback.
- **Context Overflow fallback** (@coda/coding-agent) — After local and Provider overflow recovery is exhausted, interactive mode can open a fresh empty Session in the same Workspace without inheriting Messages, summaries, media, queues, Tool state, or Run evidence.
- **Process Confinement** (@coda/sandbox) — A leaf wrapScript seam confines Bash, User Shell, and Process Session scripts through Anthropic Sandbox Runtime in read-only or workspace-write mode. danger-full-access leaves the process on the host. File Tools, hook handlers, and credential helpers stay on the host.
- **Long-running process Sessions** (@coda/coding-agent) — Process-local background Shell Sessions execute directly on the host through one `process` Tool with start, poll, write, and stop actions, plus recoverable omitted output.
- **Prompt and event formats** (@coda/coding-agent) — Deterministic per-Run System Prompt snapshots and stable opt-in JSONL v2 Agent events with optional media data.
- **Custom Provider metadata** (@coda/coding-agent) — Custom Provider models retain configured context, output, image-input, reasoning, status, and tiered-cost metadata across settings, catalog refresh, selection, and runtime consumers.
- **Objective Run evidence** (@coda/coding-agent) — Completed Runs project bounded, sanitized evidence from lifecycle events, authoritative Tool Observations, generic mutation facts, and the final Git-visible Workspace diff, separating completeness, changed-path provenance, terminal/recovered/open failures, pending operations, retries, token usage, and price-data completeness.
- **Bounded Session history recovery** (@coda/coding-agent) — The `read_session_history` Tool pages through committed historical Messages with bounded, cursor-based windows and authoritative Observations without exposing pending Draft state.
- **Durable Sessions** (@coda/coding-agent) — Append-only workspace-scoped Sessions restore Messages, queues, Composer and Extension facts, Media Assets, Model selection, Tool Observations, Compaction Checkpoints, and generated Session Titles. Interactive resume can skip or explicitly re-execute a safe Interrupted Tool Invocation; replaySafety never stays skip-only and print fails closed. Current Session format: v11.
- **Agent Skills** (@coda/skills) — Agent Skills-compatible validation, bounded project and global discovery, exact-revision activation, project-first collision handling, immutable per-Run catalogs that hide slash-only Skills, and both automatic skill Tool loading and explicit `$` injection.
- **Terminal experience** (@coda/coding-agent) — Full-screen semantic Timeline and Transcript View, CommonMark/GFM rendering, Thinking Blocks, a multiline Composer, Prompt History, Slash command, explicit `$` Skill and MCP mentions, and Workspace-scoped `@` file mention completion, plus background Session activity. Parent Timeline and Activity project child Work Items under `delegate`.
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
- **PermissionRequest Hook** (@coda/coding-agent) — PermissionRequest remains a deferred hook event. Command Permission resolves ask on PreToolUse.
- **Remote application interfaces** (@coda/coding-agent) — RPC, client/server mode, and a public Coding Agent SDK are not implemented.
- **Advanced editing** (@coda/tui) — Autocomplete, selection, clipboard protocols, redo, durable drafts, and syntax highlighting are not implemented.
- **Additional MCP primitives** (@coda/mcp) — Resources, Prompts, Roots, Sampling, Logging, complete OAuth, and legacy HTTP+SSE transport are outside the current MCP Host.
- **Advanced Session management** (@coda/coding-agent) — Session branching, rename, archive, and delete operations are not implemented.
- **Remote Skill distribution** (@coda/skills) — Remote Skill installation and registries are not implemented; discovery is local and caller-rooted.
- **Additional terminal input and image protocols** (@coda/tui) — General mouse UI, Sixel, iTerm2 graphics, multiplexer image passthrough, and a generic terminal-image protocol are not implemented.
<!-- coda:capabilities:end -->

Model File Tools accept Workspace-relative or explicit absolute paths. Model `bash`, `process`, native search helpers, and file mutation workers execute as the current user; Shell and background processes inherit Coda's complete process environment. `--sandbox read-only|workspace-write|danger-full-access` or `settings.sandbox.mode` confines Bash, User Shell, and Process Session scripts through Process Confinement; File Tools, hook handlers, and credential helpers stay on the host. Unset Process Confinement Mode defaults to `danger-full-access` and leaves those scripts on the host. Bare `--sandbox` selects workspace-write. Long-running processes use the `process` Tool with opaque process-local identities; they cannot be restored as live after restart.

Explicit interactive `!command` remains a separate direct-user entry point. It inherits the full environment, stays outside model Context and Session data, and uses bounded terminal-sanitized output, timeout, and process-group cancellation. When Process Confinement Mode is `read-only` or `workspace-write`, User Shell scripts use the same `wrapScript` seam; `danger-full-access` leaves them on the host.
