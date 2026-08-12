# `@coda/coding-agent`

Coda's private terminal Coding Agent application. It composes `@coda/ai`,
`@coda/tui`, and `@coda/agent` while owning application policy and all host
integration.

Status: private Milestone 1 plus full-screen visual-refresh implementation.

This package is a CLI application, not an application SDK. Its npm export map is intentionally empty; composition seams under `src/` are private and may change without compatibility guarantees.

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

One-shot mode writes only the final assistant text to stdout:

```sh
coda --print --model opencode-go/<model-id> "explain this repository"
coda --print --image ./diagram.png "explain this image"
coda --print --json "run the configured Model and emit Agent events"
coda --no-tui "use print mode even when stdin and stdout are terminals"
```

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

Interactive command Approval Requests use the Codex bottom-pane layout with the
first choice selected. Use Up/Down and Enter, `y` or `1` for one-time approval,
or `p` and its displayed number for an eligible process-local command-prefix
approval. Choices are numbered sequentially, so denial is `2` when no prefix is
available and `3` when one is. The feedback choice or Escape cancels the Run and
returns focus to the Composer; Ctrl-C does the same. Pasted input never approves
a request. The Composer's borderless upper list exposes `/permission`, `/auth`,
`/model`, `/effort`, `/skill`, `/mcp`, `/session`, `/new`, and the running-Session-only
`/follow-up` action. Selector commands open nested menus and do not accept
trailing arguments; `/mcp` instead accepts `status`, `doctor`, `inspect`,
`reload`, and `reconnect` operations.
`/effort` lists the Reasoning Effort levels supported by the current Model and
applies the selected level to future Runs in the Session. The selection is
translated for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses.
`/permissions` remains a hidden compatibility alias, `/skills` is a hidden
management view, while `/approvals` and `/attach` are ordinary Prompt text.

Useful maintenance commands are `coda sessions` and `coda cleanup`. Run
`coda skills validate <path>` for strict Agent Skills validation without a Model
or Session.

Local Agent Skills are discovered only from `<Workspace>/.agents/skills` and
`~/.agents/skills`; Coda does not scan client-specific or ancestor directories.
The project root has deterministic precedence over the global root. Global Skills
are user-managed, and project Skills are shown directly in `/skill` for the user
to select. Coda does not make a separate Skill safety decision. Explicit Composer
Skill references are user-selected context; model-selected Skills use the `skill`
Tool and the active Skill Approval policy.

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

Every admitted Tool is namespaced as `mcp__<server>__<tool>`, frozen for one
Run, and independently permission-gated. Server annotations do not grant
authority. Form and URL Elicitation identify the requesting Server; Coda never
prefetches or opens an Elicitation URL. Print mode declines Elicitation.
Use `/mcp status`, `/mcp doctor`, `/mcp inspect`, `/mcp reload`, and
`/mcp reconnect` for read-only inspection and operational control.

The macOS pseudo-terminal E2E test launches the built CLI with an isolated home
and Workspace, then verifies full-screen entry, input, resize, signal exit,
Prompt-card geometry, multiline Editor input, Timeline wheel navigation, resize, signal exit,
protocol cleanup, cooked-mode restoration, and a post-exit shell sentinel
without making a model request:

```sh
npm run test:e2e
```

## Capabilities

- `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, and process lifecycle Tools
- Read Only, Workspace, and Full Access Permission Profiles with Unless Trusted, On Request, Granular, and Never Approval Policies
- exact filesystem, command-prefix, host-network, one-shot, process-local Session, and persistent-rule decisions
- one canonical Read Access Policy for native File Tools and model-started processes, with reviewed external roots and protected Credential Roots
- appearance-aware Codex-layout command Approval Bar with safe prefix grants, cancel-to-feedback, and compact Tool Timeline audit
- OS-enforced macOS/Linux Sandbox execution for every model-started process and exact approved file mutation
- full-screen semantic Timeline with type-aware main-view rhythm, CommonMark/GFM Assistant content, and full dim-italic Thinking content
- source-pinned Codex-aligned main-view Tool/Explored presentation and a dense full-detail Transcript View
- bounded image attachments with Kitty preview and system-viewer fallback
- Pi-style multiline Composer and matching sent-Prompt cards
- current-Session Prompt History with visual-row Up/Down navigation and exact draft restoration
- source-labelled, case-insensitive Slash completion with Pi-style borderless upper lists and shared nested command flows
- global Provider authentication and Custom Provider discovery across the three supported Api protocols
- per-Session Model and Permission selection with immutable Model/Credential/Permission snapshots for each Run
- workspace-scoped concurrent Session runtimes with focus switching and background progress
- explicit `!command` User Shell mode with live bounded output and a mixed deferred FIFO
- durable Steering/Follow-up input queues with pause, resume, failure recovery, and Alt+Up reclaim
- append-only, workspace-scoped Session v6 resume with content-addressed Media Assets, Composer/Extension facts, selected high-level Permission Profile, and non-authorizing Permission audit facts
- stable JSONL v2 Agent events and opt-in media data
- deterministic per-Run System Prompt snapshots
- Agent Skills standard validation and official compatible loading from project/global `.agents/skills`, with bounded discovery, exact-revision activation, project-first collision handling, and immutable per-Run catalogs
- MCP 2026-07-28 Host/Client Tools over stdio and Streamable HTTP, with legacy negotiation, exact Workspace configuration trust, immutable per-Run catalogs, subscriptions, cancellation, progress, and form/URL Elicitation
- transient whole-Turn retry at 2s, 4s, and 8s

The Policy Gate resolves authority before a model Tool can run. Native File Tools and model-started processes share one canonical Read Access Policy. Model `bash`, `process_start`, native search helpers, and file mutation workers enter `@coda/sandbox` for every restricted Permission Profile; only Full Access bypasses the outer Sandbox. An ordinary Sandbox denial is returned to the model and never retries outside the Sandbox automatically. Workspace-external authority uses a precise Additional Permission or, for native File Tools, an explicit filesystem Approval Request. Long-running processes use opaque process-local identities with `process_poll`, `process_write`, and `process_stop`; they cannot be restored as live after restart.

Explicit interactive `!command` remains a separate direct-user entry point: it bypasses model Tool approval and Sandbox, inherits the full environment, stays outside model Context and Session data, and uses bounded terminal-sanitized output, timeout, and process-group cancellation.

RPC, client/server mode, public SDK, remote Skill installation/registries, MCP Resources, Prompts, complete OAuth, legacy HTTP+SSE, compaction,
Session branching, rename/archive/delete, redo, durable drafts, syntax highlighting,
and generic terminal-image protocol support remain deferred.
