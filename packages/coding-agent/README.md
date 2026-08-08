# `@coda/coding-agent`

Coda's private terminal Coding Agent application. It composes `@coda/ai`,
`@coda/tui`, and `@coda/agent` while owning application policy and all host
integration.

Status: private Milestone 1 implementation.

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
coda --print --json "run the configured Model and emit Agent events"
coda --no-tui "use print mode even when stdin and stdout are terminals"
```

`--no-tui` is an explicit alias for print mode. `--no-color` disables color only for the current Terminal instance; `NO_COLOR` is also honored without mutating the process environment.

Useful maintenance commands are `coda sessions` and `coda cleanup`.

The macOS pseudo-terminal E2E test launches the built CLI with an isolated home
and Workspace, then verifies that an ASCII prompt typed into the interactive UI
is rendered without making a model request:

```sh
npm run test:e2e
```

## Initial capabilities

- `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`
- interactive approval for protected/outside paths and Shell
- append-only, workspace-scoped Session resume
- stable JSONL Agent events
- deterministic per-Run System Prompt snapshots
- transient whole-Turn retry at 2s, 4s, and 8s

The Policy Gate is not a sandbox. Shell runs with host-user authority after
approval, with a minimal environment, bounded output, timeout, and process-group
cancellation.

RPC, client/server mode, public SDK and extension contracts, images, compaction,
Session branching, and rich editor features remain deferred.
