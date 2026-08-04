# Thread 持久化与恢复

持久化事实按 workspace 和 thread 组织。Runtime storage 保存 thread metadata、transcript、event journal、
control 状态、policy grants、catalog/policy revision 所需快照和每个 thread 的 event high-water mark。

## 1. 写入顺序

`EventCommitter` 在发布前完成以下顺序：

1. 校验 event 与关联 mutation 为严格 JSON；
2. 深拷贝、冻结提交值，并从已提交 high-water 计算该 thread 的下一个 `seq`；
3. 在 durable store 原子追加完整 envelope 与 transcript/control/thread mutation；
4. durable append 成功后发布同一个 `EventEnvelope` 给异步 observer。

任何失败都不能暴露半提交 event。普通 observer 失败、慢消费或退订不会回滚 durable 事实，也不会背压
Agent。

## 2. Transcript

transcript 是可重放的权威消息序列。用户、assistant、tool result、错误、abort 和 compaction 的结果都
以完整消息和关联 event 留存。恢复时以 durable transcript 重建 thread，新的 run 使用新 RunId，并从
最后 committed `seq` 后续接。

## 3. Workspace ownership

一个 workspace writer 使用 Supervisor lease/fencing。错误 workspace、stale fence 或冲突 attachment
必须失败而不是继续写入。不同 workspace 和不同 thread 可并行；同一 thread 的 op 永远经其 FIFO mailbox
串行 admission。

## 4. Control 与 policy

pending control request、其 owning run/turn、response claim 和最终 resolution 都是 durable 状态。恢复时
必须确定性地恢复或以 `aborted` 结案，不能遗留可再次执行的授权。policy grant 按 canonical resource
scope、capability digest 与 policy basis revision 保存。

## 5. Compaction 与 retry

compaction 和 retry 由 ThreadRuntime 协调，写入其 activity/run relation 和必要的 transcript mutation。
它们不能改写既有 committed history；发生恢复后仍遵守 active-run gate、seq 递增和 cancellation 语义。

## 6. 存储边界

storage implementation 负责路径、原子写、fsync/rename、lock/lease 与损坏处理；其公共输入输出必须仍是
canonical protocol value。CLI 参数、TTY、provider credentials 和 renderer state 不进入 durable record。

## 7. Protocol compatibility gate

runtime-v2 thread journal 的第零条记录必须是 `thread_meta`。file storage 先只读取并解析该完整首行，判定
`protocolVersion` 后才读取 journal 正文；在门禁成功前不得校验/折叠 event、mutation、transcript 或恢复任何
可执行状态。因此，即使正文同时损坏，不支持的 metadata 版本也必须优先产生版本错误，且不得触发 tail repair。

当前 strict recovery reader 的唯一支持范围是 canonical core SemVer `2.0.x`：

- 版本必须严格写成无前导零的 `MAJOR.MINOR.PATCH`；prerelease、build metadata、空白和其他形态均为
  `malformed_protocol_version`。
- major 小于 `2` 已淘汰，报 `retired_protocol_major`；major 大于 `2` 报
  `unsupported_protocol_major`。
- major 为 `2` 时只支持 minor `0`；更高 minor 报 `unsupported_protocol_minor`。reader 不推定未来 minor
  的 journal grammar 或恢复语义向后兼容。
- `2.0` 内的任意 patch 可读；按本契约，patch 不得改变 durable grammar 或行为语义。创建新 journal 时仍须
  精确写入唯一的 `PROTOCOL_VERSION`，其他可读 patch 也会以 `protocol_version_write_mismatch` 拒绝成为新
  metadata。

`thread_meta.version: 2` 只标识 metadata/journal record schema，继续由严格 shape validation 负责；
`thread_meta.protocolVersion` 才负责 Runtime 协议与恢复兼容性，二者不能互相替代。headless hello 已在第一帧
公告同一个 `PROTOCOL_VERSION`，当前协议不增加协商状态机或第二套版本字段。
