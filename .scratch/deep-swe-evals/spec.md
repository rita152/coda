# DeepSWE evaluation runner

Status: implemented

Current operation is documented in
[`packages/evals/README.md`](../../packages/evals/README.md). Campaign artifacts
and later harness-reliability changes remain separate historical evidence.

## Goal

Extend `@coda/evals` with a reproducible, paid opt-in DeepSWE runner that evaluates the Coda Coding Agent through
Pier on an SSH-accessible Docker host. The first development campaign uses the pinned DeepSWE v1.1 task set,
`opencode-go/deepseek-v4-flash`, maximum Reasoning, five concurrent trials, and the first twenty lexicographic task
IDs for five separately recorded rounds.

## Contract

- Pin DeepSWE to `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9` and `datacurve-pier` to `0.3.1`.
- Select tasks by an explicit, immutable ID list. Never define “first 20” with `--n-tasks 20`.
- Make concurrency a validated positive CLI/config option and keep every round as a separate Pier job.
- Use a Coda-specific Pier adapter; never substitute Pier's OpenCode adapter.
- Run Coda in `/app`, retain JSONL Run Evidence, and commit the resulting workspace changes before DeepSWE's collect
  hook executes.
- Preserve each task's no-network policy. The only runtime egress allowance is the Provider host `opencode.ai`.
- Keep `OPENCODE_API_KEY` out of generated configs, locks, logs, and Git. Resolve `${OPENCODE_API_KEY}` only in the
  paid process environment.
- Produce a machine-readable run lock and summary for every round, including task rewards, infrastructure errors,
  usage, cost, duration, harness revision, model, Reasoning, output-token budget, concurrency, dataset revision, and
  image digests. Summaries distinguish length truncation from Run-budget exhaustion.
- Require both `CODA_EVALS_DEEP_SWE=1` and `--confirm-spend` before starting a real run.

## Acceptance

- Existing offline/live fixture evaluation behavior and tests continue to pass.
- Unit tests prove deterministic task selection, custom concurrency, secret-free Pier config/lock output, paid-run
  fail-closed behavior, and reward/error/usage aggregation.
- The Python adapter imports against pinned Pier, exposes only `opencode.ai`, preserves Coda output, commits changes,
  and populates Pier's `AgentContext`.
- `esp32` contains the pinned dataset checkout, pinned Pier, a runnable Coda Linux bundle, and all locked images for
  the selected twenty tasks before the paid batch begins.
- Five job directories and five summaries remain available after the optimization loop. Because the same twenty
  public tasks guide the changes, results are explicitly labeled development rounds rather than an unbiased holdout.
