# DeepSWE repeated-sampling experiment design

This protocol separates stochastic same-revision variability from a harness treatment comparison. It uses only
recorded Pier results during development; checked-in tests use a synthetic fixture and make no Provider calls.

## Unit of observation and identity

`--attempts N` configures Pier's `n_attempts`. Here, an attempt means one paid Pier trial repetition for one
task/agent pair; it is not a Coda model-call Attempt. The planned paid trial count is:

```text
tasks × attempts × agents
```

Run-lock schema v3 records every planned identity under the `task-attempt-agent-v1` scheme. An identity such as
`task-a::attempt-002::agent-001` is stable across baseline and candidate locks. Pier 0.3.1 gives trial directories a
random suffix and does not persist its repetition ordinal, so Coda recovers the ordinal from an explicit
`attempt_index` when present, otherwise from Pier execution/result order and marks the identity `derived`. The
generated Coda lock remains the authoritative planned identity set; missing result artifacts remain missing rather
than causing a lower denominator to be presented as complete.

The current Coda Provider path does not expose a sampling seed. Locks therefore record `seed.availability` as
`unavailable` and explain why. Attempt matching without a seed is an operational pair within a shared time block,
not common-random-number pairing.

## Running an A/B block

Choose the task set and attempt count before looking at outcomes. Generate baseline and candidate configs with the
same:

- dataset and Pier revisions;
- task/repetition plan;
- model, reasoning effort, output and Run Budget controls;
- command authority settings;
- explicit `--time-block` value.

The harness revision is the treatment and may differ. Run baseline and candidate close together within that time
block; alternate their launch order across blocks when multiple blocks are used. A changed model, reasoning level,
time block, seed contract, or other recorded control makes the pair incompatible. `compare` still reports the raw
identity overlap and missing artifacts, but does not emit paired or stratified treatment aggregates for an
incompatible pair.

Before any paid confirmation check, `run` prints the complete multiplication expression. Repeated sampling also
requires `--confirm-trials <exact-total>` in addition to the existing environment opt-in, API key, and
`--confirm-spend`. The default `--attempts 1` path retains the existing confirmation contract.

## Summary estimands

Every observed trial remains in `report.trials`. For each task, `report.sampling.tasks` reports:

- `n`: observed trials, with errors retained as non-successes;
- `meanSuccess`: successes divided by observed `n`, where success means verifier reward 1 with no infrastructure
  exception;
- `interval`: a two-sided 95% Wilson score interval for single-trial Bernoulli success probability;
- `sampleVariance`: the unbiased sample variance of the observed binary successes when `n >= 2`;
- `passAtK`: `1 - C(n - successes, k) / C(n, k)`, the empirical probability of at least one success when `k` of the
  `n` observed trials are drawn without replacement.

`passAtK` is not a replacement for single-trial success probability. It answers a different operational question
and is reported for every `k` from 1 through observed `n`. Planned-but-absent identities are reported as `missing`;
observations outside the plan are `unplanned`.

## Comparison outputs

For each adjacent input pair, `compare` reports:

- `matching.matched`: identity-matched observations from both sides;
- `matching.unmatched`: observed identities without an observation on the other side;
- `matching.missing`: planned identities with no result on that side;
- `paired`: success means and candidate-minus-baseline delta over compatible identity pairs, plus the four-state
  transition table;
- `stratified`: equal-task-weighted success means and delta, using every observation in each common task stratum.

Task and attempt scope differences are exposed through unmatched/missing records rather than silently dropping
trials. Treatment aggregates remain gated by the recorded non-treatment controls.

## Variability versus observed instability

Compatible comparisons with the same harness revision are labeled `same-revision-variability-estimate`. The
checked-in `deep-swe-same-revision-repeated.json` fixture is the deterministic test for this path.

Different harness revisions are always labeled `observed-cross-revision-instability`. In particular, the historical
56 status flips among 120 adjacent round observations establish observed cross-revision instability only. Because
those rounds changed harness revisions, 56/120 is not a pure sampling flip-rate estimate and must not be presented as
one.
