# Coda DeepSWE harness：10 项缺陷的实现审计与任务拆分

审计日期：2026-08-13  
审计基线：`6aea277ea801d34028af993c68a3c0eb3e5256ba`  
范围：当前 Coda/DeepSWE harness 的本地实现、现有测试、round 5–11 汇总与本地保留的 trial 产物。本笔记不比较外部 coding-agent 源码，也不修改生产代码。

## 结论摘要

1. 10 项对“当前代码机制”的描述全部有真实依据；其中 1、2、3、4、6、7、8、9、10 可以直接定位到确定的控制流或数据模型，5 也确认存在，但“新增 patch Tool”本身不足以让 changed-path evidence 变得完整。
2. 第 1 项的相关性很强，但需要保持语义克制：`RunOutcome.success` 当前只表示 Agent 生命周期正常结束，不等价于“补丁正确”。增加完成门禁可以减少虚假完成，不能替代隐藏 verifier，也不应把 verifier 语义塞进通用 `RunOutcome`。
3. 第 3 项不是“代码库完全没有 deadline/stall 能力”。默认 `RunBudget` 已有 1 小时 `maxElapsedMs` 和连续相同 Tool batch 检测；问题是 `--no-run-budget` 将整套 meter 设为 `undefined`，并且现有 budget exhaustion 是硬失败，没有收尾阶段，也没有基于实际进展的停滞判定。
4. 第 8 项中的 `unresolvedFailures` 名称与实现不一致：实现是“未被显式 retry 的 Attempt 失败 + 所有历史 Tool 失败 + Run 失败”的有界历史集合，不是 outstanding failure set。
5. 第 10 项的配置缺陷确认存在，但 round 5–11 的 56/120 翻转不能单独归因于 sampling noise：相邻轮次使用了不同 harness revision。它证明单次观测不稳定，纯随机方差仍需同 revision 重复样本才能估计。
6. 不建议让 10 个实现任务同时直接修改当前工作树。`application.ts`、`coda_agent.py`、`run-evidence.ts`、`deep-swe.ts`/`deep-swe-cli.ts` 是四个明显热点；下面给出的 10 个任务可以独立验收，但应按末尾 wave 顺序实施。

## 数据复核边界

当前工作区可以直接复算：

- round 5–11 共 140 trials；pass rate 依次为 45%、20%、80%、50%、45%、50%、45%。
- 73 个非 passed trial 中有 43 个 `partial > 0.98`；若只算 `status == failed`，则为 42，另一个是 round 11 的 Arktype timeout error。
- round 5→11 的六次相邻比较共有 56/120 次 pass/non-pass 翻转，各轮为 7、12、8、9、11、9；Boa 每次都翻转。
- round 11 有 19 个正常结束 trial，全部 `codaExitCode=0`、`runOutcome=success`；其中 9 passed、10 failed。
- round 11 的 changed-path count 合计为 188；tool issue 合计为 249。
- round 11 passed trial 的 `unresolvedFailureCount` 平均 7.8889，failed trial 平均 5.6；Boa passed 且为 16。
- round 11 job 根时间为 10:10:50.675539→11:58:00.840404，即 6,430,165ms；当前 summary 的 32,376,354ms 是 trial duration 累加值。
- Arktype 的 `result.json` 明确记录 `AgentTimeoutError`、5400 秒 agent timeout，以及所有 `agent_result` resource/metadata 字段为 null。

当前工作区不能独立复算：

- round 10/11 本地 trial 目录只保留了 job/trial `result.json`、`config.json` 和 `trial.log`；`agent/coda.jsonl`、`trajectory.json`、`adapter-status.json`、`artifacts/model.patch`、verifier 详细输出没有随本地副本保留。
- 因此 1,833 Bash、1,225 pipelines、2,680,975 `message_update`、1,059,515,650 JSONL bytes、333 个 Shell 文件修改、217 个最终 patch paths、249 tool issue 的按 Tool 分类、Arktype 的 261 Attempts/290 Tools/39 native writes 与恢复出的 token/cost 数字，只能确认代码机制能够产生这些现象，不能在本地对原始计数重新扫描。
- “10 个正常结束但 verifier 失败的最终回复均以 Done/All done 开头”也需要 round 11 原始事件才能独立验证；compact summary 不含 final text。

这不推翻用户给出的远端轨迹统计，但后续修复应把“原始产物完整性”本身纳入验收，避免再次依赖不可得的远端大文件。

## 逐项代码审计

### 1. 完成门禁：确认，因果解释需限界

确定的实现事实：

- `Agent` 在一个成功 Attempt 没有 Tool Call、没有 length truncation 时把 outcome 设为 `success`；终止条件只再检查 pending steering。见 `packages/agent/src/agent.ts:581-635`。
- print application 随后只检查 `result.outcome === "success"`、存在 `finalMessageId`、消息角色为 assistant，然后返回 0。见 `packages/coding-agent/src/application.ts:2555-2571`。
- 需求 checklist、最终测试、最后一次 mutation 之后的验证、final diff/status、blocked/partial/verified disposition 都没有结构化状态。仓库中相关内容只存在于 System Prompt 文本，见 `packages/coding-agent/src/prompt/prompt-builder.ts:195-198`。

判断：代码机制描述准确；round 11 的 10 个 lifecycle-success/verifier-fail 说明当前 success 对补丁正确性没有区分力。但 verifier 是独立隐藏环境，不能要求通用 Agent 在本地证明隐藏测试一定通过。

改进方向：保留 `RunOutcome` 的生命周期语义，在 coding application seam 增加独立的 `CompletionDisposition`（`verified | partial | blocked | unverified`）和有界的 `CompletionGate`。Gate 应交叉检查真实 Tool observation/workspace snapshot，而不是解析 “Done”。当候选终止但缺少必要证据时，最多注入少量 steering 让模型收尾；达到修复次数上限后仍要落盘 patch/evidence，只把 disposition 标为 unverified，不能丢弃工作。

### 2. Shell pipeline：确认

确定的实现事实：

- Bash Tool 调用配置的 shell 为 `args: ["-c", command]`，status 只看该 shell process 的 `exitCode`。见 `packages/coding-agent/src/tools/bash.ts:171-181,231-278`。
- POSIX pipeline 默认返回最后一个 command 的 status，所以 `cargo test | tail` 可把上游失败变成 0。
- 新增的 `preview` 参数能够不改变命令地做 head/tail 展示，并且 Tool 描述/System Prompt 已劝模型使用它；这只是更好的接口，不会改变模型仍提交 pipeline 时的 shell 语义。

判断：缺陷确认。需要注意不能盲目给任意 `$SHELL` 加 `-o pipefail`：`bash`、`zsh`、`ksh` 支持形态不同，`dash`/某些 `/bin/sh` 不支持。产品实现必须明确 shell dialect，而不是假设所有 `SHELL` 都是 Bash。

改进方向：让 Bash Tool 使用经过能力确认的 strict shell，并在执行 facts 中记录 `pipelineStatusMode: pipefail`；不支持 pipefail 的 shell 对含 pipeline 的命令应 fail closed 并提示使用 `preview`，或产品统一依赖可发现的 Bash。DeepSWE adapter 应显式固定相同 shell，避免本地与容器行为漂移。

### 3. no-budget 后的软截止与收敛：确认，但已有可复用硬 budget

确定的实现事实：

- 默认 coding budget 包含 `maxTurns=64`、`maxToolInvocations=256`、`maxElapsedMs=1h`、`maxConsecutiveEquivalentToolBatches=4`。见 `packages/coding-agent/src/application.ts:164-178`。
- `codingAgentRunBudget(..., disabled=true)` 直接返回 `undefined`；Agent 不再构造 `RunBudgetMeter`。见 `packages/agent/src/agent.ts:483-494`。
- meter 的“停滞”只识别参数完全等价的连续 Tool batches，不识别重复失败测试、来回改同一文件、工作树无变化或长期没有新证据。见 `packages/agent/src/run-budget.ts:182-205`。
- elapsed/budget exhaustion 直接结束为 error，没有 deadline-approaching steering/finalization grace。
- DeepSWE config 只留下 `max_timeout_sec: 5400`；adapter 在 no-budget 模式只传 `--no-run-budget`。见 `packages/evals/src/deep-swe.ts:391-405`、`packages/evals/pier/coda_agent.py:109-114`。

判断：用户描述的运行现象与机制一致。真正缺少的是独立于 resource budget 的两阶段 run control，而不是再增加一个超大 turns 数字。

改进方向：增加深的 `RunControl` module：work deadline 到达时只注入一次 finalization steering；grace deadline 才 abort；基于明确 progress facts（新 content digest、失败验证转成功、新 requirement evidence）判断停滞。它与 `RunBudget` 分离，所以 `--no-run-budget` 仍可启用。Pier 的 hard timeout 必须晚于 Coda hard stop + adapter finalize 预算。

### 4. timeout 收尾非事务：确认

确定的实现事实：

- Coda、git add/commit、`adapter-status.json` 写入被拼在同一个 shell command 中；commit/status 位于 Coda process 之后。见 `packages/evals/pier/coda_agent.py:116-154`。
- `await environment.exec(...)` 位于 line 158；读取 events/status、populate context、写 trajectory 都在 await 正常返回之后，且没有 `try/finally`。见 line 158-170。
- Pier timeout 取消该 await 时，Python coroutine 直接离开；后续没有机会读取 partial JSONL。Arktype result 的 traceback 正好停在该 await。

判断：确认。简单地包一层 Python `finally` 仍不是充分保证：外部 `asyncio.wait_for` 已取消 task，环境也可能马上 teardown。可靠路径必须首先用内部 deadline 提前停止 Coda，给独立 finalize 留真实 wall-clock 窗口；`finally`/shell trap 只是硬取消时的 best effort。

改进方向：把 run 与 finalize 拆成两个幂等 phase；adapter status 在启动前就创建并原子更新 phase；内部 stop 之后用新的 `environment.exec` 完成 `git add/commit`；无 `run_end` 时从已落盘 terminal events 合成 partial evidence/trajectory。finalize 失败也必须保留 status 和已有资源数据。

### 5. 原生 mutation 太浅：确认，但 patch Tool 不是完整 evidence 修复

确定的实现事实：

- built-ins 只有 `edit` 和 `write`；`edit` 是 exact-text replace，`write` 是整文件覆盖。见 `packages/coding-agent/src/tools/contracts.ts`、`edit.ts`、`write.ts`。
- 两者都走 `TargetMutationCoordinator` + `AtomicMutationWriter`，具备 per-target race/permission containment。见 `packages/coding-agent/src/tools/mutation.ts`、`sandboxed-mutation-writer.ts`。
- permission engine、RunEvidence、TUI presentation 都硬编码 `edit`/`write` 集合。新增 patch 不是只加一个 Tool 文件：至少会触及 `permission-engine.ts`、`run-evidence.ts`、`tool-presentation.ts`、tool contracts/index、capability manifest/tests。
- RunEvidence 的 changed path 只从成功的 `edit`/`write` invocation argument 推导；Bash mutation 永远不可见。见 `packages/coding-agent/src/run-evidence/run-evidence.ts:12-15,385-408,475-479`。

判断：缺陷确认。新增 multi-hunk/multi-file native patch 会减少 Shell 修改并改善 evidence，但不能保证模型不再用 Bash，也不能单独让 changed paths 等于最终 patch paths。

改进方向：新增结构化 patch plan + native patch Tool，同时把 mutation metadata 变成一个共享 contract，避免 permission/evidence/presentation 各维护字符串集合。多文件 patch 至少保证“所有目标先解析/授权/校验，单文件写入原子”；若不能可靠 rollback，就不要宣称整个多文件操作事务原子。最终完整 changed paths 仍应由 run 前后 workspace snapshot/diff 补足，并标出 provenance（native vs workspace-diff）。

### 6. JSON delta 日志放大：确认

确定的实现事实：

- `--json` listener 对每一个 Agent event 执行一次 `JSON.stringify` 和 awaited stdout write。见 `packages/coding-agent/src/application.ts:2520-2546`。
- `message_update` 是 token/text/thinking/toolcall delta 事件。见 `packages/agent/src/types.ts:222-272`。
- Node stdout adapter 等待每次 stream write callback，见 `packages/coding-agent/src/node-application.ts:70-79`。因此问题不仅是磁盘占用，也在热路径中增加百万级序列化与异步写操作。
- terminal `attempt_end` 已包含完整 candidate；`message_end` 也包含完成 assistant message。RunEvidence/Session semantic persistence不依赖逐 delta 输出。

判断：机制确认。不能从当前本地 round 11 副本复算 1.059GB/2.68M，但该数量级与实现完全吻合。

改进方向：保持现有 `--json` 稳定契约，新增显式 semantic/eval stream mode，省略 `message_update`（或按 message/content index 合并），保留 run/turn/attempt terminal、Tool lifecycle、run_evidence。raw delta 继续作为 opt-in diagnostics，不能默认写入 DeepSWE。

### 7. ATIF 丢 Tool、RunEvidence 又过度压缩：确认

确定的实现事实：

- `_write_trajectory` 只遍历 `attempt_end`，只输出 user/agent steps；Tool call block 被 `_message_text` 丢弃，`tool_execution_*` 完全不读。见 `packages/evals/pier/coda_agent.py:259-321`。
- 本地 round 9 trajectory 可直接看到 source 只有 `user`、`agent`，tool steps 为 0。
- RunEvidence `MAX_COMMANDS=32`，只留前 32 条并报告 omitted。见 `packages/coding-agent/src/run-evidence/run-evidence.ts:3-7,558-583`。
- 19 个正常完成 run 最多恰好保留 `19 * 32 = 608` 条；用户给出的 1,647 actual/1,039 omitted 与这一上限完全一致。

判断：确认。简单增大 `MAX_COMMANDS` 会破坏 compact evidence 的定位且仍会截断，不是正确修复。

改进方向：ATIF 保留按 sequence 排序的 Tool call/result step；较大内容写入独立、可流式/分页的 `tool-evidence.jsonl`，ATIF 用 invocation id/ref 关联。每步至少有 tool name、sanitized arguments/command、status、settlement、exit/signal/timeout/truncation 和有界 result preview。partial run 也要能生成。

### 8. toolIssue 与 unresolved 指标语义：确认

确定的实现事实：

- `read` 将 `start > 0 || page end < total lines` 都设置为 `observation.truncated=true`。见 `packages/coding-agent/src/tools/read.ts:70-91`。这正确表达“本 observation 不是全文件”，但不等于异常。
- RunEvidence 把任何 `truncated` observation 都加入 `toolIssues`，reason 最终为 `output_truncated`。见 `run-evidence.ts:487-510,654-662`。
- Tool failure 只要发生就加入 `failures`；后续 Tool 成功没有 reconciliation。只有 failed Attempt 被 `retry_scheduled` 的同 attempt id 显式消解。见 `run-evidence.ts:513-554`。
- round 11 的反向相关数字可以直接从 summary 复算。

判断：确认。`truncated` 同时承载 deliberate pagination、user-selected preview、recoverable overflow 和 lossy overflow，信息层级不足；`unresolvedFailures` 则是命名错误加缺少 resolution key。

改进方向：给 observation 增加明确 completeness category（如 `complete | windowed | recoverable-overflow | lossy-overflow`）；tool issue 与非异常分页分开计数。保留 historical failures，并单独投影 `openFailures`；只在安全的 exact resolution key 上消解（同 tool/path/code，或同一 normalized verification command），不能用“任意后续成功”清空全部失败。

### 9. summary 缺失值与耗时：确认

确定的实现事实：

- `sumOptional` 使用 `value ?? 0`，所有汇总字段都没有 observed/total coverage。见 `packages/evals/src/deep-swe.ts:491-492,603-631`。
- job root `started_at`/`finished_at` 在 `readPierJobResult` 返回对象中仍存在，但 summarizer 只读取每个 trial 的时间，随后求和为 `elapsedMs`。见 `deep-swe-cli.ts:210-235`、`deep-swe.ts:523-526,614`。
- adapter cost 只接受 RunEvidence `cost.totalUsd`；partial/unavailable 或没有 completed RunEvidence 时为 null。见 `packages/evals/pier/coda_agent.py:198-217`。
- CLI 的 fallback enrichment 已经会读取 coda.jsonl，但目前只恢复 rejection/truncation/budget 计数，不恢复 Attempt usage/cost。见 `packages/evals/src/deep-swe-cli.ts:238-299`。

判断：确认。round 11 wall/cumulative 时间可直接复算；Arktype 的具体 recovered usage/cost 需要缺失的远端 JSONL 才能重算，但 terminal `attempt_end.candidate.message.usage` 确实包含恢复所需字段。

改进方向：报告 schema 升级，显式区分 `wallElapsedMs`、`cumulativeTrialElapsedMs`、`cumulativeAgentElapsedMs`；每个 resource aggregate 携带 `knownTotal`、`observedTrials`、`totalTrials`、`status`。CLI 用 streaming JSONL parser 从 partial run 恢复 Attempt usage，标记 source=`run_evidence | terminal_events | missing`，不能默认为完整。

### 10. 单样本 revision：确认，现有翻转不能估计纯噪声

确定的实现事实：

- config type 把 `n_attempts` 写死为 literal `1`，生成器也固定为 1。见 `packages/evals/src/deep-swe.ts:147-151,376-382`。
- compare 对每个 task/round 使用 `.find(...)`，数据模型天然只容纳一个 trial；重复后会静默选第一个。见 `deep-swe.ts:669-684`。
- round 5–11 的 56/120 翻转、Boa 六次全部翻转可以直接复算。

判断：配置缺陷确认。统计论证应改写为：单次测量的 observed instability 很高，因此不能用相邻 `+1/-1` 归因；但这些轮次 revision 不同，不能把 46.7% 当作同 revision sampling flip rate。

改进方向：首先支持同 revision 的 `n_attempts >= 3`，报告 per-task mean pass、样本数、置信区间及 pass@k（不能用 pass@k 代替单次成功概率）。真正比较两个 harness 时，使用相同任务、相近时间交错运行的 paired A/B；若 provider 不支持 seed，就明确记录 seed unavailable 和时间块。

## 共享 seam 与冲突热点

| seam / 深 module | 当前实现位置 | 牵涉任务 | 主要风险 |
| --- | --- | --- | --- |
| Run 终止与控制 | `agent.ts`、`application.ts`、`run-budget.ts` | 1、3 | 两者都可能拦截 terminal candidate/steering；必须统一控制优先级与最多额外 Turns |
| JSON event rendering | `application.ts` | 6，少量影响 1、3 | 当前 parser/composition 单文件很大，平行编辑容易冲突 |
| Tool mutation contract | `tools/contracts.ts`、`permission-engine.ts`、`run-evidence.ts` | 5、8，间接 1 | 目前硬编码集合重复；patch 前应先集中语义 contract |
| Tool observation/evidence | `run-evidence.ts`、各 Tool observation facts | 1、5、7、8、9 | schema 变更需版本化；不能让 ATIF/summary 各自重新猜语义 |
| Pier trial lifecycle | `coda_agent.py` | 3、4、7，间接 9 | 同一 adapter 的 run/finalize/trajectory 代码会发生直接 merge conflict |
| DeepSWE report/config | `deep-swe.ts`、`deep-swe-cli.ts` | 3、9、10 | report schema、CLI options、config type 都在同两文件 |

建议形成五个有深度的内部 module，而不是继续把逻辑堆进四个热点文件：

- `CodingCompletionGate`：小接口封装 terminal evidence assessment 与 bounded repair steering。
- `RunControl`：小接口封装 deadline、grace、progress/stagnation 与 timer lifecycle。
- `JsonEventWriter`：小接口选择 raw/semantic stream，并隐藏合并与序列化。
- `ToolEvidenceProjection`：统一 observation completeness、path provenance、failure resolution。
- `PierTrialArtifacts`：统一 incremental status、partial event reduction、ATIF/tool evidence、finalize。

接口即测试面；不要在 application、adapter、summary 三处分别复制同一 event reduction。

## 10 个可独立验收的实现任务

### T01 — Evidence-backed Completion Gate（对应 #1）

目标：增加 completion disposition 和有界收尾，而不改变 `RunOutcome` 的生命周期含义。

主要所有权：新建 `packages/coding-agent/src/completion/*`；集成点 `application.ts`；测试 `application-print.test.ts` 或独立 completion test。若需要结构化 completion Tool，T01 还独占其 Tool 文件和注册改动，T05 必须后合并。

接口建议：Gate 接收 terminal assistant candidate、当前 run 的 evidence snapshot、workspace final snapshot 和剩余 repair 次数，返回 `accept(disposition)` 或 `continue(steering)`；implementation 不能解析 “Done”。

验收测试：

- read-only/diagnosis run 不因没有 tests 被错误阻塞。
- mutation 后直接宣称完成，disposition 不能是 verified，并且只注入一次明确 steering。
- verification 在最后一次 mutation 之前成功，随后又修改文件时，旧验证失效。
- 最后 mutation 之后存在成功 verification 和 final workspace diff/status evidence 时可 verified。
- 相关失败仍 open 时只能 partial/blocked；blocked 仍正常保留 patch/evidence。
- repair 上限严格生效，无无限 completion loop；CLI/JSON 输出包含 disposition。

依赖/冲突：建议依赖 T08 的 evidence semantics；与 T03/T06 的 `application.ts` 有高冲突，与 T05 的 Tool registry 有中冲突。

### T02 — Strict pipeline exit semantics（对应 #2）

目标：所有 Bash Tool pipeline 默认保留任一未处理上游失败。

主要所有权：`tools/bash.ts`、`bash-tool.test.ts`；若需 shell discovery，只允许小范围修改 application shell selection。DeepSWE 的 `SHELL` 固定改动需与 T04 协调。

验收测试：

- `false | tail`、`command-that-exits-7 | grep ... | head` 返回 Tool error 和非 0 exit。
- 下游失败仍为 error；全 pipeline 成功为 ok。
- 用户显式处理失败（例如合适的 `||`）遵从 shell 语义。
- `preview` 仍不改变 exit status；facts 明确标记 pipefail mode。
- unsupported shell 不得静默退回 last-command semantics：应 fail closed 或明确禁止 pipeline。
- DeepSWE runtime smoke test 确认实际 shell dialect 与本地测试一致。

依赖/冲突：基本独立；若编辑 `coda_agent.py`，必须在 T04 之后由同一 owner 合并。

### T03 — Two-phase deadline and convergence controller（对应 #3）

目标：即使 no-run-budget，也有 work deadline、finalization grace、hard stop 和可解释的 stagnation signal。

主要所有权：新建 `packages/coding-agent/src/run-control/*`；CLI wiring `application.ts`；DeepSWE flags/config `deep-swe.ts`/`deep-swe-cli.ts`/adapter。

验收测试：

- deterministic scheduler 下，work deadline 只发一次 finalization steering，当前 Tool 安全结算后在下一模型边界消费。
- grace deadline abort，且 `run_end`/evidence 记录 stop reason；timer 在正常结束后全部取消。
- `--no-run-budget` 不禁用 RunControl；默认交互运行未配置时行为不变。
- 新 content digest、失败验证转成功等 progress 会重置 stagnation；重复 read/相同失败/无 workspace 变化不会。
- stagnation 达阈值进入 finalization，而不是立即丢 patch。
- 配置校验保证 `work + grace + adapterFinalizeMargin < Pier hard timeout`。

依赖/冲突：最好在 T06 后集成 application、在 T09 后改 report config；依赖 T04 提供可靠 finalize 才能兑现端到端保证。与 T01/T06/T09/T10 高冲突。

### T04 — Transactional/best-effort timeout artifact finalization（对应 #4）

目标：Coda 无论 normal、soft timeout、hard cancellation、commit failure，最大程度保留 patch、status、partial trajectory 和 usage。

主要所有权：`packages/evals/pier/coda_agent.py`，建议把逻辑下沉到新 `coda_trial_artifacts.py`，减少与 T07 冲突。

验收测试：

- status 在启动前存在，并以原子 rename 更新 `phase`/timestamps/outcome。
- 模拟 Coda 在若干 `attempt_end` 和成功 edits 后被内部 timeout：workspace 被提交、collect 得到非空 patch、trajectory/tool evidence 可读、context 有 recovered steps/tokens/cost coverage。
- 没有 `run_end` 时生成 partial evidence，而不是伪造 success。
- finalize 重入幂等；commit 失败保留 events/status 并最终报告错误。
- 没有改动仍产生合法 status/trajectory，commit 不被误判失败。
- 外部取消路径使用短时、shielded/best-effort cleanup，但测试和文档明确它不如提前内部 deadline 的保证强。

依赖/冲突：与 T07 直接冲突；先 T04 再 T07。端到端可靠性依赖 T03 留 finalize margin。

### T05 — Permission-aware multi-file patch Tool（对应 #5）

目标：提供多 hunk、多文件原生修改，复用现有 mutation containment，并输出完整结构化 changed paths。

主要所有权：新 Tool/parser，`tools/index.ts`、`tools/contracts.ts`、`mutation.ts`、`permission-engine.ts`、TUI presentation、capability contract/tests。

验收测试：

- 一个 invocation 对多个文件应用多个 hunks，保留 BOM/newline/mode；changed paths 全部出现在 observation/evidence。
- 在任何写入前解析全部 targets、拒绝 absolute traversal、symlink swap、protected metadata、重复/conflicting hunk。
- 所有 preconditions 先校验；每文件写入原子。若跨文件不能 rollback，失败结果明确列出 applied/not-applied，绝不声称全局原子。
- race test 覆盖 parse→authorize→write 期间内容/identity 变化。
- permission review 能展示有界 patch preview 并授权所有、且仅这些 paths。
- 模型-facing description 使常见批量编辑优先使用 patch；existing edit/write 保持兼容。
- capability manifest、public built-in ordering和 RunEvidence schema tests 更新。

依赖/冲突：强依赖 T08 先定义 generic changed-path/completeness contract；与 T01 Tool registry 中冲突。不能与 T08 同时写 `run-evidence.ts`/permission contract。

### T06 — Semantic JSONL eval mode（对应 #6）

目标：DeepSWE 默认不写逐 delta event，同时保留现有 raw `--json` 契约。

主要所有权：新建 `packages/coding-agent/src/event-output/*`，集成 `application.ts`，测试 `application-print.test.ts`；adapter 只增加一个 mode flag，留给 T04 owner 合并。

验收测试：

- existing `--json` fixture byte/event shape 不变。
- semantic mode 对 100k `message_update` 不输出逐 delta，但保留 run_start、attempt_end 完整 candidate、Tool start/end/rejected、run_end、run_evidence。
- terminal assistant text/tool calls 可从保留事件重建；media projection 与 schema version 正确。
- 输出事件顺序稳定；run_evidence 仍紧随对应 run_end。
- stress test 证明输出行数/bytes 与 terminal events 数量成正比，而不是与 token deltas 成正比。
- raw delta 只能显式 opt in，DeepSWE config 锁记录所选 stream mode。

依赖/冲突：与 T01/T03 在 `application.ts` 冲突；应最先提取/集成 `JsonEventWriter`，后续任务只调用其接口。

### T07 — Tool-complete ATIF + paged evidence（对应 #7）

目标：标准 trajectory 能独立诊断完整 Tool 生命周期，不再依赖扫描 raw delta JSONL。

主要所有权：新建 `packages/evals/pier/coda_trajectory.py` 和 fixture tests；`coda_agent.py` 只做一次调用集成。

验收测试：

- mixed parallel Tool trace 按 event sequence/sourceIndex 输出 call/result 关系，保留 invocation id。
- 每个 Tool step 有 name、sanitized/bounded args、status、settlement、exit/signal/timeout/completeness。
- 大 result 写入 `tool-evidence.jsonl` 并可按 invocation/ref 分页；ATIF 不内嵌无限文本。
- secret/token/credential-like args 被 redact；terminal control 被去除。
- partial/no-run_end trace 仍生成合法 trajectory，并标记 partial。
- ATIF-v1.7 schema validator（使用锁定 Pier 版本）通过。
- 断言 actual Tool 数与 trajectory/evidence terminal Tool 数一致，不受 RunEvidence `MAX_COMMANDS` 影响。

依赖/冲突：先让 T04 拆出 artifact module，再由 T07 集成；可使用 T06 semantic events。不要增大 RunEvidence 上限作为替代。

### T08 — Observation completeness + open failure semantics（对应 #8）

目标：将分页、可恢复截断、丢失截断和失败分开，并让 `openFailures` 名副其实。

主要所有权：`run-evidence/run-evidence.ts`、`tools/read.ts`，可新增共享 observation semantics helper；更新 projection/presentation tests。

验收测试：

- `read(offset>1)` 和 limit pagination 记录 `windowed`，不增加 toolIssue；仍准确表明有 previous/more。
- Bash user preview、recoverable overflow、lossy overflow 分别落入不同 category/count。
- failed edit/read 后同 tool+same target 的成功可按明确 resolution key 关闭；无关成功不能关闭。
- failed verification command 后 exact normalized command 成功可关闭；不同命令不关闭。
- historicalFailures 与 openFailures 同时存在且 omission counts 准确；旧 schema reconstruction 有兼容策略。
- round evidence presentation 不再把正常 pagination 显示为异常。

依赖/冲突：这是 T01/T05 的基础任务；优先实施。它独占 `run-evidence.ts`，避免与 T05 平行改。

### T09 — Coverage-aware DeepSWE report + legacy recovery（对应 #9）

目标：所有汇总明确 completeness，正确报告 wall/cumulative duration，并从 partial terminal events 恢复资源数据。

主要所有权：`deep-swe.ts`、`deep-swe-cli.ts`、`deep-swe.test.ts`；不修改 adapter 以避免与 T04/T07 冲突。

验收测试：

- job root 100s、两个并发 trial 各 80s：`wallElapsedMs=100000`、`cumulativeTrialElapsedMs=160000`。
- 一个 trial 完整、一个 resource missing：known total 正确，coverage=1/2、status=partial；绝不显示为完整 0。
- 全 missing 与真实 zero 可区分。
- 无 run_evidence 的 partial JSONL 通过 streaming parser 汇总 `attempt_end` usage/cost，source 标为 terminal_events；不把百万行一次性读入内存。
- cost partial 时同时保留 `knownTotalUsd`、priced/unpriced Attempts；summary coverage 与 trial coverage 一致。
- Arktype-style timeout fixture（无 adapter status/trajectory、若干 attempts）仍产生资源数据和明确 partial 状态。
- report schema version 升级，并提供 round 5–11 legacy input 兼容测试。

依赖/冲突：与 T03/T10 同写 DeepSWE config/report；先 T09，再 T10，T03 的 config flag 最后 rebase。

### T10 — Repeated samples and paired comparison（对应 #10）

目标：支持可控重复样本，并让 summary/compare 不再假设每 task 每 round 只有一个 trial。

主要所有权：`deep-swe.ts`、`deep-swe-cli.ts`、tests/README；基于 T09 的 report schema。

验收测试：

- `--attempts 3` 生成 `n_attempts: 3`，run lock 记录 attempts 与总 paid trials；1 保持兼容。
- 2 tasks × 3 attempts 的 summary 保留全部 6 trials，按 task 输出 n、mean pass、CI、pass@k；overall metric 定义清晰。
- compare 对重复样本不使用 `.find`，能做同 task paired/stratified comparison并报告 unmatched/missing。
- A/B config/lock 记录 harness revision、时间块、model、reasoning、seed availability；不同 config 不被误配成 paired。
- CLI 在付费确认前打印/校验 `tasks * attempts * agents`，避免无意倍增费用。
- 同 revision synthetic stochastic fixture 能估计 flip/variance；不同 revision 的历史 56/120 不再标为 sampling flip rate。

依赖/冲突：强依赖 T09；与 T03 的 DeepSWE CLI/config wiring 冲突，最后实施或由同一 owner 连续完成。

## 推荐实施顺序

“10 个任务同时启动”可以用于并行阅读、设计和测试用例准备；不应让 10 个 task 同时在共享工作树写生产文件。推荐四个 implementation wave：

1. Wave A（可四路并行）：T02 Shell、T06 semantic JSON、T08 evidence semantics、T04 artifact finalizer。四者的主要文件不同。
2. Wave B（可三路并行）：T01 completion（基于 T08/T06）、T07 trajectory（基于 T04/T06）、T09 report coverage。主要热点分别是 application、Pier trajectory、DeepSWE report。
3. Wave C（可两路并行）：T03 run control（在 T06/T01 后改 application，并接 T04 finalize margin）、T05 patch Tool（在 T08/T01 后改 Tool/permission/evidence）。
4. Wave D（串行）：T10 repeated sampling，在 T09 schema 和 T03 config flags 稳定后完成。

每个 wave 合并后都应运行：

```text
npm run test --workspace=@coda/agent
npm run test --workspace=@coda/coding-agent
npm run test --workspace=@coda/evals
npm run capabilities:check
npm run check
```

然后用不计分的本地/fake Pier fixture 做 timeout、partial JSONL、patch collection 和 ATIF schema smoke test。只有 Wave A/B 的观测与收尾能力稳定后，才值得启动新的付费 DeepSWE A/B；否则下一轮仍可能得到不可恢复的大日志和缺失资源数据。

## 最优先的产品风险排序

若目标是先保护评测有效性和已完成工作，而不是立即追 pass rate，建议落地优先级为：

1. T02 pipeline exit semantics：直接消除“测试失败却被记录成功”的确定性假阴性。
2. T04 + T03 timeout/finalization：防止 patch 和资源证据再次整体丢失。
3. T06 + T07 + T09 observability：把日志成本和诊断盲区一次性降下来。
4. T08 evidence semantics：修正后续 gate/convergence 所依赖的指标。
5. T01 completion gate：在可信 evidence 之上做有界收尾，而不是继续堆 prompt。
6. T05 patch Tool：提高修改接口深度并减少 Bash mutation。
7. T10 repeated sampling：在 harness 可观测且可收尾后再用重复样本判断效果。

这个顺序与原始 P0/P1 标签略有不同：完成门禁的业务价值很高，但若先用当前失真的 `toolIssues`/`unresolvedFailures` 驱动它，会把正常分页和已修复失败误当成 blocker；先修 evidence seam 能显著降低误杀。
