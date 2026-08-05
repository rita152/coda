[← 返回地图](./README.md)

# 06 · Steering、Follow-up 与取消

Steering、follow-up 和 abort 是 canonical Runtime 的三种不同 mailbox 操作。它们由
`WorkspaceId`、`ThreadId` 与 external `OpId` 标识；调用方不得根据当前 UI 状态把其中一种猜测或改写成
另一种。完整 op、envelope 与 identity 规则见[内部协议](./03-internal-protocol.md)，run/turn 执行边界见
[Agent Loop](./05-agent-loop.md)，跨 thread 路由与恢复见[Supervisor Runtime](./12-supervisor-runtime.md)。

## 1. 三种意图

| 意图 | Canonical RuntimeOp | 何时生效 |
| --- | --- | --- |
| 调整正在进行的工作 | `steer` | 在 ThreadRuntime 的下一处 steering 注入边界进入当前 run。 |
| 排队下一项工作 | `follow_up` | 当前 run 准备结束时作为后续工作输入。 |
| 停止当前工作 | `abort` | Runtime 立即向目标 run 的 `AbortSignal` 传播取消；可用 `expectedRunId` 防止迟到取消命中新 run。 |

`prompt` 不具有隐式降级语义：目标 thread 处于 active run 时，它按 Runtime admission 规则被拒绝；client
应显式选择 `steer` 或 `follow_up`。同一 thread 的 mailbox 是 FIFO，不同 thread 可以并发，且不得互相读写
队列或取消对方的 run。

## 2. 输入与 receipt

所有外部输入都必须是完整的 `RuntimeOp`：

```ts
{ type: 'steer', opId, workspaceId, threadId, text }
{ type: 'follow_up', opId, workspaceId, threadId, text }
{ type: 'abort', opId, workspaceId, threadId, expectedRunId? }
```

`submit()` 的 accepted receipt 仅说明该操作已通过 canonical admission 并由目标 mailbox 接收；它不表示
steering 已进入 provider context、follow-up 已启动 run，或 abort 已完成所有清理。相同 external `OpId` 重投
必须返回同一 receipt，不能重复排队或重复取消。

## 3. 观察

Runtime 以 `EventEnvelope` 输出事实链：

- `queue_update` 给出当前 `steering` 与 `followUp` 的可显示快照；
- `agent_start`、`turn_*`、`message_*`、`agent_end` 表示 run/turn/transcript 生命周期；
- `op_accepted`、`op_started`、`op_completed` 与 `op_rejected` 表示操作生命周期；
- `retry_scheduled` 的 predecessor/successor RunId 说明重试关系，而不是复用旧 run；
- `error`、`agent_end{reason:'aborted'}` 与最终 `op_completed` 共同记录取消结果。

观察者只能消费这些事件，不能修改 queue、transcript、run 或 policy。慢的 headless/UI observer 不得背压
Agent；权威 transcript、control 与 event commit 才能施加必要背压。

## 4. 取消与续跑

`abort` 默认只影响目标 `(threadId, expectedRunId?)`。当 `expectedRunId` 与 active run 不匹配时，Runtime
拒绝该操作，避免网络延迟把旧取消施加到 successor run。取消后的 assistant、工具结果和错误仍按实际发生的
顺序写入可重放 transcript；系统不得伪造未执行工具的结果。

续跑由显式 `continue` 或 conversation retry op 发起。每次续跑/重试都有新的 RunId，并通过 predecessor
关系连接；不得以恢复 UI state、重放旧事件或重新提交旧 op 的方式复活原 run。

## 5. CLI 映射

TUI 的 Enter 与 Esc 只是这些 canonical op 的输入映射。运行中普通 Enter 按 `/insert-mode`
选择的路由：`steering`（默认）映射为 `steer`，`following` 映射为 `follow_up`；idle 时 Enter 始终是
新 `prompt`。TUI 和 human one-shot 通过
Runtime-backed frontend 订阅事件；`--json` 直接接收完整 RuntimeOp。协议版本为 `2.0.0`，不存在旧
identity-free 输入、Session resolver 或 approval bridge。具体 CLI 行为见[CLI 文档](./09-cli.md)与
[CLI UX](./13-cli-ux.md)。
