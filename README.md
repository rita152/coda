# Coda

Coda is a private, local-first terminal Coding Agent for daily work on local
codebases. The repository is an ESM TypeScript monorepo running on Node.js
22.19 or newer.

## Current shape

The product supports a full-screen interactive terminal and one-shot text or
JSON execution. A serial `@coda/agent` kernel runs inside isolated Worker
Runtimes; `@coda/runtime` coordinates durable, Workspace-scoped Work Graphs,
bounded parallel Work Items, recovery, and Workspace Publication. The private
`@coda/coding-agent` package supplies the CLI, terminal application, host
Adapters, durable Session storage, Model configuration, Skills, MCP, and coding
Tools, and composes Command Permission and Process Confinement from
`@coda/permission` and `@coda/sandbox`. The focused parent Session's Timeline,
Transcript View, Activity, Command Permission, and MCP Elicitation cover child
Work Items in the active Graph; Worker-private child Sessions stay off
`/session`.

The generated [capability manifest](./capabilities.v1.json) is the authoritative
inventory of supported, type-only, experimental, and deferred behavior. Its
human-readable projection is in the
[`@coda/coding-agent` README](./packages/coding-agent/README.md#capabilities).

## Workspace packages

| Package | Responsibility |
| --- | --- |
| `@coda/ai` | Provider-neutral Model APIs and streaming |
| `@coda/agent` | Serial in-memory Agent kernel and neutral Session contract |
| `@coda/runtime` | Headless Work Graph and Worker Runtime orchestration |
| `@coda/tui` | Application-neutral terminal primitives |
| `@coda/skills` | Agent Skills parsing, discovery, and activation |
| `@coda/mcp` | MCP client protocol and connection runtime |
| `@coda/plugins` | Agent Plugins 1.0.0 package validation and portable component discovery |
| `@coda/permission` | Command Permission policy for one Tool Invocation |
| `@coda/sandbox` | Process Confinement for one Shell script |
| `@coda/coding-agent` | Private CLI application and host composition |
| `@coda/evals` | Offline and opt-in DeepSWE evaluation harnesses |

The executable dependency policy lives in
[`scripts/boundary-rules.mjs`](./scripts/boundary-rules.mjs) and is checked by
`npm run boundaries`.

## Local development

```sh
npm install
npm run build
node_modules/.bin/coda
```

Repository gates:

```sh
npm run check
npm test
npm run test:e2e
npm run eval:offline
```

Provider-backed tests and DeepSWE runs are separate, explicit, paid opt-ins;
they are not part of the default gates.

## Documentation map

- [Domain language](./CONTEXT.md) defines the vocabulary used by code, tests,
  issues, and architecture records.
- [Architecture decisions](./docs/adr/) record accepted decisions and explicit
  supersession.
- Package READMEs describe current package seams and operation.
- [Local issues and specs](./docs/agents/issue-tracker.md) live under
  `.scratch/`; resolved entries are historical implementation records, not
  current runtime documentation.
- Files under [`docs/research`](./docs/research/) are dated research snapshots.
