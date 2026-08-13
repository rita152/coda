# DeepSWE 第 5–11 轮 harness 缺陷数据审计

审计时间：2026-08-13。代码快照：`6aea277ea801d34028af993c68a3c0eb3e5256ba`；第 11 轮 runtime 内容摘要：`a683d6820615b0511e635dd61de716225476b1c059572f774bcaf0791e186fc8`。

数据源是本目录的 round 5–11 summary/compare/result，以及 `esp32:/home/esp/coda-evals/jobs/coda-deep-swe-r10-af7d243525ba` 和 `.../coda-deep-swe-r11-a683d6820615` 下的原始 `coda.jsonl`、trajectory、patch、verifier 输出。远端只做了读取和流式聚合。

## 总结

| # | Verdict | 审计结论 |
|---:|---|---|
| 1 | **Confirmed** | 19 个正常 Coda Run 全部自报成功/exit 0，但仅 9 个 verifier 通过；完成门禁确实只检查 Run outcome 和最终 Assistant Message。历史 `43` 需要解释为 `reward == 0`，严格的 `status == failed` 是 42。 |
| 2 | **Confirmed（有口径 caveat）** | Bash 确实没有 `pipefail`，Boa 轨迹直接证明失败被 pipeline 尾命令改写成 exit 0。`1,225` 是“命令文本包含任意 `|`”的词法计数；排除纯 `||` 后为 1,224，不能等同于完整 Shell AST 的 pipeline 数。 |
| 3 | **Confirmed** | Arktype 的 260 turns / 261 completed attempts / 290 tools / 186 Bash / 39 successful edit-or-write 均精确复现；没有 Run budget 后只剩 Pier 5,400 秒硬超时。 |
| 4 | **Confirmed** | 超时任务有 39 次成功原生修改，但 patch 为 0、缺 status/evidence/trajectory、`agent_result` 全 null；adapter 收尾确实全在 `await environment.exec(...)` 之后且无 `finally`。 |
| 5 | **Partially confirmed** | 原生 mutation 只有 exact-text `edit` 与整文件 `write`，changed-path 188 对 patch 217、Cliffy 13 对 35 均确认。`333` 的 Shell mutation 分类器/定义未给出；独立词法筛选得到 361 个候选，因此量级成立但不能认证“恰为/至少 333”的同一统计口径。 |
| 6 | **Confirmed** | 20 个 JSONL 合计 1,059,515,650 B；2,680,975 条 `message_update` 占 1,015,733,287 B，即 95.8677%。 |
| 7 | **Confirmed** | ATIF 只有 user/agent step；19 个完成 Run 的 1,647 条 Bash evidence 保留 608、遗漏 1,039（63.0844%）。 |
| 8 | **Partially confirmed（数字需纠正）** | 249 个已保留 issue 中：Bash 110、read **122 total = 118 output_truncated + 4 not_found**、edit 13、grep 2、ls 2。分页被算 issue 与历史失败不消解的机制成立；原文“122 个 read output_truncated”不成立。 |
| 9 | **Confirmed** | 缺失 usage/cost 被静默按 0 累加；恢复 Arktype 后已知成本为 `$0.9709328832`，当前报告少计 14.5412%（以已知总额为分母）。`elapsedMs` 是 32,376,354 ms 的 trial 累加，job wall time 是 6,430,165 ms。 |
| 10 | **Partially confirmed** | `n_attempts: 1`、20%–80% 通过率、56/120 翻转、10→11 的 9/20、Boa 每次相邻轮都翻转均确认。但各轮 harness revision 不同，现有设计不能把 56 次翻转进一步拆成“采样噪声”和“真实改动效应”；它能支持的结论是单样本不能可靠做因果归因。 |

## 逐项证据

### 1. 完成门禁

- [round-11-summary.json](./round-11-summary.json) 的 `summary` 为 `passed=9, failed=10, errors=1`；19 个非 error trial 的 `codaExitCode=0`、`runOutcome="success"`、`committed=true`。因此有 10 个“Coda 正常成功、verifier 失败”的 trial。
- 远端 10 个失败 trial 的 `agent/trajectory.json -> .steps[-1].message`：9 个以 `Done.` 开头，1 个（cattrs）以 `All done.` 开头。
- 对 [round-5-summary.json](./round-5-summary.json) 到 [round-11-summary.json](./round-11-summary.json) 复算：`reward == 0 && partial > 0.98` 为 43；若排除 round 11 Arktype 的 `status="error"`，`status == "failed" && partial > 0.98` 为 42。
- [application.ts](../../packages/coding-agent/src/application.ts) `2555–2571`：只在 `result.outcome !== "success" || !result.finalMessageId` 时返回 1；随后只验证最终消息存在，最终返回 0。这里没有需求覆盖、diff 或测试闭环门禁。

### 2. pipeline 掩盖失败

- 第 11 轮原始 JSONL：`tool_execution_start && toolName=="bash"` 为 1,833；command `contains("|")` 为 1,225（66.8303%）；用 `(^|[^|])\\|([^|]|$)` 排除纯 `||` 后为 1,224。
- 第 10 轮 Boa 多个事件的 observation 是 `exitCode=0/outcome=success`，但文本直接含编译失败。例如：

  ```text
  RUSTUP_HOME=/root/.rustup CARGO_HOME=/root/.cargo cargo check -p boa_engine --offline 2>&1 | tail -50
  # observation exitCode=0；输出含 “could not compile ... due to 18 previous errors”

  RUSTUP_HOME=/root/.rustup CARGO_HOME=/root/.cargo cargo test -p boa_engine --offline --lib tests::evaluation 2>&1 | tail -50
  # observation exitCode=0；输出含 Rust 编译错误
  ```

- 同一 trial 的 `verifier/reports/new_run.log` 有 9 个 `error[E0061]`；[round-10-summary.json](./round-10-summary.json) 对 Boa 记录 `f2pPassed=0, f2pTotal=17`。
- [bash.ts](../../packages/coding-agent/src/tools/bash.ts) `171–179` 仍是 `shellExecutable`, `args: ["-c", command]`，无 `pipefail`。因此缺陷本身完全确认；仅 1,225 的“pipeline”命名应保留词法口径说明。

### 3. 无软截止或收敛检测

- Arktype `coda.jsonl` 精确计数：`turn_start=260`、`attempt_start=262`、`attempt_end=261`、`tool_execution_start=290`、Bash start=186、成功 edit/write end=39、`run_end=0`、`run_evidence=0`。
- [round-11-config.json](./round-11-config.json) 的 `.agents[0]` 是 `max_timeout_sec=5400`、`kwargs.run_budget_enabled=false`；[Arktype result](./round-11-job/arktype-json-schema-refs-depende__yhHuVrG/result.json) 是 `AgentTimeoutError`。
- [coda_agent.py](../../packages/evals/pier/coda_agent.py) `109–113` 只在 `--max-turns` 与 `--no-run-budget` 间选择；`158–163` 的 `environment.exec` 没有传递 deadline/remaining time/soft-stop 给 Coda。软截止、停滞检测、收尾窗口属于合理修复方向，但不是这些数据本身能确定的唯一算法。

### 4. 超时收尾非事务性

- 远端 Arktype 文件事实：`agent/coda.jsonl=272,702,381 B`，`artifacts/model.patch=0 B`；不存在 `agent/adapter-status.json`、`agent/trajectory.json`；JSONL 无 `run_evidence`。
- 本地 [Arktype result](./round-11-job/arktype-json-schema-refs-depende__yhHuVrG/result.json) 的 `.agent_result` 中 token、cost、steps、metadata 全为 null，但 verifier 仍运行并得到 `f2p=0/25, p2p=1679/1679`。
- 对 261 个 `attempt_end.candidate.message.usage` 求和，可恢复：raw input 154,001、cache read 38,463,744、input+cache 38,617,745、output 546,831、cost `$0.1411856516`。
- [coda_agent.py](../../packages/evals/pier/coda_agent.py) `158–170`：读取事件、读取 status、populate context、写 trajectory、检查 commit 均位于 await 之后，无异常路径 `finally`。

### 5. 原生修改工具过浅

- [contracts.ts](../../packages/coding-agent/src/tools/contracts.ts) `1–15` 的内建工具只有 `edit`、`write`，无 patch；[edit.ts](../../packages/coding-agent/src/tools/edit.ts) `11–21, 135–157` 是单文件 exact-text replacement。
- [run-evidence.ts](../../packages/coding-agent/src/run-evidence/run-evidence.ts) `14–15, 385–411, 468–476` 只把 `edit/write` 记为 changed path，Bash command 不进入 changed paths。
- 第 11 轮完成 Run 的 evidence：changed 188、omitted changed 0；19 份 `model.patch` 中 `diff --git` 条目 217。Cliffy 分别为 13 与 35。
- 独立候选筛选（in-place sed、write API、非-fd redirection、cp/mv/rm/touch/mkdir/install/ln、常见 write formatter 的并集）命中 361/1,833 Bash invocation。它验证“数百个”量级，但因 Shell 文本需要 AST/执行级分类，不能严格复现未给定义的 333。

### 6. JSON delta 日志放大

- 远端 `stat -c %s */agent/coda.jsonl` 求和：1,059,515,650 B。
- 对每行以 `"type":"message_update"` 分类并计入换行：2,680,975 行、1,015,733,287 B、95.867700208%。
- [application.ts](../../packages/coding-agent/src/application.ts) `2520–2545` 对每个 Agent event 立即 `JSON.stringify(...)` 并写一整行；没有 eval 聚合模式。

### 7. 标准 trajectory 丢 Tool，compact evidence 截断

- [coda_agent.py](../../packages/evals/pier/coda_agent.py) `259–292` 只遍历 `attempt_end`，追加 `source="agent"`；远端 19 份 trajectory 的 source 只有 user=19、agent=2,466，tool=0。
- [run-evidence.ts](../../packages/coding-agent/src/run-evidence/run-evidence.ts) `4–10` 固定 `MAX_COMMANDS=32`，每条 command 另限 512 字符。
- 19 个 `run_evidence`：commands retained=608、`omitted.commands`=1,039、总数=1,647；遗漏率 `1039/1647=63.0844%`。超时 Arktype 的 186 条 Bash 因无 evidence 不在这组分母中；全轮 Bash 总数是 1,833。

### 8. toolIssue 与 unresolvedFailures 语义

- 19 个 `run_evidence` 的 249 个已保留 issue 按 tool：Bash 110、edit 13、grep 2、ls 2、read 122。read 进一步拆分为 **118 output_truncated + 4 not_found**；因此原文把 122 全归为 truncation 是计数错误。
- [read.ts](../../packages/coding-agent/src/tools/read.ts) `79–84` 定义 `truncated = start > 0 || start + limit < lines.length`，所以 offset > 1 即使成功读取到 EOF 也必定 truncated；[run-evidence.ts](../../packages/coding-agent/src/run-evidence/run-evidence.ts) `490–507, 654–662` 把任意 truncated observation 记成 issue/output_truncated。
- 原始全轮（含无 evidence 的 Arktype）read end=372、truncated=139，其中 offset>1 为 112、无 offset 为 27、not_found=4。19 个正常 Run 的 118 个 read truncation 与上述 evidence 一致（Arktype 贡献其余 21 个）。
- [round-11-summary.json](./round-11-summary.json)：passed 的 unresolved 总和 71/9=`7.8889`，failed 为 56/10=`5.6`；通过的 Boa 为 16。[run-evidence.ts](../../packages/coding-agent/src/run-evidence/run-evidence.ts) `509–531` 对每次失败直接 append，只消解被 retry 的 attempt error，不按后续同命令/同目标成功消解 tool failure。该指标在本轮的方向确实与通过率相反；一轮均值不足以声称普遍负相关，但足以否定其当前形态是可靠成功代理。

### 9. 资源覆盖率与 elapsed 语义

- [deep-swe.ts](../../packages/evals/src/deep-swe.ts) `491–493` 明确以 `value ?? 0` 汇总；`609–629` 对 token/cost/time/issue 均未输出 coverage。
- [round-11-summary.json](./round-11-summary.json) 报告 `$0.8297472316`。加上第 4 项恢复的 `$0.1411856516` 得已知总额 `$0.9709328832`；少计额/已知总额=`14.54123699%`。若以当前报告为分母，增量则为 17.0155%，所以“低报约 14.5%”应明确采用前一种分母。
- usage/cost trial coverage 是 19/20；报告没有 partial/completeness 标记。
- summary `.elapsedMs=32,376,354`。Pier job [result.json](./round-11-job/result.json) 从 `2026-08-13T10:10:50.675539` 到 `11:58:00.840404`，wall=`6,430,164.865 ms`，四舍五入 6,430,165 ms；[round-11-config.json](./round-11-config.json) concurrency=10。当前 `elapsedMs` 由 [deep-swe.ts](../../packages/evals/src/deep-swe.ts) `523–526, 614` 对 trial 时长求和，命名确实含混。

### 10. 单次 revision 无法归因

- [deep-swe.ts](../../packages/evals/src/deep-swe.ts) `376–380` 硬编码 `n_attempts: 1`；第 5–11 轮 config/summary 均为每任务一次。
- 通过数依次为 `9, 4, 16, 10, 9, 10, 9`，即 45%、20%、80%、50%、45%、50%、45%。
- 相邻 pass/non-pass 翻转数：5→6=`7`、6→7=`12`、7→8=`8`、8→9=`9`、9→10=`11`、10→11=`9`；合计 56/120=`46.6667%`。Boa 六组比较均翻转。[round-9-10-compare.json](./round-9-10-compare.json) 和 [round-10-11-compare.json](./round-10-11-compare.json) 也直接记录后两组。
- caveat：这些不是同 revision 的重复抽样，而是不同 harness revision 的连续开发轮；翻转同时混有模型随机性与真实 treatment effect。重复样本、固定对照或交错 A/B 是解决“无法归因”的有效设计方向，但现有数据不能在三者中选出唯一方案或估计纯采样方差。

## 核心复现命令

本地汇总（严格 failed 与 reward=0 的口径差异）：

```bash
jq -s '[.[] .trials[]] | {reward0_hi: map(select(.reward==0 and .partial>0.98))|length, failed_hi: map(select(.status=="failed" and .partial>0.98))|length}' \
  .scratch/deep-swe-evals/round-{5,6,7,8,9,10,11}-summary.json
```

第 11 轮 Bash/pipeline/delta 计数（远端 jq 的核心 predicate）：

```text
tool_execution_start && invocation.toolName == "bash"
command | contains("|")
command | test("(^|[^|])\\|([^|]|$)")
type == "message_update"
```

evidence 保留/遗漏命令：

```bash
ssh esp32 'jq -s '\''[.[]|select(.type=="run_evidence")] | {retained:(map(.commands|length)|add), omitted:(map(.omitted.commands)|add)}'\'' \
  /home/esp/coda-evals/jobs/coda-deep-swe-r11-a683d6820615/*/agent/coda.jsonl'
```

patch path 计数：

```bash
ssh esp32 'grep -h "^diff --git " /home/esp/coda-evals/jobs/coda-deep-swe-r11-a683d6820615/*/artifacts/model.patch | wc -l'
```
