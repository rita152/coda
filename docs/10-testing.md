# 测试策略

测试默认离线，使用 faux provider、临时目录和可注入的 gate/clock。不得依赖真实 API、密钥、裸 sleep 或开发机状态。

## 1. 层次

| 层 | 位置 | 验证内容 |
| --- | --- | --- |
| 协议 | `src/protocol/*.test.ts` | identity、strict JSON、RuntimeOp、RuntimeEvent、EventEnvelope 校验 |
| 核心 | `src/agent`、`src/session`、`src/runtime` 测试 | lifecycle、mailbox、seq、恢复、control、policy、取消 |
| CLI | `src/cli/*.test.ts` | 参数、composition、renderer、canonical headless、TUI state |
| 集成 | `tests/*.test.ts` | 跨模块并发、storage、provider/capability snapshot、边界规则 |
| E2E | `e2e/*.test.ts` | build 产物、进程、NDJSON、TTY、退出码与 clean-up |

## 2. 必测 runtime 不变量

- 同 thread active run 被拒绝；不同 thread 可并发；abort 只命中指定 run/thread。
- 每个 thread 的 EventEnvelope `seq` 严格递增，恢复后续接；observer 失败不背压 Agent。
- external OpId 幂等：相同 payload 返回同一 receipt，不同 payload 重用 id 被拒绝。
- transcript、error、abort、tool failure 与 control 都能重放；所有开始的生命周期成对闭合。
- catalog/provider/policy snapshot 在 turn 内稳定，热更新只影响下一 turn。
- policy 以 PreparedInvocation 的 canonical resources 决策；grant 不跨 capability digest/policy revision 泄漏。
- pending control 只能由对应 request response 或 abort/close 结案。

## 3. Headless E2E

`e2e/harness.ts` 将 stdout 限定为 canonical protocol hello、`op_receipt`、`transport_error` 或完整
EventEnvelope，并保留 raw frame 供 wire 断言。核心覆盖：

- `e2e/envelope.test.ts`：`2.0.0` hello、create receipt、完整 envelope；
- `e2e/headless.test.ts`：create/prompt、duplicate external OpId、invalid input 后继续、EOF；
- `e2e/approval.test.ts`：`control_request` 到完整 `control_response`；
- `e2e/resume.test.ts`：跨进程 `thread_resume`；
- `e2e/oneshot.test.ts`：`--json -p` 初始 op 序列、retry 与退出码。

所有 e2e stdout 行都必须 JSON 可解析且符合上述 frame 集合。进程关闭使用 EOF；测试不得发送隐藏 shutdown frame。

## 4. 命令

开发中可运行：

```sh
bun --no-env-file test src/cli/headless.test.ts
bun --no-env-file test e2e/envelope.test.ts e2e/headless.test.ts
bun run check
```

最后一条是交付门禁（lint、typecheck、unit、build 与 e2e）。文档改动额外执行 `git diff --check`，并检查
相对链接与测试映射。
