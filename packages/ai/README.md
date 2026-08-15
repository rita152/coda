# `@coda/ai`

Provider-neutral model access for Coda. The package implements a deliberately
selected, versioned Pi AI compatibility profile; it is not a claim that the
whole Pi package can be replaced directly.

## Runtime capability

- OpenCode Go with API-key authentication
- `anthropic-messages`, `openai-completions`, and `openai-responses`
- streaming text, reasoning, and tool calls
- structured terminal diagnostics and cancellation
- injected `CredentialStore`; this package does not persist credentials
- static, committed model catalog with explicit fail-closed refresh

OAuth, deferred responses, other built-in Providers, the legacy `/compat`
registry, image generation, and Agent/Tool execution are outside the current
package runtime. Some of their types remain available to preserve the selected
public type closure.

## Development

From the repository root:

```sh
npm run build
npm run check
npm test
npm run pack:dry-run
```

Ordinary builds and tests are offline. Refreshing the committed OpenCode Go catalog is the explicit network operation:

```sh
npm run models:update
```

The paid smoke suite is physically excluded from `npm test`. Run it only with contemporaneous authorization and a supplied key:

```sh
OPENCODE_API_KEY=... npm run test:live --workspace=@coda/ai
```

The readable compatibility matrix lives in [`compatibility/README.md`](./compatibility/README.md); the executable surface is pinned by [`compatibility/manifest.v1.json`](./compatibility/manifest.v1.json).
