# 四个开源 Coding Agent 对 Coda Harness 十项缺陷的源码核对

日期：2026-08-13

## 范围与方法

本文只使用官方仓库的源码、测试和仓库文档；所有引用都固定到本次核对时的上游提交，避免链接随主分支漂移。比较对象是 Pi、OpenAI Codex CLI、OpenCode 和 Grok Build。Grok Build 已以 Apache-2.0 仓库公开，仓库也说明公开树由内部 monorepo 同步，并记录 `SOURCE_REV`，因此本次将它作为真实开源实现纳入比较（[README](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/README.md#L31-L35)、[LICENSE](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/LICENSE)）。

本笔记不重复计算 Coda 第 5–11 轮的统计；它回答的是：十项初步判断在真实产品源码中是否有对应问题、哪些设计已经被实践、哪些比较目前没有公开证据。

### 固定版本

| 项目 | 官方仓库 | 本次上游提交 | 提交时间 |
|---|---|---|---|
| Pi | `badlogic/pi-mono` | `581d75a89cea21e50d6a26df840352f94427f633` | 2026-08-13 |
| Codex CLI | `openai/codex` | `902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe` | 2026-08-13 |
| OpenCode | `anomalyco/opencode` | `cc4b45612974f735ddec46009ede07729511fba4` | 2026-08-13 |
| Grok Build | `xai-org/grok-build` | `e5fd4816d43260c15ba785f103990c1ed6cea230`，公开树 `SOURCE_REV=ea094a8c369475f97c85540d01730baec0dce5d6` | 2026-08-13 |

用户提供的本地目录也逐一核对过。`/Users/zp/Desktop/pi` 的 `origin` 是个人 fork `rita152/pi`，HEAD 为 `958c13f25080b59d4b736193f972a8502a7a2f8b`，所以正文以官方 Pi 上游为准；本地 Codex、OpenCode、Grok Build 分别是官方仓库的较早快照 `f9310961`、`bc2d3df`、`393430ee`。这一区分很重要，否则会把 fork 或旧实现误当成当前产品设计。

## 结论

十项方向都成立，但需要两处措辞修正：

1. “完成门禁缺失”不是 Coda 独有；四个产品的普通交互模式仍主要把模型结束当作 turn 完成。Grok Build 的可选 Goal verifier 是公开源码中最接近 harness-owned 完成验证的实现，但其基础设施失败会 **fail open**，不能原样用于 eval 接受门禁。
2. “从竞品照搬解决方案”不适用于 shell pipeline：四个项目都把命令交给普通 shell，均未默认启用 `pipefail`。这一项应由 Coda 自己在 harness 层修正，并用回归测试证明。

| # | 初步判断 | 源码核对 | 最值得借鉴的实现 |
|---:|---|---|---|
| 1 | 完成只靠模型自报 | 确认；行业普通模式普遍如此 | Grok Goal verifier 的 harness-owned gate，改为 eval fail-closed |
| 2 | pipeline 掩盖失败 | 确认；四者也未解决 | 无可直接照搬实现；Coda 显式开启 `pipefail` |
| 3 | 无 run budget 后失控 | 确认 | Codex token budget + Grok max-turn/stationarity 的组合 |
| 4 | 超时不收尾、证据丢失 | 确认 | OpenCode `ensuring(cleanup)`、Pi adapter finally-like 清理、Grok durable log |
| 5 | 修改工具过浅、路径漏记 | 确认 | Codex/OpenCode 多文件 patch；OpenCode Git shadow snapshot、Grok fs watcher |
| 6 | token delta 导致日志放大 | 确认 | Pi delta-only、Codex canonical rollout、OpenCode/Grok terminal/reduced streams |
| 7 | 标准 trajectory 丢 Tool | 确认 | 四者公开 trace/export 都保留 tool call/result；大内容用外部 artifact |
| 8 | toolIssue/unresolved 语义失真 | 确认 | per-call 状态机 + 只把 start-without-terminal 视为 unresolved |
| 9 | 缺失资源静默补零 | 确认 | Grok 明示 incomplete/partial 并隐藏不可信 cost；Pi 跳过缺失样本 |
| 10 | 单次运行无法归因 | 确认 | Pi 的 paired baseline/candidates + repetitions |

## 1. 完成判定：把“模型停了”和“任务通过”拆成不同状态

### 源码事实

- Pi print mode 只把 assistant 的 `error`/`aborted` stop reason 当失败，其余正常退出；eval adapter 也只要求存在非空 assistant 文本且 stop reason 为 `stop`，并不运行任务 verifier（[print-mode.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/coding-agent/src/modes/print-mode.ts#L121-L168)、[pi-harness.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/pi-harness.ts#L90-L107)）。
- Codex exec 把 `turn.completed` 作为成功终态，只对 fatal/failed/interrupted 返回失败；这仍是协议终止判定，不是仓库需求验证（[exec/lib.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/exec/src/lib.rs#L1033-L1141)）。OpenCode 同样在 assistant 有非 tool finish 且无待处理 tool call 时退出循环（[prompt.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/prompt.ts#L1081-L1130)）。
- Grok Build 的可选 Goal 模式由 harness 并行启动独立 skeptic，默认 3 个并做多数判定（[goal_classifier.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/goal_classifier.rs#L1-L11)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/goal_classifier.rs#L103-L116)）。`NotAchieved` 会回传 gaps、受最大次数和重复 gap 指纹约束；`Achieved` 才完成目标（[goal.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs#L2027-L2125)）。但 infra-class verifier 故障被明确映射为 `FailOpenAchieved`（[goal_classifier.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/goal_classifier.rs#L163-L207)、[goal.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs#L2147-L2169)）。这对交互产品可避免内部故障阻塞用户，对 eval 却会制造假阳性。

### Coda 方向

定义三个正交终态，而不是一个 `success`：

- `modelTermination`: `completed | failed | interrupted | timed_out`
- `evidenceStatus`: `complete | partial | missing`
- `verification`: `passed | failed | not_run | infra_error`

只有 `completed + complete + passed` 才是 verified success。模型最终文字只是证据之一，不能改变 verifier 结果。实现上可借鉴 Grok 的独立 verifier、gaps 回灌和停滞指纹，但 eval 路径必须 fail-closed；`infra_error` 单独上报，不能折算为通过。

验收重点：构造“回复 Done 但测试失败”“verifier 自身崩溃”“验证后修复并复验”三个场景，分别得到 `failed`、`infra_error`、`passed`。

## 2. Shell pipeline：竞品也没有默认 `pipefail`

### 源码事实

Pi 在 Unix 上使用 `bash -c`，不可用时退回 `sh -c`，没有 `-o pipefail`（[nodejs.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/agent/src/harness/env/nodejs.ts#L192-L237)）。Codex 依据 shell 类型使用 `-lc`/`-c` 执行原命令，也不加 `pipefail`（[shell.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/core/src/shell.rs#L20-L49)）。OpenCode 把命令交给检测到的 POSIX shell（[shell.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/shell.ts#L293-L310)）。Grok Build 也用检测到的 shell `-c`；其持久 shell wrapper 保存最外层 eval 的状态，甚至在恢复 zsh options 时显式排除 `pipefail`（[terminal.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-tools/src/computer/local/terminal.rs#L3175-L3215)、[shell_state.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-tools/src/computer/local/shell_state.rs#L130-L168)）。

因此 `cargo test | tail` 返回 tail 的 0 是完全符合这些实现的 shell 语义；不能把某一竞品当作已解决范例。

### Coda 方向

eval/harness 模式在确认 shell 支持后使用 `bash -o pipefail -c <command>`；若必须支持 `sh`，不要注入不受支持的选项，而应明确标记 `pipeline_status_unavailable`。Tool 结果同时保留最外层 exit code、signal、timeout 和 shell dialect。至少覆盖：上游失败/下游成功、上游成功/下游失败、多级 pipeline、显式覆盖 `set +o pipefail`、无 Bash 环境。

## 3. 软截止与收敛：组合 token、turn、wall-clock 和 stationarity

### 源码事实

- Codex 有可选 rollout token budget：跨 turn 累加加权 token，并产生剩余额度提醒；当前 feature 仍标为 under-development，且它是 token budget，不是 wall-clock deadline（[rollout_budget.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/core/src/rollout_budget.rs#L16-L118)、[features/lib.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/features/src/lib.rs#L1340-L1349)）。
- OpenCode 有可配置 step 上限；到最后一步时禁用工具并要求总结未完成工作（[max-steps.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/core/src/session/runner/max-steps.ts#L1-L15)）。它还检测完全相同的 tool+input 重复并触发 `doom_loop` 权限门禁，但不是自动的全局截止（[processor.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L353-L380)）。
- Grok headless 暴露 `max_turns`（[headless.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-pager/src/headless.rs#L44-L80)），对相同 tool signature 先 nudge 后 hard-stop，并为 true no-op 设置更低阈值（[turn.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L2013-L2085)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L2728-L2794)）。Goal 模式还会强制 token budget（[goal.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs#L1074-L1095)）。

公开实现中没有找到同时具备“外部绝对软截止、剩余时间入模、停滞检测、保留收尾窗口”的完整方案。

### Coda 方向

Pier 仍拥有不可突破的 hard deadline；Coda 接收一个更早的 absolute soft deadline，并划出独立 finalization window。状态机建议为 `running → wrap_up_requested → finalizing → terminal`。软截止、token/turn budget、重复操作和连续无净 diff 都只能触发收敛/收尾，不能被判为成功。剩余时间/turn/token 应作为结构化状态进入每轮上下文。

验收重点：无 run budget 时仍能在 hard kill 前稳定产出 patch、evidence 和资源统计；重复只读分页不应被误判停滞，重复相同失败命令或连续无净修改才累计 stationarity。

## 4. 超时收尾：先持久化，再尽力优雅终止，最后无条件 salvage

### 源码事实

- Pi eval adapter 即使 harness outcome 抛错，也在后续公共路径快照原生 session JSONL，并统一处理 dispose/cleanup 错误（[pi-harness.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/pi-harness.ts#L128-L243)）。
- OpenCode 在处理前拍 workspace snapshot；每个 step 落 usage/cost/patch；最外层用 `Effect.ensuring(cleanup())`，cleanup 再拍 patch、完成文本/reasoning，并把悬空 tool call 标成 interrupted error（[processor.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L435-L483)、[同文件](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L539-L597)、[同文件](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L627-L683)）。
- Codex rollout recorder 有显式 persist/flush/shutdown ack、失败重试与 shutdown drain（[recorder.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/rollout/src/recorder.rs#L78-L137)、[同文件](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/rollout/src/recorder.rs#L949-L1003)）。Grok 的 session persistence 则给 durable append/ack、flush barrier 和 commit-aware retry 定义了明确语义（[persistence.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/persistence.rs#L203-L228)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/persistence.rs#L1139-L1172)）。

这些都是优雅取消或进程仍可运行时的保证；`SIGKILL` 后任何 `finally` 都不会执行，所以 adapter 必须能从已落盘事件和最终 workspace 独立恢复。

### Coda 方向

在启动子进程前就创建 `adapter-status.json` 和 append-only event/resource 文件。超时时先发 interrupt/TERM，给 finalization window；无论 exec 正常返回、抛 timeout、取消或解析失败，adapter 的 `finally` 都执行：读取/flush 已有状态、提交或直接提取最终 git diff、生成 trajectory/evidence、恢复 token/cost 下界、写 terminal status。hard kill 后父进程仍从 workspace 与增量日志 salvage，不能依赖子进程回调。

## 5. Patch 工具与 changed paths：原生 delta 加最终工作树真相

### 源码事实

- Pi 的 edit 一次只针对一个 path，接受多个 exact replacements，并在 mutation queue 内 read/apply/write；它比单次 edit 强，但仍不是多文件 patch（[edit.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/agent/src/harness/tools/edit.ts#L17-L46)、[同文件](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/agent/src/harness/tools/edit.ts#L89-L124)）。
- Codex `apply_patch` 支持 add/delete/update/move 与多 hunk，先解析/验证，再返回全部 changed paths；turn diff tracker 使用原生 committed delta 构造净 diff（[apply_patch_spec.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L5-L27)、[apply_patch.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/core/src/tools/handlers/apply_patch.rs#L220-L233)、[turn_diff_tracker.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/core/src/turn_diff_tracker.rs#L47-L115)）。但 shell 修改天然绕过原生 tracker。
- OpenCode 同样提供多文件 patch，并在写入前计算所有 hunks/新内容（[apply_patch.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/tool/apply_patch.ts#L72-L191)）；更关键的是每 step 的 shadow Git snapshot 用 `git diff --name-only` 获取路径，因此 shell 修改也可见（[snapshot/index.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/snapshot/index.ts#L318-L380)）。
- Grok 的 Codex-compatible apply patch 先计算变更，再逐文件写入并发出 `FileWritten`（[tool.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-tools/src/implementations/codex/apply_patch/tool.rs#L295-L340)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-tools/src/implementations/codex/apply_patch/tool.rs#L343-L485)）；session fs watcher 把 create/modify/rename/delete 都送入 hunk tracker（[fs_watch.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/fs_watch.rs#L50-L70)）。

### Coda 方向

新增多文件、多 hunk patch tool，整批 preflight，逐文件走现有 atomic mutation writer，并回报 `attemptedPaths`、`committedPaths`、每文件结果及 committed delta。changed paths 的最终权威值应为：原生 mutation evidence 与终态 `git diff --name-status` 的并集；两者不一致要作为 coverage diagnostic，不应只相信原生工具。若 patch 不是跨文件事务，必须显式报告已提交前缀，不能把部分成功包装为全失败或全成功。

## 6. JSON/event 流：canonical compact stream 与 raw delta sidecar 分离

### 源码事实

- Pi 的 JSON mapper 删除累积 message/partial，只保留真正 delta 和常量 usage，使流大小随输出线性增长（[json-event.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/coding-agent/src/modes/json-event.ts#L23-L45)、[json.md](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/coding-agent/docs/json.md#L83-L87)）。
- Codex rollout policy 持久化 final response/tool call/tool output，但丢弃 command output delta、patch delta、text delta 等瞬态事件（[policy.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/rollout/src/policy.rs#L37-L58)、[同文件](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/rollout/src/policy.rs#L121-L182)）。
- OpenCode `run --format json` 只发 terminal tool use/error、step start/finish、完成文本/推理，不逐 token 打印文本 delta（[run.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/cli/cmd/run.ts#L678-L750)）。
- Grok headless 普通 JSON 累积最终文本；partial messages 必须显式开启，message reducer 默认把 delta 合并成最终 frame（[headless.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-pager/src/headless.rs#L44-L55)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-pager/src/headless.rs#L240-L267)）。

### Coda 方向

增加 eval canonical mode：每个 assistant block 只保留 final，tool 只保留 start 与 terminal（或直接一个完整 terminal record），usage/turn/diff 只记边界快照。逐 token delta 放到可选 `raw-events.jsonl.zst` sidecar，不进入默认 ATIF。canonical event 必须有 schema version、稳定 ID 和对 raw artifact 的可选 offset/hash 引用。

## 7. Trajectory：Tool 是一等 step，大输出使用可分页 artifact

### 源码事实

Pi eval harness 会把每个 tool call 的参数和每个 tool result 的内容/error 归一化进 trace，并把原生 JSONL 作为 artifact（[pi-harness.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/pi-harness.ts#L58-L87)、[同文件](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/pi-harness.ts#L184-L218)）。Codex exec JSONL 对 command/file change 输出提供 typed item、exit code 和 status（[exec_events.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/exec/src/exec_events.rs#L96-L188)）。OpenCode 完整 session export 序列化 message parts，包括 tool state/output（[export.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/cli/cmd/export.ts#L69-L145)）。Grok reducer 的 tool record 包含 id/name/input/status/output/location，并在流中更新同一 call（[reducer/mod.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-pager/src/headless/reducer/mod.rs#L40-L97)、[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-pager/src/headless/reducer/mod.rs#L228-L260)）。这些公开实现都没有用“只保留前 32 条命令”作为唯一诊断轨迹。

### Coda 方向

ATIF 中每次 Tool 都必须有 call step 和 terminal result/status；不要固定丢弃第 33 条以后命令。为控制体积，把完整 stdout/stderr 写入 content-addressed、可分页/范围读取的 sidecar，ATIF 保留摘要、字节数、截断原因、artifact URI/hash。RunEvidence 可继续紧凑，但它是索引/摘要，不应是唯一事实源。

## 8. Tool issue 与 unresolved：按 operation 生命周期计算，不累计历史失败

### 源码事实

OpenCode 为每个 call 保存 `pending → running → completed/error`，settle 后从 active map 移除；取消时只把仍悬空的 call 终态化为 interrupted error（[processor.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L123-L204)、[同文件](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/opencode/src/session/processor.ts#L571-L594)）。Codex event processor 会用 terminal item 对齐 started item，处理真正未完成的 item（[event_processor_with_jsonl_output.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L358-L371)）。Grok replay 把同一 tool call 折叠到最新 terminal state，只有 start-only 才保持 pending（[replay.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/session/storage/replay.rs#L84-L143)）。

### Coda 方向

分开四类指标：`terminalFailures`（历史终态失败）、`recoveredFailures`（同一验证目标后续成功）、`pendingOperations`（start 无 terminal）、`observationLimitations`（分页/大小上限）。正常使用非首 offset 是 pagination，不是 issue；只有“请求的内容未完整交付且调用者不知道/无法继续”才是 truncation issue。`unresolvedFailures` 若保留，应由有稳定 identity 的目标状态机计算，而不是所有历史 Tool error 的单调计数。

## 9. 资源与耗时：缺失不是零，累计不是 wall time

### 源码事实

Grok 对这一问题的语义最清楚：wire contract 明确说 cost 只有在存在且不 incomplete/partial 时可信，“缺失不是免费”；error path 也可只发 incomplete 标志（[notification.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L67-L143)）。partial/incomplete 时它删除不可信 cost ticks（[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L145-L157)）；headless 投影也隐藏 cost、保留 `usage_is_incomplete`/`cost_is_partial`，解析失败同样 fail closed（[同文件](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L304-L405)）。session usage actor 读取失败直接报错，而不是给零账单（[usage.rs](https://github.com/xai-org/grok-build/blob/e5fd4816d43260c15ba785f103990c1ed6cea230/crates/codegen/xai-grok-shell/src/extensions/usage.rs#L35-L56)）。

Pi eval reporter 也只输出实际存在的 metrics；summary 对非有限/缺失数据做 eligible-pair 过滤，而不是先补零（[reporter.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/vitest-evals/reporter.ts#L51-L80)、[summary.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/vitest-evals/summary.ts#L212-L244)）。反例是 Codex exec 在缺少 last token usage 时构造默认零 usage（[event_processor_with_jsonl_output.rs](https://github.com/openai/codex/blob/902bd9e06b3ecb32cbf7f8e64cd23b956be3e7fe/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L117-L128)）；这说明“竞品也这么做”不等于适合 eval 汇总。

### Coda 方向

所有资源字段使用 optional/known-state，并同时输出 coverage：例如 `costKnownTrials/totalTrials`、`tokensKnownAttempts/observedAttempts`、`usageStatus=complete|partial|missing`。partial cost 可报告 `knownCostLowerBound`，但不能冒充 total。耗时至少拆成：

- `jobWallElapsedMs`：最早开始到最晚结束；
- `cumulativeTrialElapsedMs`：所有 trial duration 之和；
- 可选 `cumulativeModelApiElapsedMs` 与 `cumulativeToolElapsedMs`。

聚合器不得对缺失用 `?? 0`；每个总数旁都要能回答“覆盖了多少 trial/attempt”。

## 10. 重复样本与 A/B：Pi 提供了最完整的公开参考

### 源码事实

Pi eval 的 harness table 原生表达 baseline/candidates、正整数 repetitions，并按 `(input, repetition)` 生成配对行（[harness-table.ts](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/vitest-evals/harness-table.ts#L28-L42)、[同文件](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/vitest-evals/harness-table.ts#L114-L127)、[同文件](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/src/vitest-evals/harness-table.ts#L157-L192)）。官方 eval 文档给出 `repetitions: 6`、paired baseline/candidates 和可选 shuffle 的例子（[evals README](https://github.com/badlogic/pi-mono/blob/581d75a89cea21e50d6a26df840352f94427f633/packages/evals/README.md#L101-L149)）。

在固定提交的 Codex、OpenCode 和 Grok Build 公开树中，没有找到面向通用 coding task 的等价 paired repeated A/B runner。Grok 的多 skeptic 是单次 run 内的完成分类器，不是对 stochastic task outcome 的重复采样，不能替代 `n_attempts > 1`。

### Coda 方向

让 `n_attempts` 可配置，并以相同 `(task, repetition, seed/runtime)` 配对 baseline 与 candidate；执行顺序随机或交错，控制同时段服务波动。报告 eligible pairs、每侧 pass rate、paired delta、状态翻转矩阵与置信区间；缺失/超时样本单列，不从分母静默消失。开发期可用较少 repetitions 做快速门禁，声称回归改善前再用预先约定的较大样本确认，避免看完结果后追加样本。

## 公开源码没有支持的比较

为避免把“没找到”写成“产品一定没有”，以下结论仅限上面四个固定提交的公开树：

- 没有任何一个普通 shell tool 默认解决 pipeline 上游失败被掩盖的问题。
- 没有任何一个普通交互模式默认把外部仓库 verifier 作为成功必要条件；Grok Goal verifier 是可选目标工作流，并且 infra failure fail-open。
- 没有找到一个同时实现绝对 wall soft deadline、剩余时间入模、收尾窗口和 hard-timeout salvage 的单体方案。
- 没有在 Codex、OpenCode、Grok Build 公开树中找到可与 Pi harness table 等价的通用 repeated paired A/B eval runner；这不代表其内部评测系统不存在。
- 没有任何一个项目可被整体照搬。Coda 最合理的组合是：Grok 的 verifier/stationarity/usage completeness，OpenCode 的 unconditional cleanup 与 Git snapshot，Codex 的 patch/durable rollout/token budget，Pi 的 compact eval trace 与 paired repetitions。

## 建议的十个并行实现任务之间的接口约束

十项可以并行，但应先冻结共享 schema，避免最后无法拼接：

1. Completion task 只消费 verifier/evidence 状态，不自行重跑或猜测资源完整性。
2. Shell task 输出统一 terminal result；trajectory、issue metrics 只消费这个结构。
3. Deadline task 负责发 `wrap_up_requested`，timeout-salvage task 独占 terminal/finally 写入。
4. Patch task 输出 committed delta；changed-path 汇总 task 以终态 Git diff 补全。
5. Compact JSONL 是事实事件流；ATIF 和 RunEvidence 都从它派生，raw delta 只是 sidecar。
6. Resource totals 永远携带 completeness/coverage；summary 层不再推断缺失为零。
7. A/B runner 对每个 attempt 保留独立 terminal/evidence/resource 状态，不能只保存 revision 级平均值。

建议共享的最小 envelope：`runId`、`attemptId`、`turnId`、`operationId`、`eventSeq`、`timestamp`、`terminalStatus`、`evidenceStatus`、`resourceStatus` 和 `artifactRefs`。这使超时恢复、tool 生命周期折叠、coverage 聚合和 paired eval 都能使用同一身份体系。
