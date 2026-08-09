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
asks the user to select a Model, and saves that selection. On macOS, persisted
Credentials use Keychain service `coda.cli.credentials.v1`; they are never
written to settings or Session files.

One-shot mode writes only the final assistant text to stdout:

```sh
coda --print --model opencode-go/<model-id> "explain this repository"
coda --print --image ./diagram.png "explain this image"
coda --print --json "run the configured Model and emit Agent events"
coda --no-tui "use print mode even when stdin and stdout are terminals"
```

`--no-tui` is an explicit alias for print mode. `--no-color` disables color only for the current Terminal instance; `NO_COLOR` is also honored without mutating the process environment. `--no-animations` selects reduced motion for one invocation.

Useful maintenance commands are `coda sessions` and `coda cleanup`.

The macOS pseudo-terminal E2E test launches the built CLI with an isolated home
and Workspace, then verifies full-screen entry, input, resize, signal exit,
Prompt-card geometry, multiline Editor input, Timeline wheel navigation, resize, signal exit,
protocol cleanup, cooked-mode restoration, and a post-exit shell sentinel
without making a model request:

```sh
npm run test:e2e
```

## Capabilities

- `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`
- Read Only, Workspace, and Full Access Permission Profiles with Unless Trusted, On Request, Granular, and Never Approval Policies
- exact filesystem, command-prefix, host-network, one-shot, process-local Session, and persistent-rule decisions
- OS-enforced macOS/Linux Sandbox execution for every model-started process and exact approved file mutation
- full-screen semantic Timeline with CommonMark/GFM Assistant and Thinking content
- Codex-inspired structured Tool Invocation presentation and Transcript View
- bounded image attachments with Kitty preview and system-viewer fallback
- Pi-style multiline Composer and matching sent-Prompt cards
- current-Session Prompt History with visual-row Up/Down navigation and exact draft restoration
- explicit `!command` User Shell mode with live bounded output and a mixed deferred FIFO
- durable Steering/Follow-up input queues with pause, resume, failure recovery, and Alt+Up reclaim
- append-only, workspace-scoped Session v5 resume with content-addressed Media Assets, Composer facts, and non-authorizing Permission audit facts
- stable JSONL v2 Agent events and opt-in media data
- deterministic per-Run System Prompt snapshots
- transient whole-Turn retry at 2s, 4s, and 8s

The Policy Gate resolves authority before a model Tool can run. Model `bash`, native search helpers, and file mutation workers enter `@coda/sandbox` unless the effective reviewed authority is Full Access or an exact command rule/escalation permits an unsandboxed invocation. An ordinary Sandbox denial is returned to the model and never retries outside the Sandbox automatically.

Explicit interactive `!command` remains a separate direct-user entry point: it bypasses model Tool approval and Sandbox, inherits the full environment, stays outside model Context and Session data, and uses bounded terminal-sanitized output, timeout, and process-group cancellation.

RPC, client/server mode, public SDK and extension contracts, compaction, Session
branching, autocomplete, selection, redo, durable drafts, syntax highlighting, and generic terminal-image
protocol support remain deferred.
