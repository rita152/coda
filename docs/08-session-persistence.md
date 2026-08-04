# Thread 持久化与恢复

持久化事实按 workspace 和 thread 组织。Runtime storage 保存 thread metadata、transcript、event journal、
control 状态、policy grants、catalog/policy revision 所需快照和每个 thread 的 event high-water mark。

## 1. 写入顺序

`EventCommitter` 在发布前完成以下顺序：

1. 校验 event 与关联 mutation 为严格 JSON；
2. 深拷贝、冻结提交值，并从已提交 high-water 计算该 thread 的下一个 `seq`；
3. 在 durable store 追加与该 canonical envelope 等价的 v3 physical record 与
   transcript/control/thread mutation；高频 `message_update` 使用下述紧凑 codec；
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

runtime-v2 workspace 中的新 thread journal 第零条记录必须是 `thread_meta`。file storage 先只读取并解析该完整首行，判定
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

`thread_meta.version: 3` 标识本文唯一支持的 durable journal grammar；`thread_meta.protocolVersion` 才负责
Runtime 协议与 event 恢复兼容性，二者不能互相替代。这里是经用户接受的 clean break：version 2 journal
不迁移、不双读、不双写，reader 在 protocol gate 后以 `unsupported_journal_version` 明确失败并提示清理对应
workspace journal。不得静默删除、把 v2 当 v3 解析，或为旧 durable 数据重新增加兼容分支。workspace 目录和
catalog 的 `runtime-v2` 名称是产品 workspace 世代标签，不是 thread journal grammar version。

headless hello 已在第一帧公告同一个 `PROTOCOL_VERSION`，当前协议不增加协商状态机或第二套协商状态。

## 8. Journal v3 compact grammar

除 commit 中的 `message_update` 外，physical record 保持 canonical record 的严格 JSON shape。对 assistant
message lifecycle，codec 维护一个当前 message 和按 `contentIndex` 标识的 open block 集合：

- `message_start` 建立 assistant message 状态；block start 保存 message shell 与初始完整 part；
- text/reasoning/tool-call delta 只保存实际 `delta` 和不能从前态推导的固定 metadata，不保存累计
  `partial`；
- block end 保存该 block 的终态，`message_end` 保存 canonical 终态消息；interruption mutation 清空未闭合
  lifecycle；
- writer 每次编码都把 delta 应用于前态，并逐字段比较重建值与 public `partial`；不一致的输入不能落盘；
- reader 使用同一状态机重建完整 public envelope，随后执行 strict envelope、commit correspondence、连续
  `seq`、mailbox/run/turn/OpId grammar 校验。

因此 journal 空间为 `O(delta 总字节 + 终态消息 + 每事件固定 metadata)`；累计 partial 的长度不再乘以
delta 数量。终态 message/transcript 仍完整保存，公开 RuntimeEvent/EventEnvelope 行为没有变化。

## 9. Materialized recovery snapshot

每个 thread 可有一个原子 `.recovery.json` materialization。它包含对应 journal 的
`dev/ino/size/mtime/ctime` boundary、event high-water、有限 replay tail、checkpoint、summary、mailbox、
run/turn、control claim、cancel/input ownership、result outbox、identity set，以及继续验证 tail 所需的
sequence/codec state。payload 带 canonical digest；metadata 必须与 journal header 完全相同。
OpId terminal、mailbox accepted seq/queue-effect witness、thread-result 及 control request/resolution 另有明确
恢复索引；幂等、FIFO、control/outbox 恢复不得扫描或依赖可能被裁剪的 replay envelope。

恢复按以下顺序选择，且 journal 正文最多解析一次：

1. 先执行已缓存或新读取的 header protocol/schema/ownership gate；
2. snapshot boundary 与当前 journal 完全一致时直接使用 snapshot，不读正文；
3. inode 相同且 journal 只在 snapshot boundary 后增长时，仅解析、验证并 fold tail；
4. snapshot 缺失、损坏、truncate、replace 或 boundary 不可信时，单次流式解析全 journal，边验证边 fold，
   不保留所有重建 envelope，然后重建 snapshot；
5. 只有持有 workspace fence 和 thread write lease 的 reader 可以截断 torn final record 或补 final newline。

snapshot 用同目录临时文件写入并 fsync，随后 rename 与目录 fsync。append 先 fsync journal，再把 catalog
boundary 标成 `recoveryRequired`；snapshot rename 成功后才把 catalog 更新到 exact boundary/hint。因此
“append 已 durable、snapshot/catalog 未更新”“snapshot temp 未 rename”“snapshot 已 rename、catalog 未更新”
都会在下次启动落入 tail/full recovery，而不会把未完成义务误判为 clean。catalog summary/preview 是 UI
投影；恢复判断使用独立的 journal boundary 与 recovery hint，不从可变标题或展示状态推断。

## 10. Catalog listing、lazy recovery 与 replay

`listStoredThreads()` 只读取 workspace binding 和 strict catalog；它不枚举或读取任意 workspace 的 journal
正文。catalog 缺失或损坏时可从 journal header 重建一个全部标记 `recoveryRequired` 的保守投影；
这仍不读正文，而旧 v2 header/catalog 仍必须按 clean-break 门禁失败。取得 workspace lease 后，
catalog reconciliation 对本 workspace 每个 thread 只读取 header 和 stat，
并把这次验证得到的 locator 贯穿 `openThreadJournal()` 与 `loadState()`，避免 reconcile/open/load 的重复全文
读取。崩溃后重入 create/fork 时只比较不可变 header/必要 seed 前缀，正文仍只由随后的一次
snapshot/tail/full recovery 解析。

Supervisor 初始化只建立 metadata、high-water 和 storage locator。clean、未附加 thread 不 fold journal、
不把 transcript 或完整 event history 放入常驻 map。只有以下恢复义务会 eager load：prepared/accepted/started
mailbox op，active/closing activity，pending control/cancel/input，未确认 result outbox，以及未完成的
Supervisor ledger/attachment lifecycle。显式 resume/query/fork/retry/cancel-scope 再按目标加载所需 thread；
无关 workspace/thread 正文不参与。

每个 folded state 与 snapshot 最多保留 4096 条、且按完整 public envelope 计算的 canonical serialized 总量
不超过 4 MiB 的连续 replay window，同时保留真实 high-water。snapshot 对 window 中完整 assistant lifecycle
直接使用 v3 增量 codec；若 window 从 lifecycle 中段开始，只保存第一个累计 partial 作为 replay base，后续
update 仍保存实际 delta。因此 window、cursor/gap 语义不缩短，也不会把二次方写放大转移到 materialization。
EventHub 注册
storage high-water/replay-start，而不是 seed 全部历史；有 cursor 的 subscriber 才按需读取对应 range，并在
捕获的 high-water 后无重复、无丢失地切到 live。cursor 早于保留窗口仍按既有 structured gap contract 失败。
每次 live commit durable publish 后，writer 同步推进 EventHub 中的 storage high-water 和精确 replay-start；
因此同一进程内新增的事件即使已移出内存 live tail，后续 cursor 仍可从 storage 按需恢复。
无 cursor 的 TUI workspace stream 从注册 high-water 后接收 live event；只 hydrate 当前选择的 thread，不为
建立 cursor 预取所有 thread snapshot。
