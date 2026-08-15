# `@coda/evals`

`@coda/evals` is Coda's private behavioral Agent evaluation harness. It runs the
real headless `@coda/runtime` Work Graph Interface with the `@coda/agent` kernel,
deterministic in-memory fixture repositories, and `@coda/ai` Faux Model
trajectories. Nothing in the production package graph depends on this package.

## Offline gate

```sh
npm run eval:offline
```

The command makes no network requests. Machine-readable schema-v1 JSON is written to stdout and a concise report is
written to stderr. It exits non-zero when a fixture misses its acceptance, state, safety, claim, or budget contract.

The seven checked-in fixtures cover a cross-file bug fix, a feature plus tests, diagnose-only work, Tool failure
recovery, repeated exploration, a prompt-injection/sensitive-read attempt, and continuation after
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

## DeepSWE development runs

The DeepSWE path is a separate, paid opt-in runner for evaluating the Coda Coding Agent in Pier-managed Docker task
environments. It pins Datacurve DeepSWE v1.1 to commit
`435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`, pins `datacurve-pier==0.3.1`, and ships a Coda-specific Pier adapter in
`pier/coda_agent.py`. The adapter runs Coda in `/app`, records the semantic JSONL event stream and Run Evidence, and
transactionally derives an ATIF-v1.7 trajectory before the v1.1 collect hook. Tool calls and their terminal
observations remain first-class ATIF data. Full redacted call/result records live in the versioned, append-readable
`agent/tool-evidence.jsonl` sidecar; bounded ATIF previews link to fixed-size pages by stable Tool Invocation ref and
SHA-256. A stream without `run_end` still produces an explicitly partial trajectory with pending calls identified. The
adapter configures a repository-local evaluation identity before Coda starts so tasks that commit their own work do not
fail on a missing container identity. It does not use Pier's OpenCode adapter.

Generate the frozen image lock or a secret-free job config without making Provider calls:

```sh
npm run eval:deep-swe -- images

npm run eval:deep-swe -- config \
  --dataset-dir /srv/coda-evals/deep-swe/tasks \
  --runtime-dir /srv/coda-evals/runtime \
  --jobs-dir /srv/coda-evals/jobs \
  --harness-revision <content-digest> \
  --round 1 \
  --concurrency 5
```

The default selection is an explicit, immutable list of the first twenty lexicographic task IDs. Use repeated
`--task <literal-id>` options for another selection; `--concurrency` accepts any positive integer. `--attempts`
controls Pier trial repetitions and defaults to 1. Each optimization treatment still uses a distinct `--round` so
its harness revision, raw artifacts, lock, and summary remain independent. Baseline and candidate rounds intended
for comparison should share an explicit `--time-block` value.

`--max-output-tokens` controls Coda's per-model-call output reservation and is recorded in the run lock. DeepSWE
defaults it to 32,768 so `max` reasoning is not silently constrained by Coda's conservative interactive default.
`--max-turns` controls the Run turn budget and defaults to Coda's normal 64. Round reports also count policy and
validation rejections, length-truncated Attempts, and Run-budget-exhausted trials; `compare` keeps these diagnostics
beside pass rate, partial reward, usage, and cost.

Every generated Pier config and version-3 run lock selects semantic JSONL mode explicitly. The adapter therefore
retains terminal assistant candidates, Tool lifecycle, Run boundaries, and Run Evidence without writing token-level
message deltas. Raw v2 events remain available through Coda's explicit `--json --json-mode raw` diagnostics path.

DeepSWE report schema v3 separates job `wallElapsedMs` from cumulative trial and Agent time. Token, cost, step, and
cumulative-time totals include their known total, observed/expected trial coverage, and a
`complete | partial | unavailable` status. Cost also reports priced/unpriced Attempt coverage. The report command
streams `coda.jsonl` and can recover lower-bound usage from `attempt_end` records after a timeout without loading the
artifact into memory; recovered values use source `terminal_events` and remain `partial`. Schema-v1 summaries from
development rounds 5–11 remain valid report/compare inputs and are upgraded in memory without inventing wall time.
Both historical coverage-v2 and sampling-v2 reports are also recognized despite their former version-number
collision.

The v3 report retains every repeated trial in a separately versioned `sampling` namespace. Per-task summaries report
observed `n`, mean verifier success, a two-sided 95% Wilson interval, and empirical pass@k for draws without
replacement from the observed trials. Compare uses stable task/attempt/agent identities, reports matched, unmatched,
and missing observations, and emits both identity-paired and equal-task-weighted stratified aggregates only when
recorded controls are compatible. See [the repeated-sampling experiment protocol](docs/deep-swe-experiment-design.md)
for definitions and A/B rules.

`--no-run-budget` is mutually exclusive with `--max-turns` and disables the complete Coda Run Budget rather than
substituting a large numeric limit. It does not disable the independent RunControl envelope. DeepSWE defaults to a
4,500-second work window, a 600-second finalization grace, and four stationary Turns; the 240-second adapter finalize
margin is validated together with those windows against Pier's 5,400-second hard timeout. The corresponding
`--run-control-*`, `--adapter-finalize-margin-sec`, and `--pier-hard-timeout-sec` options are recorded in the v3 run
lock. Explicit `--max-output-tokens` values can use a model's full declared output limit; for example, the pinned
OpenCode Go catalog declares `deepseek-v4-flash` with a 1,000,000-token context window and a 384,000-token output limit.

The Pier adapter creates a versioned, atomically replaced `adapter-status.json` before launching Coda, then runs
workspace/event finalization as a separate idempotent phase. Normal exits, adapter timeouts, and cancellation all
salvage `workspace.patch`, partial ATIF, terminal-event evidence, and known usage before the original timeout or
cancellation is re-raised. A normal/internal-deadline path gets the full finalization timeout; cancellation gets only
a short shielded best-effort window because Pier may immediately tear down the environment. Reliable hard-timeout
recovery therefore still requires the run-control deadline to leave a margin before Pier's outer timeout.

A real run requires all three explicit inputs below. The key is resolved only from the process environment and the
generated Pier config retains the literal `${OPENCODE_API_KEY}` placeholder.

```sh
CODA_EVALS_DEEP_SWE=1 \
OPENCODE_API_KEY=... \
npm run eval:deep-swe -- run \
  --confirm-spend \
  --dataset-dir /srv/coda-evals/deep-swe/tasks \
  --runtime-dir /srv/coda-evals/runtime \
  --jobs-dir /srv/coda-evals/jobs \
  --adapter-dir /path/to/packages/evals/pier \
  --harness-revision <content-digest> \
  --round 1 \
  --attempts 3 \
  --time-block ab-2026-08-13-am \
  --concurrency 5 \
  --model opencode-go/deepseek-v4-flash \
  --reasoning max \
  --max-output-tokens 32768 \
  --max-turns 64 \
  --confirm-trials 60
```

Immediately before the paid opt-in checks, `run` prints `tasks × attempts × agents` and the total planned paid
trials. When `--attempts` is greater than 1, `--confirm-trials` must exactly match that total; this prevents a copied
single-sample command from silently multiplying spend. The default `--attempts 1` confirmation flow is unchanged.

DeepSWE declares agent and verifier task networks as disabled. The adapter asks Pier for filtered inference egress to
`opencode.ai` only and enables Node's environment-proxy support; it never enables general task internet access.
Repeated tuning on the same twenty public tasks is recorded as `development-round` in every run lock, not presented
as an unbiased holdout score. The historical 56/120 adjacent-round status flips crossed harness revisions and are
therefore labeled observed cross-revision instability, never a pure sampling flip rate. Same-revision variability is
tested with a synthetic, zero-Provider fixture.
