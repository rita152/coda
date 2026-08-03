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
