# 架构

## 分层

```text
CLI / embedded host
        │ RuntimePort: RuntimeOp / EventEnvelope
        ▼
runtime/        Supervisor、workspace/thread lifecycle、mailbox、storage ports
        ▼
session/        ThreadRuntime、transcript、EventCommitter、retry/compaction
        ▼
agent/          run/turn loop、queue、provider/capability snapshot 的执行
        ▼
capabilities/   catalog、prepared invocation、policy、provider registry
        ▼
providers/      各 provider wire adapter
tools/          内置工具 executor 与 ToolContext
protocol/       identity、消息、op、event 的纯契约
shared/         无业务依赖的基础设施
```

`cli/` 是 composition root 和 presentation 层。它可以注册 provider、capability 和 project-rule
服务，但不得保存 run、队列、policy、seq 或 transcript 的第二份状态，也不得直接驱动 Agent。

## 目录职责

| 目录 | 拥有的语义 | 不得拥有 |
| --- | --- | --- |
| `protocol/` | JSON-safe identity、消息、RuntimeOp、RuntimeEvent、EventEnvelope 校验 | I/O、环境读取、provider SDK |
| `providers/` | 请求/流式 wire 双向转换 | 工具执行、thread 状态、跨 provider 共享 wire 类型 |
| `capabilities/` | registry snapshot、schema、prepared invocation、policy | CLI、具体工具实现、执行期回查 live registry |
| `tools/` | executor、参数契约、`ToolContext` | Agent、Runtime、provider、UI 依赖 |
| `agent/` | 单 thread run/turn 执行、队列和取消 | workspace map、持久化 writer、UI |
| `session/` | 单 thread transcript、event commit、retry/compaction | workspace lifecycle、渲染、provider 翻译 |
| `runtime/` | Supervisor、op 路由、thread 生命周期、storage | 采样模型、执行工具、TTY/UI |
| `cli/` | 参数、composition、TUI、one-shot、canonical headless | core 业务状态机 |

跨层依赖只沿表中从上到下的端口进行；`protocol/` 与 `shared/` 不反向依赖业务层。公共入口必须
无副作用：不读环境、不建文件、不注册 signal、不初始化 provider 或 TTY。

## 权威状态与事件

每个 thread 有一个 `EventCommitter`。它在校验和 durable commit 后分配严格递增的 `seq`，再发布
不可变 `EventEnvelope`。普通订阅者通过异步 hub 接收，不得背压 Agent。恢复从持久化 high-water mark
续接，不产生跨 thread 的总序。

control request、thread lifecycle、agent 生命周期、usage 和 diagnostics 都进入同一 envelope 链。前端只
读取 envelope；任何投影、缓存或 renderer state 都可丢弃并重建。

## 并发与安全边界

- Supervisor 将每个 external op 送入目标 thread 的 FIFO mailbox。
- active-run gate 是 per-thread，不是进程级锁；不同 thread 的 Agent 与 observer 相互隔离。
- abort 以 `(workspaceId, threadId, expectedRunId?)` 收窄目标；迟到 abort 不得误杀 successor run。
- policy 是 workspace 上限，thread/run 只能收窄。control response 只对所属 request/thread 有效。
- tool executor 只接收冻结的 `PreparedInvocation`，不得按名称查找最新 capability。

## 运行形态

TUI、human one-shot 和 canonical headless 共享 `RuntimePort`。前端输入必须先取得完整 identity；输出
必须来自 `EventEnvelope`。`--json` 不提供另一套命令、事件或 approval 协议。
