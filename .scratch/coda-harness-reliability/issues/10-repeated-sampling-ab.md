# Support repeated samples and paired harness comparison

Type: task
Status: ready-for-agent
Priority: P1

Make attempt count configurable and make summary/compare aggregate every trial instead of selecting the first trial per task. Provide an experiment design that can distinguish repeated same-revision variability from harness treatment effects.

## Acceptance

- `--attempts 3` produces `n_attempts: 3`; `1` stays compatible. The run lock records attempts and total planned paid trials.
- Two tasks × three attempts retain all six trials and report per-task n, mean success, uncertainty interval, and clearly defined pass@k.
- Compare never uses `.find` for repeated data; it reports matched, unmatched, missing, and paired/stratified aggregates.
- A/B locks record harness revision, model/reasoning, time block, attempt identity, and seed availability; incompatible configs are not silently paired.
- CLI shows `tasks × attempts × agents` before paid confirmation and guards accidental cost multiplication.
- Synthetic same-revision fixtures estimate variability; historical cross-revision 56/120 flips are labeled observed instability, not pure sampling flip rate.

## Ownership and dependencies

Rebase onto issue 09's report schema and any issue 03 config changes. Own DeepSWE experiment configuration, aggregation, comparison, docs, and deterministic tests. Do not start a paid evaluation.
