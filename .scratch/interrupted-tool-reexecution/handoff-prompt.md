# Interrupted Tool 直接重执行

在仓库 `/Users/zp/Desktop/coda` 上完成 `.scratch/interrupted-tool-reexecution/`：先做架构 triage，找到不复制 Agent 私有 Tool executor 的 seam，再实现交互恢复里的第三条选择 `re-execute`。

这是当前 tracker 里唯一 `active` 的 feature。issue 仍是 `needs-triage`。先决定 seam，再写代码。

## 先读（按这个顺序）

1. `CONTEXT.md` — 只用这里的词：Interrupted Tool Invocation、Tool Invocation、Tool Observation、Tool Settlement、Agent Seed、Session Record、Run。不要发明 replay API / Harness action / 子 Agent。
2. `.scratch/interrupted-tool-reexecution/spec.md`
3. `.scratch/interrupted-tool-reexecution/issues/01-direct-interrupted-tool-reexecution.md`
4. `docs/adr/0025-journal-tool-start-before-side-effects.md`
5. `.scratch/coda-coding-agent/spec.md` 里 **Tool crash barrier**（历史要求：交互 recover 要能 skip 或 **explicitly re-execute**；`replay: never` 只能 skip）
6. 现行实现：
   - `packages/coding-agent/src/session/session-recovery.ts` — `InterruptedToolRecovery` 只返回 `"cancel" | "skip"`
   - `packages/coding-agent/src/node-application.ts`（约 266–299 行）— 交互只有 Cancel / Skip
   - `packages/coding-agent/test/session-file.test.ts` — skip 路径的现有契约
   - `packages/agent/src/agent.ts` — `#executeToolBatch` / `#executeSingleTool`（私有）
   - `packages/agent/src/types.ts` — `ToolInvocation`、`AgentTool.execute`、`replaySafety`
7. `docs/agents/issue-tracker.md` 和 `docs/agents/triage-labels.md`
8. 需要加深模块或挪 seam 时读 `.agents/skills/codebase-design/SKILL.md`
9. 实现阶段读 `.agents/skills/tdd/SKILL.md`，测试只打在事先写下的 public seam 上

## 现在的行为

恢复发生在 Agent Seed 重建之前。`SessionRecovery.recover` 看到未匹配的 `tool_started` 就停下来问人。

- **print / 无 handler**：抛错。自动重放被禁止。
- **Cancel**：整次 resume 失败。
- **Skip**：追加 `tool_finished`（`outcome: "interrupted"`）和一条 error `toolResult` Message；side effects 标 `unknown`。之后模型可以再调一次同名 Tool。

`edit` / `write` / `bash` / `process` / MCP 的 `replaySafety` 是 `"never"`。

## 必须守住的不变量

用这些话当设计约束，而不是事后检查清单：

1. **只有用户显式选 `re-execute` 才会再跑。** 启动、resume、restore 都不会自己重放。
2. **`replaySafety: "never"` 的选择仍是 Cancel 或 Skip。** `re-execute` 只对 `"safe"`（以及你 triage 后明确写进测试的其它值）。
3. **新的 Tool Invocation 用新的 `id`。** `providerToolCallId` 和 transcript 需要的 Provider Tool Call 关系保持不断。
4. **新的 `tool_started` 先落到 Session journal，再 `execute()`。** Settlement 之后立刻写 `tool_finished`。沿用 ADR-0025，不要另开一条 journal 时序。
5. **恢复结束后的 Agent Seed 必须 idle，且 Interrupted Tool 窗口已经闭合。** Seed 里没有未匹配的 `tool_started`，也不暴露 reducer / executor。
6. **执行走现有 Agent Tool 路径**（lookup → schema 校验 → `execute` → 取消）。Coding Agent 里不要再写一份 executor。需要的话把 Agent 里已经存在的执行加深成一个小的 public port，而不是在 application 层抄一份。
7. **print 模式继续 fail-closed。** 这次只做 interactive。
8. **不要把未完成的 Harness action API 做成 Coda 的 public contract。**

## 工作顺序

### 1. Triage 并选定 seam

弄清这三件事，写进 issue 的 `## Comments`（或单独一小节），再改代码：

- **执行发生在哪一刻？** 恢复中（journal 还开着、Agent 还没 idle seed）还是恢复后（Seed 已 idle，再开一次有界执行）？两种都要能说清不变量 5。
- **谁拥有 `execute`？** 指出将要调用的现有函数/port。没有这样的 port，就设计一个最小的 Agent 侧 interface，而不是在 `@coda/coding-agent` 里复制 `#executeSingleTool`。
- **`replay: never` 的 UI 文案和返回类型怎么扩？** `InterruptedToolRecovery` 今天是 `"cancel" | "skip"`。

完成标准：issue 里有一段可执行的 seam 说明（调用方、journal 顺序、新 identity、`"never"` 如何保持 skip-only）。若找不到不破坏不变量的 seam：把 issue 标成 `ready-for-human`，写清阻塞点，**停在设计**，不要硬写。

### 2. 实现（只在 seam 成立之后）

1. 把 issue `Status:` 改成 `claimed`。
2. 按 `.agents/skills/tdd/SKILL.md` 做。先写下测试 seam（至少：`SessionRecovery` 的决策类型；interactive 选择；journal 里新的 start/finish 对）。未经确认不要测 Agent 私有方法。
3. Red → green，一次一条行为：
   - interactive 对 `replaySafety: "safe"` 出现第三条 `re-execute`
   - `re-execute` 分配新 Tool Invocation id，保留 `providerToolCallId`
   - 新 `tool_started` 在 side effect 之前 durable
   - lookup / 校验 / 取消走 Agent Tool 路径
   - `"never"` 仍然只有 Cancel / Skip；选 `re-execute` 必须不可得或被拒绝
   - print 仍然对 Interrupted Tool 失败
   - 现有 skip/cancel 测试继续过
4. 接受的行为写进 ADR（新条目或补 ADR-0025）以及 `@coda/coding-agent` README 里现行恢复段落。
5. 每一个 issue 都 `resolved` 之后，把 spec 标成 `implemented`，并链到 ADR / README / 测试。

完成标准：`npm test` 覆盖上述行为；interactive 恢复对 safe Tool 能直接重跑；never Tool 不能；journal-before-side-effects 仍在；Agent Seed 在恢复后 idle 且 Interrupted 窗口已闭合。

## 这次不要做

- 自动重放、print 模式重执行、Work Item crash resume、恢复已删除的 `patch` Tool
- Session rename/archive/delete、SDK/RPC、OAuth
- DAG UI 或把 child Work Item Steering 塞进这次

## 词汇

Interrupted Tool Invocation、Tool Invocation、Tool Observation、Agent Seed、Session Record。对用户可见文案用 “re-execute”，不要用 “replay” 当产品名（ADR-0025 里的 “never replay automatically” 仍是不变量）。
