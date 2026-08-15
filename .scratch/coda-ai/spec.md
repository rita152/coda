# `@coda/ai` Milestone 1 Compatibility Spec

Status: implemented

Historical compatibility implementation record. Offline verification completed
on 2026-08-08; the paid smoke remains intentionally unverified. The maintained
profile is [`manifest.v1.json`](../../packages/ai/compatibility/manifest.v1.json),
with its readable projection in the
[`@coda/ai` compatibility README](../../packages/ai/compatibility/README.md).
The acceptance text below records the frozen implementation baseline.

## Objective

Create the provider-neutral AI foundation for Coda. The package is the first layer of a local-first terminal Coding Agent, not a standalone generic SDK product, while retaining a strict boundary suitable for later public npm distribution.

## Frozen reference

- Repository: `/Users/zp/Desktop/pi`
- Package: `/Users/zp/Desktop/pi/packages/ai`
- Package identity at the baseline: `@earendil-works/pi-ai@0.84.1`
- Commit: `958c13f25080b59d4b736193f972a8502a7a2f8b`
- Policy: later Pi changes do not enter the Coda contract until deliberately reviewed and adopted.

## Milestone 1 compatibility profile

The profile includes the agreed public types, API shape, and observable behavior for:

- `Api`, `Provider`, `Model`, and `Models`
- `Context`, `Message`, `Tool`, and `Usage`
- assistant-message stream events and `EventStream`
- `createProvider` and `createModels`
- credential interfaces and resolution
- TypeBox/JSON Schema tool declarations and argument validation
- the OpenCode Go Provider
- `anthropic-messages`, `openai-completions`, and `openai-responses`

The profile is not a package-wide drop-in compatibility claim.

The evolving name-by-name and behavior-by-behavior audit is maintained in [`compatibility-matrix.md`](./compatibility-matrix.md).

### Compatibility interpretation

- The selected core types retain their complete transitive public type closure even when some represented capabilities are not implemented in Milestone 1.
- OAuth, other `KnownApi` values, deferred members, `ModelsStore`, and related option types remain expressible without becoming supported OpenCode Go behavior.
- Runtime capability is stated separately: only three Api adapters, API-key authentication, static Provider refresh, and unsupported deferred operations are promised.
- OpenCode Go OAuth login fails explicitly as unsupported.
- Unsupported deferred operations produce the Pi-compatible `ModelsError` with code `provider`.
- A static Provider `refresh()` completes deterministically without catalog network I/O.
- Telemetry replaces Pi's workspace type import with a recursively structure-compatible local type.

## Explicit exclusions

Milestone 1 does not include:

- the `/compat` entry point or legacy global registry
- image generation
- Providers other than OpenCode Go, apart from deterministic test doubles
- Pi's multi-source model generation pipeline and runtime catalog refresh system
- deferred responses
- whole-assistant-call retry and Pi's public `retryAssistantCall` helper
- Browser or Bun support
- Pi's telemetry workspace dependency
- a complete Agent loop
- tool execution
- filesystem, shell, macOS Keychain, or on-disk credential access
- Pi's release pipeline and Coding Agent-specific repository checks

## Required domain seams

- An `Api` is a wire protocol, not a Provider.
- A `Provider` owns authentication declarations, model availability, and streaming implementations.
- A `Model` is serializable data that refers to both a Provider and an Api.
- `Models` is a runtime registry and dispatcher, not merely an array of Model values.
- `@coda/ai` declares and validates Tools but never executes them.
- A caller injects credential persistence through `CredentialStore`; `@coda/ai` may resolve explicitly supplied credentials and environment variables.
- `@coda/ai` has no dependency on another Coda workspace package.

## OpenCode Go authentication

OpenCode Go supports API-key authentication only in Milestone 1. Credential resolution preserves the frozen Pi behavior, in descending priority:

1. `options.apiKey` supplied for one request
2. an `opencode-go` Credential obtained from `CredentialStore`
3. `options.env.OPENCODE_API_KEY`
4. ambient `process.env.OPENCODE_API_KEY`

An incompatible stored Credential is an error and does not silently fall back to an environment variable.

## Model catalog generation

- `models:update` explicitly fetches OpenCode Go model metadata from models.dev.
- The validated generated snapshot is committed to Git.
- Ordinary `build` is offline and consumes only the committed snapshot.
- Generated data lives in `packages/ai/src/providers/data/opencode-go.json` with provenance in `packages/ai/src/providers/data/manifest.json`.
- `packages/ai/src/providers/opencode-go.models.ts` is a stable, hand-written typed wrapper rather than generated source.
- JSON output is deterministically ordered and formatted for review.
- `models:update` prints and saves a human-readable added/removed/rerouted summary.
- The generator must retain Pi-compatible routing for all three supported Api values and the OpenCode Go-specific metadata corrections covered by the compatibility profile.
- Coda will not port Pi's complete multi-provider, multi-source generation subsystem.
- Refresh writes into a temporary location, then filters, corrects, schema-validates, and records provenance before atomically replacing the previous snapshot.
- Any network, parsing, schema, routing, or validation error fails the refresh without modifying the previous snapshot. Partial catalogs and silent cache fallback are forbidden.
- The generation rules and runtime behavior are frozen by the compatibility profile; the Model list is not. Every refresh is a reviewable change recording fetch time, ETag, SHA-256, additions, removals, and routing changes.
- An unknown wire Api or upstream provider mapping fails closed rather than being guessed.

### Observed upstream snapshot (not a frozen contract)

A read-only fetch of `https://models.dev/api.json` at `2026-08-08T05:02:15Z` returned ETag `"da009ab433d133752912b6163265b178"` and body SHA-256 `da009ab433d133752912b6163265b17807ecd33c4da67a78fbd94817d5e74da1`.

- OpenCode Go supplied 24 model records.
- Pi's current filtering would exclude 6 deprecated records and retain 18.
- The retained records route as 4 `anthropic-messages`, 12 `openai-completions`, and 2 `openai-responses` Models.
- This snapshot came from the network and is not data stored in the frozen Pi commit.

## Source provenance

- Coda selectively ports only the Pi AI contracts, complex stream behavior, adapters, and tests needed by the compatibility profile.
- Coda does not begin from a wholesale copy of the Pi AI package.
- Files containing copied or substantially derived Pi code retain the applicable MIT copyright and license notice.
- Ported tests identify their upstream source and frozen baseline.
- Coda itself is MIT licensed; Pi attribution is also collected in `THIRD_PARTY_NOTICES.md`.

Copied or substantially derived TypeScript files use this header:

```ts
// Portions derived from Pi:
// /packages/ai/<source-path> @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.
```

Ported tests also cite the upstream test path at file or `describe` scope. Files that borrow only an idea, without copying expression, do not claim to be derived.

## Api adapter dependencies

- `anthropic-messages` uses `@anthropic-ai/sdk@0.91.1`, matching the frozen Pi baseline.
- `openai-completions` and `openai-responses` use `openai@6.26.0`, matching the frozen Pi baseline.
- Tool-call streaming JSON uses `partial-json@0.1.7`; public tool schemas use `typebox@1.3.7`.
- Direct SDK dependencies are precisely pinned and loaded lazily.
- SDK-provided retries are disabled.

## Request retry

- `@coda/ai` owns only retry of request establishment, not replay of a complete assistant turn.
- `maxRetries` defaults to `0`; total request attempts are `1 + maxRetries`.
- `maxRetryDelayMs` retains the Pi-compatible server-delay cap semantics.
- Retry classification preserves explicit `x-should-retry`, HTTP 408/409/429/5xx, missing status, and non-retryable client errors.
- Delay precedence is `retry-after-ms`, `Retry-After`, then capped exponential backoff with downward jitter.
- Backoff is abortable.
- Failures after a response stream has begun become terminal stream errors and are not silently replayed by `@coda/ai`.
- Whole-turn retry belongs to `@coda/agent`, where transcript state, Tool idempotency, and cancellation are visible; its policy and defaults are decided with that package.

## Stream contract

A model invocation emits:

```text
start
→ interleavable text/thinking/tool-call start|delta|end events
→ exactly one done | error event
```

- `contentIndex` associates interleaved events with their content blocks.
- Request, authentication, lazy-loading, and Provider setup failures become terminal stream errors rather than rejected request promises.
- Cancellation in any phase settles the stream with reason `aborted` when the caller signal is aborted.
- Direct adapter calls and calls routed through Provider/Models share the same terminal-error behavior for missing authentication.
- `end()` requires a result. Omitting it causes an explicit invariant failure rather than an indefinitely pending `result()`.
- Aggregating a completed stream produces the final assistant Message.

## Structured error diagnostics

- The Pi-compatible terminal event and `AssistantMessage` shapes remain unchanged.
- Every Coda stream failure retains the human-readable `errorMessage` and adds a Diagnostic.
- `diagnostic.error.code` carries a `ModelsError` code or a stable SDK/provider error code when one exists.
- Diagnostic details include phase, Provider, Api, HTTP status when known, and retryability.
- Diagnostic timestamps use the injected Clock.
- Persisted Messages omit stack traces by default; an explicit debug policy may retain them.
- Normal caller cancellation uses `stopReason: "aborted"` without an error Diagnostic.

## Test policy

- A deterministic Faux Provider covers core streaming, tool calls, errors, and cancellation.
- Mock HTTP/SSE tests cover each of the three OpenCode Go wire Api adapters.
- The mocked compatibility matrix includes `minimax-m3`, `hy3`, and `gpt-5.6-luna` as one representative per Api, plus `minimax-m2.7`, `qwen3.6-plus`, and `kimi-k2.6` as OpenCode Go correction sentinels.
- Live OpenCode Go smoke tests are opt-in and require `OPENCODE_API_KEY`.
- The live smoke matrix invokes only `minimax-m3`, `hy3`, and `gpt-5.6-luna`, one per Api.
- Default `npm test` and CI never issue real model requests.
- Tests must not require `/Users/zp/Desktop/pi` to exist at execution time.
- `@coda/ai` exposes every Model retained by the generated snapshot and chooses no default Model.

## Repository and runtime constraints

- npm workspaces
- Node.js `>=22.19`
- ESM-only packages
- strict TypeScript with NodeNext module resolution
- Biome for formatting and linting
- Vitest for package tests
- independent build and test scripts in each package
- root scripts orchestrate only packages that currently exist
- ordinary builds are offline; model refresh is an explicit command
- all public Coda packages use lockstep versions, beginning before `1.0`
- one root `CONTEXT.md` remains authoritative for the product language

## Package topology

- Only `@coda/ai` carries a Pi compatibility promise.
- `@coda/tui`, `@coda/agent`, and `@coda/coding-agent` use Pi as design research but define Coda-owned public contracts.
- `@coda/ai` and `@coda/tui` have no dependencies on Coda workspace packages.
- `@coda/agent` depends only on `@coda/ai` among Coda packages.
- `@coda/coding-agent` composes `@coda/ai`, `@coda/tui`, and `@coda/agent`.
- The implementation order `ai → tui → agent → coding-agent` is not a dependency chain between TUI and Agent.
- `@coda/tui` owns only Terminal abstraction, ANSI rendering, layout, input routing, focus/overlay behavior, and generic components. It knows nothing about models, sessions, credentials, Coda directories, or Coding Agent policy.
- The first TUI targets Node.js terminals on macOS and Linux; real terminal access remains behind a replaceable Terminal implementation.
- `@coda/agent` takes the mature Pi `Agent + StreamFn` behavior as its executable reference while selectively researching useful ideas in the in-progress Harness design. Unfinished Harness APIs do not become Coda contracts merely because Pi plans to migrate toward them.
- Models, streams, Credentials, keybindings, settings, clocks, and ID generators enter through constructors or explicit factories.
- Importing a Coda package must not mutate process-global behavior.

Detailed upper-layer drafts live in [`../coda-tui/spec.md`](../coda-tui/spec.md) and [`../coda-agent/spec.md`](../coda-agent/spec.md).

## Publication gate

Local development uses the `@coda/*` names. The root package and `@coda/ai@0.1.0` both remain private initially, while `npm pack --dry-run` verifies package contents. Public publication remains blocked until an authenticated npm account proves publish access to the `@coda` scope; if access is unavailable, all package names change together before the first public release. Removing the package-level private flag and adding public publish configuration requires a separate reviewed change.

## Executable compatibility manifest

The package will maintain a versioned machine-readable manifest alongside the human compatibility matrix. Each root type export, root runtime export, and allowed subpath is labeled `compatible`, `deliberate-deviation`, `type-only`, or `excluded` and points to its conformance test.

The conformance suite compiles selected consumer examples, imports every selected runtime export, verifies the package export map has no accidental additions or omissions, and exercises every deliberate deviation. It never reads the local Pi checkout.

## Open decisions

The compatibility profile has no unresolved implementation decision. Authenticated npm ownership remains an external publication gate and does not block private local development.

## Planned implementation slices

1. Repository foundation: npm workspace, shared TypeScript/Biome/Vitest, private manifests, and build/check/test/pack commands.
2. Compatibility foundation: machine manifest, compile/export conformance, and selected core type closure.
3. Core runtime: EventStream, Diagnostics, validation, and Faux Provider.
4. Registry and auth: CredentialStore, ModelsError, `createProvider`, and `createModels`.
5. Model catalog: explicit refresh command, provenance manifest, and committed OpenCode Go snapshot.
6. `openai-completions` adapter and mock contracts.
7. `anthropic-messages` adapter and mock contracts.
8. `openai-responses` adapter and mock contracts.
9. OpenCode Go Provider assembly, full offline conformance, export audit, and pack dry-run.
10. Only after a separate, contemporaneous user approval, one live smoke invocation per Api. Merely finding `OPENCODE_API_KEY` never authorizes a paid request.

Milestone 1 requires a clean checkout to build, check, test, and pack offline; a completely accounted compatibility manifest; no accidental subpath; fail-closed model refresh; and expected package contents. Without authorization for paid model requests, live smoke remains explicitly unverified rather than being inferred from mocks.

## Offline verification

Verified on 2026-08-08:

- `npm run check`: strict TypeScript and Biome passed.
- `npm test`: 19 offline test files and 83 tests passed; the live directory was excluded by configuration.
- `npm run build`: the workspace built without catalog network access.
- all nine package export-map entries imported successfully from `dist`.
- `npm run pack:dry-run`: 137 expected files, including licenses, compatibility records, model provenance, and generated runtime assets.
- the executable manifest accounts for 20 root runtime exports and 130 root type exports.

The opt-in OpenCode Go smoke suite exists under `test/live/` and was not run.
