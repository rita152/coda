# Coda 概览

Coda 是以 workspace 为作用域、以 thread 为并发单元的本地编程代理。所有生产入口都通过
`RuntimePort` 提交带身份的 `RuntimeOp`，并消费带身份与 per-thread `seq` 的
`EventEnvelope`。没有默认 thread、裸命令或第二条事件事实链。

## 核心模型

- `WorkspaceId`、`ThreadId`、`RunId`、`TurnId`、`OpId` 是不可互换的 opaque identity。
- 一个 thread 同时至多一个 active run；不同 thread 可以并行。
- transcript、控制请求、事件序号和持久化提交是权威事实；UI 和 headless 都是消费者。
- 每次 prompt、continue 或 retry 创建新的 run；外部 `OpId` 重投返回同一 receipt，不重复副作用。
- capability catalog、provider adapter 和有效 policy 在每个 turn 开始时冻结为 snapshot。

## 入口

`coda` 的 TUI、一次性输出和 `--json` 都是同一个 Runtime 的前端。`--json` 是 canonical
NDJSON transport：stdin 逐行提交完整 `RuntimeOp`；stdout 仅包含协议 hello、完整
`EventEnvelope`、`op_receipt` 与 `transport_error`。EOF 是正常 transport 关闭边界。

`-p` 是 CLI 便利语法。composition root 负责先构造带 workspace/thread/op identity 的
create/resume 与 prompt 操作，随后仍走相同 transport 和 Runtime 路径。

## 文档地图

| 文档 | 事实源 |
| --- | --- |
| [02 Architecture](./02-architecture.md) | 目录边界、依赖方向和权威状态 |
| [03 Internal protocol](./03-internal-protocol.md) | identity、op、envelope、control wire |
| [04 Provider adapter](./04-provider-adapter.md) | provider 的流式适配边界 |
| [05 Agent loop](./05-agent-loop.md) | run/turn、队列、取消和快照 |
| [07 Tools](./07-tools.md) | capability、权限和控制请求 |
| [08 Thread persistence](./08-session-persistence.md) | workspace/thread durable state 与恢复 |
| [09 CLI](./09-cli.md) | CLI 路由、headless 与输出纪律 |
| [10 Testing](./10-testing.md) | 分层测试和必测不变量 |
| [12 Supervisor runtime](./12-supervisor-runtime.md) | Supervisor、mailbox、存储和 lifecycle |
| [13 CLI UX](./13-cli-ux.md) | TUI 和一次性界面行为 |

`docs/CODING_RULES.md` 是实现、评审与测试的强制规则；本文档不覆盖它。
