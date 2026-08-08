# Milestone 1 compatibility matrix

`@coda/ai@0.1.0` follows a selected compatibility profile derived from `@earendil-works/pi-ai@0.84.1` at commit `958c13f25080b59d4b736193f972a8502a7a2f8b`. This is not a whole-package drop-in compatibility claim.

The exact root type names, root runtime names, allowed subpaths, statuses, and conformance tests are versioned in [`manifest.v1.json`](./manifest.v1.json).

## Compatible surface

| Area | Milestone 1 contract |
| --- | --- |
| Core data | `Api`, `Provider`, `Model`, `Models`, `Context`, `Message`, `Tool`, and `Usage`, including their selected public type closure |
| Streaming | Assistant-message stream events, `EventStream`, direct/lazy streaming, cancellation, and terminal aggregation |
| Registry | `createProvider`, `createModels`, mixed-Api dispatch, auth application, and deterministic static refresh |
| Credentials | Injected `CredentialStore`, in-memory test store, explicit/stored/request-env/ambient-env priority |
| Validation | TypeBox/JSON Schema Tool declarations, conversion, coercion, and argument validation |
| Provider | OpenCode Go API-key authentication and the complete committed model snapshot |
| Wire APIs | `anthropic-messages`, `openai-completions`, and `openai-responses`, each with direct and lazy entry points |

Type-only placeholders preserve the selected signature closure for OAuth, deferred responses, other `KnownApi` values, and `ModelsStore`. Their presence does not advertise runtime support.

## Deliberate deviations

| Frozen Pi behavior | Coda behavior |
| --- | --- |
| Some direct streaming auth failures can throw synchronously. | Every public streaming path terminates with an error event. |
| Cancellation during lazy setup can be classified as an ordinary error. | A cancelled caller signal is always classified as `aborted`. |
| `EventStream.end()` can omit its result and leave `result()` pending. | A result is mandatory; omission produces an invariant failure. |
| Telemetry types come from another workspace package. | Equivalent local structural types keep `@coda/ai` a leaf package. |
| Provider catalog machinery depends on Pi workspace packages. | OpenCode Go uses a committed static snapshot and explicit fail-closed generator. |
| The default auth context can probe the host filesystem. | `fileExists()` is inert by default; a future caller may inject an explicit capability. |
| Streaming and retry helpers can acquire wall time, sleep, and randomness implicitly. | Public streaming paths require an explicit `TimeRuntime`; `createModels()` may supply it to registry-dispatched calls. |
| An unknown statusless stream failure may be treated as transient by downstream code. | Persisted Diagnostics mark only the documented HTTP statuses or known transport errors retryable; unknown failures fail closed. |

Coda also adds a structured Diagnostic to every non-cancellation stream failure without changing the Pi-compatible terminal event or `errorMessage` shape. Request-establishment retry retains Pi's status and backoff behavior, but its clock, sleep, and jitter sources are injected and SDK-native retries remain disabled.

## Excluded runtime capability

- `/compat` and the old process-global registry
- Providers other than OpenCode Go
- wire adapters other than the three listed above
- OAuth login, deferred responses, and dynamic runtime model catalogs
- image generation, Browser/Bun entries, Agent loops, and Tool execution
- whole-assistant-turn retry and `retryAssistantCall`
- filesystem, shell, Keychain, or on-disk credential persistence

## Test boundary

Default `npm test` uses deterministic Faux streams and mock HTTP/SSE only. The paid OpenCode Go smoke suite is excluded by the default Vitest configuration and has its own explicit command. The conformance suite never reads a local Pi checkout.
