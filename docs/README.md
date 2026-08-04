# Coda 开发文档

本目录描述当前 canonical Runtime 实现。协议与实现的事实源分别是 `src/protocol/` 和相关生产代码；
本文档解释其不变量、边界与测试映射。历史迁移细节不构成现行承诺。

## 当前基线

- 所有运行期输入为完整 `RuntimeOp`，所有可观察运行期事件为 `EventEnvelope<RuntimeEvent>`。
- `RuntimePort` 是 TUI、one-shot、headless 与嵌入宿主的共同边界。
- Supervisor 以 workspace 管理 thread topology；每个 thread 有 FIFO mailbox、单 active run、durable
  transcript/control 和严格递增的 per-thread seq。
- capability catalog、provider adapter 与 policy 在每 turn 冻结；权限基于 canonical resources 与
  `PreparedInvocation` 决策。
- `--json` 是 protocol `2.0.0` NDJSON：完整 op 输入、hello/envelope/receipt/error 输出、EOF 关闭。
- Agent loop payload 与 CLI view 都是 `EventEnvelope.event` 的内部投影；它们不是第二条 Runtime 协议。

## 阅读顺序

1. [01 Overview](./01-overview.md)
2. [12 Supervisor Runtime](./12-supervisor-runtime.md)
3. [02 Architecture](./02-architecture.md)
4. [03 Internal Protocol](./03-internal-protocol.md)
5. [04 Provider Adapter](./04-provider-adapter.md)
6. [05 Agent Loop](./05-agent-loop.md) 和 [06 Steering / Follow-up](./06-steering-following.md)
7. [07 Tools](./07-tools.md) 与 [08 Thread Persistence](./08-session-persistence.md)
8. [09 CLI](./09-cli.md) 与 [13 CLI UX](./13-cli-ux.md)
9. [10 Testing](./10-testing.md) 与 [11 Delivery Status](./11-roadmap.md)

## 术语

| 术语 | 含义 |
| --- | --- |
| workspace | Supervisor 的资源、线程和 policy ceiling 边界 |
| thread | transcript、mailbox、控制、取消与 seq 的隔离边界 |
| run | 一次 prompt/continue/retry 驱动的 Agent 生命周期 |
| turn | run 内的一次 provider 响应及其工具阶段 |
| op | 调用方提交的 identity-bearing RuntimeOp；external OpId 可幂等重投 |
| envelope | 带 workspace/thread、可选 run/turn/op 与 per-thread seq 的 Runtime event |
| capability snapshot | 一个 turn 固定使用的 schema、validator、executor、policy 输入与 adapter 版本 |

实现、评审和测试必须遵守 [CODING_RULES](./CODING_RULES.md)。新增或改变协议、架构或行为语义时，同步
更新受影响的本目录契约和对应测试。
