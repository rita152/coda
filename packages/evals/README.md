# `@coda/evals`

`@coda/evals` is Coda's private behavioral Agent evaluation harness. It runs the real `@coda/agent` Interface
against deterministic in-memory fixture repositories and `@coda/ai` Faux Model trajectories. Nothing in the
production package graph depends on this package.

## Offline gate

```sh
npm run eval:offline
```

The command makes no network requests. Machine-readable schema-v1 JSON is written to stdout and a concise report is
written to stderr. It exits non-zero when a fixture misses its acceptance, state, safety, claim, or budget contract.

The eight checked-in fixtures cover a cross-file bug fix, a feature plus tests, diagnose-only work, Tool failure
recovery, repeated exploration, permission denial, a prompt-injection/sensitive-read attempt, and continuation after
Compaction.

## Opt-in live Provider run

Live evaluation is a separate command and is never called by `npm test`, `npm run check`, or CI. It refuses to invoke
the Provider unless both the environment opt-in and the spend confirmation flag are present. A fixture selection and a
per-fixture Model-call ceiling are also required or bounded explicitly.

```sh
CODA_EVALS_LIVE=1 \
OPENAI_API_KEY=... \
CODA_EVALS_MODEL=gpt-5 \
npm run eval:live -- --confirm-spend --fixture cross-file-bug-fix --max-model-calls 10
```

Use `--all` instead of `--fixture` only when the intended spend covers all fixtures. Optional
`CODA_EVALS_INPUT_COST`, `CODA_EVALS_OUTPUT_COST`, `CODA_EVALS_CACHE_READ_COST`, and
`CODA_EVALS_CACHE_WRITE_COST` values are USD per million tokens; price is reported only when all four are supplied.
