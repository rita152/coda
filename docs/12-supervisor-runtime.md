# Supervisor Runtime

`RuntimePort` 是应用与 core 的唯一运行期边界。它管理一个 workspace 的 thread topology、op admission、
mailbox、storage lifecycle 和 event subscription；它不直接执行 provider stream 或工具。

## 1. RuntimePort

```ts
interface RuntimePort {
  readonly workspaceId: WorkspaceId;
  submit(op: RuntimeOp): Promise<OpReceipt>;
  events(): AsyncIterable<Readonly<EventEnvelope>>;
  close(): Promise<void>;
}
```

factory 还可提供 thread id/op id 分配和只读 query。public entry 无副作用；宿主显式提供 storage、provider
和 capability composition 后才打开 workspace。

## 2. Admission 与 mailbox

Supervisor 先验证 RuntimeOp，再以 workspace/thread identity 路由。thread-targeted op 进入目标 FIFO
mailbox；scope op 以明确的目标集合分发并报告 partial failure。external OpId 和 canonical payload hash
共同形成 idempotency key：相同 key 返回原 `OpReceipt`，冲突 payload 被拒绝。

thread create/resume 建立或恢复独立 ThreadRuntime。prompt/continue 受 active-run gate；steer/follow-up
只进入所属 queue；abort 的 expectedRunId 不匹配时不得触碰 successor。

## 3. ThreadRuntime

ThreadRuntime 拥有 transcript repository、retry/compaction coordinator、event committer、control state 和
per-thread Agent execution。它不持有 workspace thread map。每次 turn 捕获 provider/capability/policy
snapshot；Agent 完成后 ThreadRuntime 以确定顺序持久化结果并提交事件。

## 4. Event subscription

`events()` 在返回时是 hot subscription，避免初始 op 漏事件。每个 envelope 都保留 workspace/thread 与
seq；run/turn/op identity 在适用时保留。慢或失败 observer 只影响自身订阅。subscription gap 必须以结构化
error 终止，不得静默跳过 seq。

## 5. Control 与权限

ThreadRuntime 对需要决定的 invocation 提交 `control_request`，其中有 requestId、owning run/turn、policy
revision 和 presentation。`control_response` 经同一 mailbox admission；accepted decision durable commit 后
才发出 `control_resolved` 和执行/拒绝结果。close/abort 将 pending request 标记为 aborted。

policy grant 使用 workspace-fenced storage，并绑定 capability digest、normalized resource scope 与 policy
basis revision。thread/run narrowing 永远不能扩大 workspace ceiling。

## 6. Durability 与恢复

一个 workspace writer 持有 lease/fence。thread journal 的 mutation 和 event 在 publish 前提交；恢复加载
metadata、transcript、control、grant 与 seq high-water mark。恢复后的新 prompt 产生新 RunId，且不会重放
已接受 op 的副作用。

## 7. Close

`close()` 停止 admission，令 pending work 按 abort/close 语义结案，等待必要 durable writes 与 event drain，
再释放资源和 lease。close 是幂等的；fatal transport 与 signal 可以中断 in-flight activity，但不得绕过
权威收尾。

## 8. 实现检查表

- 不可将 UI、provider credential、TTY 或可变 registry 放入 Runtime protocol/state。
- 不可产生无 workspace/thread identity 的 Runtime input 或 event。
- 不可在 EventCommitter 外分配 seq 或发布权威 event。
- 不可让 observer、renderer 或 transport 写入 transcript/control。
- 不可在响应 control 时重新执行 prepare、重新解析 provider args 或重新查询 registry。
