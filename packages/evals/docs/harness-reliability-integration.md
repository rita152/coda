# Harness reliability integration

This note records the integration of the ten completed harness-reliability changes onto
`codex/harness-reliability-integration`. The source commits remain visible as ten ordered integration commits; the
final integration commit adds only semantic reconciliation, cross-feature tests, fixture upgrades, and this record.
No Provider-backed or paid DeepSWE evaluation was run.

## Source inclusion matrix

| Issue | Capability | Source commit | Integrated commit | Status |
| --- | --- | --- | --- | --- |
| 01 | Evidence-backed completion gate | `db4c57fe3d57c81596a39e28db80ef7d51b68e23` | `0c7a892` | Included; completion consumes public operations and open failures |
| 02 | Strict pipeline semantics | `8955842fcff8d8af5200f3b6a64bf3221f90bea9` | `d61c9ca` | Included; pipefail and output completeness coexist |
| 03 | RunControl | `3436a27d1bcc6c027cbb8473f9d0ad9af2a90f57` | `6318943` | Included; internal work/grace control only |
| 04 | Timeout artifact finalization | `48742fab37b64d52fb24578b3f700311fcf59fee` | `abd60b8` | Included; sole Pier lifecycle owner |
| 05 | Native patch Tool | `bc090a2025bde0625256883ccccccf7b087bce81` | `e50e358` | Included; generic mutation facts and diff provenance preserved |
| 06 | Semantic JSONL | `c349d5dd3584fb858cd0ee471381c90f3e4e7cc0` | `da8c5a9` | Included; raw JSON v2 fixture remains unchanged |
| 07 | Tool-complete ATIF | `76a84b408a6ab43fe6838307e488b7c8e1bc91d8` | `a5614f3` | Included; artifact owner writes complete/partial trajectories |
| 08 | Evidence semantics | `f34adde806c98a7cd2b9c89a409da2d38e68a914` | `fa97346` | Included; versioned completeness and open/recovered failures are the base contract |
| 09 | Coverage-aware report | `78fcd5e7b306e859c443cbc5ecc53de924af1994` | `51cae6c` | Included; missing values remain missing and durations retain their meanings |
| 10 | Repeated sampling and A/B | `4ad478dd8b77263c128908bc517e223e1c296a40` | `e0abcf1` | Included; attempts, paid-trial guard, sampling, and paired comparison coexist with coverage |

## Conflict decisions

### Application and event output

- `JsonEventWriter` owns JSONL serialization. Unconfigured raw events retain the byte-stable Agent event v2
  contract; `--json-mode semantic` applies the semantic stream v1 selection without replacing the raw fixture.
- A configured RunControl augments Agent envelopes at v3 and RunEvidence at v4. The terminal semantic stream emits
  the terminal assistant candidate, Tool lifecycle, RunEvidence, completion disposition, and RunControl terminal
  reason together.
- RunControl wrap-up steering and completion repair steering are each one-shot and bounded. When both are queued at
  the same terminal boundary, the completion gate still requires a successful verification after the latest
  mutation. `RunOutcome` remains a lifecycle result; completion, evidence completeness, and verification remain
  separate facts.

### RunEvidence, mutation, and Bash

- Issue 08's completeness and failure-state model is authoritative. Issue 02 adds shell dialect, pipeline status,
  and pipefail facts without dropping `outputRefComplete`, stored-output, pagination, or overflow facts.
- Issue 05's mutation contract remains generic: the collector reads mutation facts rather than Tool names. Public
  operations expose bounded attempted/committed mutation paths, while final changed paths retain both native Tool
  and workspace-diff provenance. The completion adapter uses that public projection and does not recreate the old
  unresolved-failure accumulator.
- Returned, ordinary non-mutation lookup failures are not completion blockers; mutation failures and non-returned
  infrastructure failures remain open. A later unrelated success cannot recover an open failure.
- The explicit v1 RunEvidence projection is retained for legacy consumers. The current base envelope is v3 and the
  RunControl envelope is v4.

### Pier lifecycle and trajectory

- `CodaTrialArtifacts` is the single owner of pre-launch status, idempotent finalization, bounded cleanup, patch and
  commit salvage, usage recovery, and trajectory generation. `CodaAgent` preserves and rethrows the original timeout
  or cancellation after bounded finalization.
- `CodaTrialArtifacts.write_trajectory` is the only adapter path into `write_coda_trajectory`. It registers
  `tool-evidence.jsonl`, scan/malformed diagnostics, pending Tool state, and explicit partial lifecycle state. There
  is no attempt-end-only fallback trajectory.
- RunControl contributes only internal work/grace deadlines, terminal status, and the adapter finalization margin;
  it does not replace Pier's outer hard timeout or artifact-recovery policy.

### DeepSWE reporting and sampling

- Report schema v3 combines issue 09's coverage truth with issue 10's repeated-trial sampling. Wall elapsed time,
  cumulative trial time, and cumulative agent time remain distinct. Missing and timeout resources are nullable or
  partial, never fabricated as zero.
- Sampling has its own v1 namespace. Run-lock schema v3 records planned task/attempt/agent identities and preserves
  the paid-trial multiplication guard. Report readers upgrade round 5-11 v1 data and recognize both historical v2
  report dialects.
- Comparisons match exact planned identities and retain matched, unmatched, and missing observations. They do not
  select the first matching trial directory. Cross-revision flips remain
  `observed-cross-revision-instability` with `estimatesPureSamplingVariability: false`.

## Schema and artifact map

| Contract | Final version | Compatibility |
| --- | --- | --- |
| Raw Agent JSON event | v2 | Byte-stable unconfigured raw fixture |
| Agent JSON event with RunControl | v3 | Only emitted when RunControl is configured |
| Semantic event-stream selector | v1 | Selects semantic records from the same event source |
| RunEvidence base | v3 | Explicit v1 compatibility projection retained |
| RunEvidence with RunControl | v4 | Adds terminal RunControl report without changing lifecycle outcome |
| Completion disposition / workspace evidence | v1 / v1 | Orthogonal to lifecycle, evidence completeness, and hidden verification |
| Pier adapter status | `coda-adapter-status-v3` | Legacy top-level status fields retained |
| Artifact evidence | `coda-artifact-evidence-v1` | Partial usage and cost coverage are explicit |
| Trajectory / Tool evidence | `ATIF-v1.7` / `coda-tool-evidence-v1` | Pending and recovered Tool results have evidence refs |
| DeepSWE report and comparison | v3 | Reads v1 round 5-11 and both historical v2 dialects |
| DeepSWE sampling | v1 | Independent namespace inside report v3 |
| DeepSWE run lock | v3 | Records attempts and stable planned identities |

## Cross-feature acceptance

- A semantic JSON integration fixture asserts terminal candidate text, Tool start/end, RunEvidence v4, completion
  disposition v1, and RunControl terminal reason in one stream; the raw fixture is unchanged.
- An application fixture forces RunControl deadline wrap-up after an edit. Completion repair is coalesced at the next
  boundary, and only a later successful local verification permits a verified exit. Separate fixtures keep earlier
  verification stale after a later edit/write/patch.
- Bash fixtures assert `false | tail` is nonzero and every Bash result reports output-reference completeness. Normal
  paginated reads remain complete and do not create Tool issues.
- RunEvidence fixtures assert generic patch attempted/committed paths alongside native and workspace-diff provenance,
  and prove unrelated successful operations do not close an open failure.
- The timeout fixture has no `run_end`, but preserves a nonempty patch, partial multi-attempt usage/cost, ATIF Tool
  calls/results, complete Tool-evidence references, and the original timeout outcome.
- The repeated-sampling fixture simultaneously asserts wall/cumulative elapsed, partial cost coverage, two tasks ×
  three attempts, per-task statistics, exact matching, and paired comparison.

## Validation

The final integration was validated without a live Provider:

| Command or fixture | Result |
| --- | --- |
| Focused coding-agent hotspot and cross-feature tests | PASS |
| `npm run test --workspace=@coda/coding-agent` | PASS — 109 files, 701 tests |
| `npm run test --workspace=@coda/evals` | PASS — 3 files/28 tests and 7 Pier artifact tests |
| `uv run --no-project --with datacurve-pier==0.3.1 python -B -m unittest test_coda_trajectory.py` | PASS — 5 locked-Pier trajectory tests |
| `npm run capabilities:update` | PASS — generated manifest and README sections were already current |
| `npm run capabilities:check` | PASS |
| `npm run check` | PASS — full build, TypeScript, Biome, and workspace checks |
| `git diff --check` | PASS |
