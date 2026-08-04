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
和 capability composition 后才打开 workspace。`CreateRuntimeOptions` 只有 canonical registry composition，
不暴露单值 `capabilityMode`；thread driver 使用 `RuntimeThreadDriverFactory` 与
`ThreadDriverHostServices` 两个 canonical contract，不保留迁移别名或 mode requirement。

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

Supervisor 必须向 EventHub 一次性注册每个 thread 的 durable high-water、replay retention 起点和 storage
replay loader；未注册 thread 的 publish 失败。EventHub 不 seed 全部历史，也不保留 per-thread envelope tail。
带 cursor 的 subscriber 先捕获订阅瞬间 high-water，再按需从 storage 读取有限范围，
最后从该 boundary 无缝切到 live；这一 handoff 不得丢失或重复 envelope。cursor 早于 retention 起点仍产生既有
structured gap。无 cursor 的 workspace/TUI subscription 从注册 high-water 后观察 live event，不为建立游标
预读所有 thread snapshot；consumer 收到的 `message_update` 始终是重建后的完整 public envelope。
新建 thread 从创建起就安装同一 lazy loader；每次 durable live commit 在 journal append 后、live publish 前
推进其 storage range，所以全局有界 live 顺序缓冲的裁剪不会使已落盘的同进程新事件丧失 cursor replay 能力。
该全局缓冲只负责 storage/live handoff、慢 observer、filtered subscription 和 structured gap；普通 subscriber
仍使用相互隔离的有限队列。

## 5. Control 与权限

ThreadRuntime 对需要决定的 invocation 提交 `control_request`，其中有 requestId、owning run/turn、policy
revision 和 presentation。`control_response` 经同一 mailbox admission；accepted decision durable commit 后
才发出 `control_resolved` 和执行/拒绝结果。close/abort 将 pending request 标记为 aborted。

policy grant 使用 workspace-fenced storage，并绑定 capability digest、normalized resource scope 与 policy
basis revision。repository 的 `workspaceId` 与 Supervisor lease/fence 已完整表达归属，不另设单值 grant
mode；host 返回 own、继承或不可枚举的退役 `mode` 都必须在 attachment/policy execution 前拒绝。
thread/run narrowing 永远不能扩大 workspace ceiling。

## 6. Durability 与恢复

一个 workspace writer 持有 lease/fence。thread journal 的 mutation 和 event 在 publish 前提交；恢复加载
metadata、transcript、control、grant 与 seq high-water mark。恢复后的新 prompt 产生新 RunId，且不会重放
已接受 op 的副作用。

初始化以 strict catalog 为 locator 集合，不 fold 所有 journal。clean、未附加 thread 只常驻 meta、summary、
high-water 和 storage locator；只有 catalog 标记存在 mailbox/control/cancel/input/activity/result-outbox 等未完成
义务的 thread 才 eager recovery，显式 resume/query/fork/retry/cancel-scope 再 lazy load 目标。workspace listing
只读 binding/catalog；reconcile 只做 header、stat 和 boundary 对账，并把同一个 validated locator 传给 open/load，
所以无关历史正文不参与 clean 启动，必要冷恢复中一个 journal 也不重复全文解析。
catalog 缺失/损坏时只从 header 重建保守 locator 并将 thread 标记为待恢复；不借此绕过旧 v2
版本门禁。崩溃后已存在的 create/fork 只核对 immutable header/seed 前缀，不在 `loadState()` 之前
再解析一次正文。

可信 recovery snapshot 与 journal 的 inode/size/time boundary 绑定，包含所有确定性恢复状态、identity set、
sequence/compact-codec state 和有界 replay tail。exact boundary 直接恢复，append-only boundary 只 fold tail，
snapshot 缺失、损坏、replace 或 truncate 才单次流式 full fallback。journal append 先 fsync 并将 catalog 标为
`recoveryRequired`；snapshot 原子 rename/fsync 后才能清除 hint。tail repair 仍只允许在当前 workspace fence 与
thread write lease 下执行。

storage 的 `loadState()` 边界只返回 folded recovery state。Supervisor 不机械透传 physical records，attached
`ThreadJournalWriter` 也只持有 folded state 并增量验证新 append；因此 session/runtime 常驻内存不随该 thread
的 live journal record 数增长，cold full fold、tail fold 与 snapshot fold 仍由 storage 负责且互为恢复 oracle。

Op terminal、accepted FIFO seq、queue effect、thread result 和 control resolution 是独立 recovery index，随
snapshot 校验/物化；恢复正确性不依赖有界 replay tail。snapshot 自身对 replay window 也使用“至多一个中段
seed partial + 后续 delta”的紧凑表示，decode 后仍得到逐字段相同的连续 public envelope。

durable journal grammar 是 clean-break v3；旧 v2 在正文读取前明确报 `unsupported_journal_version`，不迁移、
不双读且不静默删除。公开 Runtime protocol 仍为 2.0.0，完整 EventEnvelope 语义不随 physical codec 改变。

`WorkspaceWriteFenceAuthority` 只作为 deprecated 的窄 public type 保留给既有 embedding；单独
`validateWriteFence()` 是诊断性检查，不能授权随后写入。canonical host 应实现完整 workspace storage port，
并在同一原子 mutation/CAS 中比较 captured fence，避免 check-then-act 竞态。

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
- 不可为 canonical-only runtime、driver 或 grant storage 重新增加单值 mode selector 或同义公共别名。
- 不可通过扫描 journal 正文实现 workspace listing，或在启动时为所有 thread 请求完整 snapshot。
- 不可把 provider 的累计 `partial` 原样重复写入 durable delta record；compact decode 后才可向 consumer replay。
- 不可让未附加 thread 的完整 envelope history 随 workspace 历史量常驻；只保留有界 replay tail。
