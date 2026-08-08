# `@coda/ai` Milestone 1 Compatibility Matrix

Status: Confirmed — Milestone 1 compatibility baseline

## Baseline

- Source package: `/Users/zp/Desktop/pi/packages/ai`
- Source identity: `@earendil-works/pi-ai@0.84.1`
- Source commit: `958c13f25080b59d4b736193f972a8502a7a2f8b`
- Scope: selected root exports plus the OpenCode Go Provider and its three Api adapters

This matrix defines a selected compatibility profile. It does not claim that `@coda/ai` is a package-wide drop-in replacement.

## Selected root type surface

The following names are inside the selected domain surface, together with the supporting types needed to preserve their public signatures:

| Group | Names |
| --- | --- |
| Api identity | `Api`, `KnownApi`, `ProviderId`, `KnownProvider` |
| Model data | `Model`, `ModelCost`, `Usage`, the three selected Api compatibility metadata types |
| Conversation | `Context`, `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`, content-block and tool-call types |
| Tools | `Tool`, `ConstrainedSamplingConfig`, TypeBox `Static` and `TSchema` |
| Streaming | `AssistantMessageEvent`, `AssistantMessageEventStream`, `StopReason`, stream option and function types |
| Provider runtime | `Provider`, `ProviderStreams`, `Models`, `MutableModels`, creation and request option types |
| Authentication | API-key Credential, store, auth-context, interaction, result, and operation types required by the selected signatures |
| Faux testing | Faux model, content, response-step, state, handle, and Provider types required by the selected root helpers |

Important baseline facts:

- `Api` is an open string type, not a closed union of the three implemented Api values.
- A Pi-compatible `Model.compat` is a conditional type, not arbitrary metadata.
- `Usage.output` already includes reasoning tokens.
- `Tool.parameters` uses TypeBox `TSchema`.
- The Pi root does not export global `stream`, `complete`, `streamSimple`, or `completeSimple` functions; those globals belong to the excluded `/compat` entry point.

## Selected root runtime surface

| Area | Names |
| --- | --- |
| Registry | `createModels`, `createProvider`, `ModelsError` |
| Streams | `EventStream`, `createAssistantMessageEventStream`, `lazyStream`, `lazyApi` |
| Credentials | `InMemoryCredentialStore`, `defaultProviderAuthContext`, `envApiKeyAuth` |
| Tool schema | `Type`, `validateToolCall`, `validateToolArguments` |
| Faux Provider | `fauxText`, `fauxThinking`, `fauxToolCall`, `fauxAssistantMessage`, `createFauxCore`, `fauxProvider` |

## Required subpaths

| Coda subpath | Required surface |
| --- | --- |
| `@coda/ai/providers/opencode-go` | `opencodeGoProvider()` with id `opencode-go`, name `OpenCode Go`, API-key auth, generated Models, and three-Api lazy dispatch |
| `@coda/ai/providers/opencode-go.models` | generated `OPENCODE_GO_MODELS` |
| `@coda/ai/api/anthropic-messages` | Api-specific options plus `stream` and `streamSimple` |
| `@coda/ai/api/anthropic-messages.lazy` | `anthropicMessagesApi()` |
| `@coda/ai/api/openai-completions` | Api-specific options, `stream`, `streamSimple`, and `convertMessages` |
| `@coda/ai/api/openai-completions.lazy` | `openAICompletionsApi()` |
| `@coda/ai/api/openai-responses` | Api-specific options plus `stream` and `streamSimple` |
| `@coda/ai/api/openai-responses.lazy` | `openAIResponsesApi()` |

The export map must enumerate intended files. A broad `providers/*` or `api/*` wildcard would accidentally publish helper modules and expand the compatibility promise.

## Type closure versus runtime capability

- Selected root types retain their transitive Pi-compatible type closure.
- Type-only OAuth, deferred, `ModelsStore`, other `KnownApi`, and related option shapes remain present.
- Only OpenCode Go API-key auth and three Api adapters are runtime capabilities.
- OpenCode Go OAuth login explicitly reports unsupported.
- A static Provider refresh completes deterministically without network I/O.
- Unsupported deferred operations retain the Pi-style `ModelsError` code `provider`.
- Telemetry is the single type-source deviation: Coda defines a local, structurally assignable `TelemetryContext` family rather than importing a Coda workspace package.

The local telemetry types preserve recursive `startSpan<T>()`, span events, attributes, status, and callback/Promise shapes. Pi's M1 adapters only pass this value through; they do not create spans.

## Confirmed behavior

| Contract | Frozen Pi behavior |
| --- | --- |
| Stream terminal | The first `done` or `error` event settles `result()` with an `AssistantMessage`; failures and cancellation do not reject `result()`. |
| Event ordering | The terminal event remains visible to the async iterator; pushes after terminal are ignored. |
| Completion reasons | Successful terminal reasons are `stop`, `length`, `toolUse`, or `deferred`; failed reasons are `error` or `aborted`. |
| Adapter exceptions | Request and parse failures become a terminal error event. If the caller signal is aborted during adapter execution, the reason is `aborted`; an SDK timeout alone is `error`. |
| Lazy setup | Auth, Provider lookup, and lazy-import failures are converted into terminal error events. |
| Tool validation | Arguments are cloned, TypeBox conversion and plain-schema coercion run, and validation failures throw an ordinary `Error` containing paths and original JSON. |
| Credential resolution | Request key → stored Provider Credential → request environment → ambient environment. An incompatible stored Credential does not fall through. |
| SDK retry | All three upstream SDK calls disable SDK-owned retry. |

## Deliberate stream deviations

| Frozen Pi defect | Coda behavior |
| --- | --- |
| Direct `streamSimple()` may throw synchronously for missing auth while lazy/Models paths emit a terminal error. | Every public streaming path emits a terminal error. |
| Cancellation during lazy auth/setup is classified as `error`. | An aborted caller signal produces `aborted` in every phase. |
| `end()` without a result can leave `result()` pending forever. | `end()` requires a result; runtime misuse produces an explicit invariant failure. |
| `defaultProviderAuthContext().fileExists()` probes the host filesystem. | The default implementation returns `false`; a caller must explicitly inject filesystem capability. |

## `ModelsError` baseline

The frozen code union contains `model_source`, `model_validation`, `provider`, `stream`, `auth`, and `oauth`. Operational methods may reject with a `ModelsError`; stream setup converts failures to an assistant error Message and therefore exposes only error text, not the structured code.

The exact error event is `{ type: "error", reason: "aborted" | "error", error: AssistantMessage }`. A failed `AssistantMessage` has `stopReason` and `errorMessage`, with optional diagnostics, but no required structured code or cause.

### Coda structured-error policy

Coda keeps that event shape and `errorMessage`, but every non-cancellation stream failure also attaches a Diagnostic. It preserves available error code, phase, Provider, Api, HTTP status, and retryability; uses the injected Clock; and omits stack traces from persisted Messages unless debug policy explicitly enables them. Caller cancellation is represented only by `aborted`.

## Direct dependency baseline

| Package | Frozen version | M1 purpose |
| --- | --- | --- |
| `@anthropic-ai/sdk` | `0.91.1` | Anthropic Messages transport |
| `openai` | `6.26.0` | OpenAI Completions and Responses transports |
| `partial-json` | `0.1.7` | partial streamed Tool argument parsing |
| `typebox` | `1.3.7` | public Tool schemas and argument validation |

All direct versions are exact. SDK-owned retry is disabled.

## Retry ownership

- `@coda/ai` retains Pi-compatible request-establishment retry through `maxRetries` and `maxRetryDelayMs`, defaulting to zero retries.
- It preserves retry headers/status classification, server delay precedence, exponential jitter, delay cap, and AbortSignal handling.
- It never retries after stream consumption begins.
- Whole-assistant-call retry belongs to `@coda/agent` and Pi's root `retryAssistantCall` helper is excluded from Milestone 1.

## Deliberate exclusions

- `/compat` and its global registry/functions
- image-generation registry and image-provider APIs
- Providers and Api adapters other than OpenCode Go and its selected three
- OAuth login behavior and UI
- runtime dynamic catalog refresh
- deferred execution behavior
- Browser/Bun-specific entries
- Bedrock registration
- session resource cleanup
- the Pi telemetry workspace dependency
- broad helper families such as diagnostics, JSON repair, overflow, retry, text, and UUID unless an included implementation needs them internally

An excluded helper may exist as a private implementation detail without becoming a public compatibility promise.

## Executable manifest rule

A versioned machine-readable manifest labels every root type export, root runtime export, and permitted subpath as `compatible`, `deliberate-deviation`, `type-only`, or `excluded`, with a link to its conformance test. Compile, runtime-import, export-map, and deliberate-deviation tests enforce it without reading the Pi checkout.

## Minimum offline conformance suites

- compile-time export and public-signature tests
- Models registry, mixed-Api dispatch, auth precedence, header/environment merge, and refresh-result tests
- EventStream terminal, error, cancellation, and ordering tests
- TypeBox and plain JSON Schema conversion/coercion tests
- modern Faux Provider event and cancellation tests without the excluded compat registry
- Anthropic SSE, partial tool JSON, stop-detail, and unknown-event tests
- OpenAI Completions terminal, reasoning, thinking, `max_tokens`, and retry-disable tests
- OpenAI Responses completed, incomplete, failed, and missing-terminal tests
- new coverage for exact tool-name lookup, timeout classification, direct-versus-lazy missing-auth behavior, and export-map boundaries

Ported assertions must cite their upstream file and the frozen commit. Tests themselves must run without access to the Pi checkout.
