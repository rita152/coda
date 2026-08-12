# DeepSWE development campaign

- Dataset: Datacurve DeepSWE v1.1 at `435ee89ec2f2e2289f33b0da4f992f0b7b7266b9`
- Runner: `datacurve-pier==0.3.1`
- Model: `opencode-go/deepseek-v4-flash`
- Reasoning: `max`
- Selection: frozen first 20 lexicographic task IDs
- Concurrency: 5

These are development rounds over the same public tasks, not unbiased holdout measurements.

## Round 1 — baseline

- Harness revision: `de19c5cea7ceb408a76d1560f7d90f934c1cac520b526bece5ce537c9c34c80e`
- Output-token reservation: 16,384

| Metric | Value |
| --- | ---: |
| Passed | 2 / 20 (10%) |
| Average partial reward | 0.705288 |
| Length-truncated Attempts | 7 |
| Run-budget-exhausted trials | 8 |
| Trials with committed changes | 7 |
| Model cost | $0.228121 |
| Turns | 793 |
| Output tokens | 696,467 |

All seven length-truncated trials had zero changed paths. Every truncation stopped at exactly 16,384 output tokens;
the model catalog advertises a larger limit, while Coda's context budget used a fixed 16,384 reservation. Eight trials
hit the 64-Turn Run budget; two of those still received full reward after Pier collected their committed patches.

## Round 2 — larger explicit output reservation

- Harness revision: `69e4a71a2a5a3a4aa4163848ec885c2b278dc333d4cc7828f3c71fe03a290437`
- Output-token reservation: 32,768

Single behavioral change: Coda now receives an explicit 32,768 per-call output budget. A length-truncated response
without Tool Calls fails closed instead of being recorded as a successful Run. The hypothesis is that previously empty
trials will reach their first edit or Tool Call instead of exhausting output on Thinking alone.

| Metric | Value |
| --- | ---: |
| Passed | 3 / 20 (15%) |
| Average partial reward | 0.800160 |
| Length-truncated Attempts | 1 |
| Run-budget-exhausted trials | 8 |
| Trials with committed changes | 15 |
| Policy Tool rejections | 121 |
| Invalid Tool calls | 10 |
| Model cost | $0.304759 |
| Turns | 963 |
| Output tokens | 1,034,465 |

The pass count improved by one (`actionlint-action-pinning-lint`) and average partial reward improved by 0.094872.
Length truncations fell from seven to one and committed trials rose from seven to fifteen, validating the larger
output budget. Eight trials still exhausted 64 Turns. The JSONL also showed 121 policy rejections, dominated by
compound Shell syntax under the non-interactive `never` approval policy.

## Round 3 — approval-aware Shell guidance

- Harness revision: `641fe98ae93f822198b6ddc6f5131942a23d3a5eaabda116d9248194ee45bb93`
- Output-token reservation: 32,768
- Run-turn budget: 64

Single behavioral change from Round 2: the versioned System Prompt now tells an Agent running with approval policy
`never` that no interactive approval is available, and directs it to split pipelines, redirects, here-documents,
and command substitution into simple classified calls while preferring dedicated file Tools. The permission engine
and no-network boundary remain unchanged.

| Metric | Value |
| --- | ---: |
| Passed | 4 / 20 (20%) |
| Average partial reward | 0.768636 |
| Length-truncated Attempts | 1 |
| Run-budget-exhausted trials | 14 |
| Trials with committed changes | 16 |
| Policy Tool rejections | 127 |
| Invalid Tool calls | 8 |
| Model cost | $0.347611 |
| Turns | 1,095 |
| Output tokens | 1,156,368 |

The pass count improved by one (`claude-code-by-agents-recursive-delegation`) and committed trials rose from fifteen
to sixteen, but average partial reward fell by 0.031524. Policy rejections increased from 121 to 127 despite the new
guidance, and fourteen trials exhausted a Run budget versus eight in Round 2. Prompt guidance alone therefore did
not remove the command-policy bottleneck.

## Round 4 — explicit command-policy bypass

- Harness revision: `cca0d66374e26f27b4762584aca516987a4eea11c98a6527220965e7a434c440`
- Output-token reservation: 32,768
- Run-turn budget: 64
- Allow all commands: yes

Single behavioral change from Round 3: at the user's direction, Coda's explicit approval/Sandbox bypass now
authorizes every non-empty Shell command without command classification, dangerous-command rules, or an approval
callback. The Run-turn budget remains 64 to isolate this change. Pier still isolates each disposable task container,
keeps task networking disabled except filtered Provider egress, and Coda strips the Provider key and proxy variables
from Tool subprocess environments.

| Metric | Value |
| --- | ---: |
| Passed | 2 / 20 (10%) |
| Average partial reward | 0.715663 |
| Length-truncated Attempts | 3 |
| Run-budget-exhausted trials | 14 |
| Trials with committed changes | 13 |
| Policy Tool rejections | 0 |
| Invalid Tool calls | 0 |
| Model cost | $0.350324 |
| Turns | 1,018 |
| Output tokens | 1,228,158 |

The bypass met its direct requirement: all twenty trajectories completed with zero policy rejections and zero invalid
Tool-call rejections, versus 127 and 8 respectively in Round 3. Thirteen trials committed changes and two passed
(`abs-module-cache-flags` and `claude-code-by-agents-recursive-delegation`). Pass rate nevertheless fell from 20% to
10%, average partial reward fell by 0.052973, and fourteen trials still exhausted the 64-Turn Run budget. Removing
command friction alone therefore did not improve aggregate task performance in this stochastic development sample.

## Round 5 — no Coda Run budget and full model output limit

- Harness revision: `5d4d65b0a02cadb376fa2e07a6a1d323fa0f961561840d059620f4afd21b6199`
- Output-token reservation: 384,000
- Coda Run budget: disabled
- Allow all commands: yes

At the user's direction, Round 5 retained the command-policy bypass and removed the complete Coda Run Budget
instead of raising only the turn limit. It also requested `deepseek-v4-flash`'s declared maximum output of 384,000
tokens. The model catalog records a 1,000,000-token context window, so the explicit request is no longer silently
reduced by Coda's conservative default quarter-window reservation. Pier's 90-minute per-agent timeout remains solely
as an infrastructure hang boundary.

| Metric | Value |
| --- | ---: |
| Passed | 9 / 20 (45%) |
| Average partial reward | 0.959748 |
| Length-truncated Attempts | 0 |
| Run-budget-exhausted trials | 0 |
| Trials with committed changes | 16 |
| Policy Tool rejections | 0 |
| Invalid Tool calls | 1 |
| Model cost | $0.733580 |
| Turns | 2,016 |
| Output tokens | 2,031,388 |

Removing the Run budget and exposing the exact 384,000-token model limit improved the pass count by seven versus
Round 4 and raised average partial reward by 0.244085. Nine tasks passed: `abs-module-cache-flags`,
`abs-stepped-slices`, `actionlint-action-pinning-lint`, `aiomonitor-task-snapshots-diff`,
`anko-typed-variable-bindings`, `arktype-json-schema-refs-dependencies`,
`bandit-interprocedural-taint-checks`, `boa-hierarchical-evaluation-cancellation`, and
`claude-code-by-agents-recursive-delegation`. Three passing tasks required more than the old 64-Turn ceiling:
`abs-stepped-slices` used 99 Turns, `boa-hierarchical-evaluation-cancellation` used 138, and
`arktype-json-schema-refs-dependencies` used 224.

All twenty trials finished with no infrastructure error, no output-length truncation, no Run-budget exhaustion, and
no command-policy rejection. The single invalid Tool call was a non-command schema error: the model sent unsupported
pagination arguments to an `ls` Tool. The 90-minute Pier timeout remained an outer hang boundary and was not reached.

## Five-round comparison

| Round | Harness change | Passed | Average partial | Policy rejections | Truncations | Budget exhausted | Cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Baseline, 16k output | 2 / 20 | 0.705288 | 96 | 7 | 8 | $0.228121 |
| 2 | Explicit 32k output + fail-closed truncation | 3 / 20 | 0.800160 | 121 | 1 | 8 | $0.304759 |
| 3 | Approval-aware prompt guidance | 4 / 20 | 0.768636 | 127 | 1 | 14 | $0.347611 |
| 4 | True command-policy bypass | 2 / 20 | 0.715663 | 0 | 3 | 14 | $0.350324 |
| 5 | No Coda Run budget + exact 384k output | 9 / 20 | 0.959748 | 0 | 0 | 0 | $0.733580 |

Round 5 is the strongest development configuration in this campaign. Because every round reused the same public
twenty tasks, this is an optimization result over development data rather than an unbiased holdout estimate.

## Post-campaign cleanup

The approval-aware Shell guidance trialed in Round 3 was removed from the final implementation because it did not
reduce policy rejections and conflicts with the explicit command bypass used by the selected configuration. The
adapter's commit bookkeeping was also corrected to recognize changes that Coda committed itself. These cleanup
changes were not presented as a sixth benchmark round.
