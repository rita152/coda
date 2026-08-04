# 内部协议

本协议的 TypeScript 事实源是 `src/protocol/`。wire 和 durable 边界均只接受严格 JSON：有限数字、无
cycle/BigInt/function/symbol，且可选字段缺失时直接省略。

## 1. Identity

`WorkspaceId`、`ThreadId`、`RunId`、`TurnId` 与 `OpId` 均为 opaque string。外部 client 只能提交
`ExternalOpId`（`op_e_` 加 32 个小写十六进制字符）；Runtime 派生的 id 使用独立 domain。不得由
数组下标、时间顺序或可变标题推断 identity。

## 2. RuntimeOp

每一条输入都必须是完整对象，至少携带 `type`、`opId` 与 `workspaceId`。thread 定向操作还必须带
`threadId`；create/resume 还带 model；abort 可带 `expectedRunId`；control response 必须带
`requestId` 与 decision。

```ts
type RuntimeOp =
  | ThreadCreate | ThreadResume | Prompt | Continue | Steer | FollowUp
  | SetModel | Abort | ControlResponse | ThreadRename | ThreadArchive
  | Compact | ConversationFork | ConversationRetry | ThreadClose | CancelScope;
```

Runtime 在 admission 时校验 discriminator、必填字段、identity 与严格 JSON。相同 external `OpId` 的
相同 payload 返回原 receipt；不同 payload 使用同 id 被拒绝，绝不重复执行副作用。

## 3. EventEnvelope

```ts
interface EventEnvelope<TEvent = RuntimeEvent> {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  runId?: RunId;
  turnId?: TurnId;
  opId?: OpId;
  seq: number;          // 每个 thread 正整数、严格递增
  timestamp: number;
  event: TEvent;
}
```

`seq` 只在权威提交点分配。`turnId` 必须伴随 `runId`；event identity 描述的是事件所属实体，不是 client
猜测出来的关联。

`validateEventEnvelope` 是 canonical writer、journal recovery 与 durable storage 的权威边界：它先取得
strict JSON 深冻结快照，再要求 envelope/event 只含当前 schema 字段、event type 已知、所有已知 payload
与 identity correlation 有效。未知 event type、未知字段或未知 durable state 一律失败，不得把 consumer
兼容策略用于恢复，也不得静默跳过。

`coda/runtime` 另行导出 `readEventEnvelope`，供 external/headless consumer 对 `JSON.parse` 后的 envelope
执行 tolerant read。它仍要求完整 strict JSON、合法 envelope identity、正整数 `seq`、有限
`timestamp`，并保持 `turnId` 必须伴随 `runId`：

- 已知 event type 返回 `kind: 'known'`，递归校验所有已知必填/可选字段及 event identity correlation；
  additive envelope/event/payload 字段被保留但不参与收窄。
- 未知 event type 返回 `kind: 'unknown'`，保留完整、深冻结的 strict JSON envelope；reader 只校验通用
  envelope identity，不臆造未知 event 的 identity presence/correlation 规则。

因此 preservation 与 ignore 分属两层：protocol reader 从不丢弃未知事件；presentation consumer 可以显式
忽略 `kind: 'unknown'`，也可以记录或转发原 envelope。不得把 `readEventEnvelope` 结果当作 canonical
writer/recovery validation 的替代品。

## 4. 事件与生命周期

Agent 事件满足：

```text
run  := agent_start turn* agent_end
turn := turn_start injected-user-message* assistant-message tool-phase? turn_end
```

消息与工具事件成对闭合；fatal error、abort 和工具失败也必须留下可重放的终态 transcript。除此之外，
Runtime 发出 `op_*` lifecycle、`thread_*` lifecycle、`usage_update`、`runtime_diagnostic`、
`thread_result` 与 control event。

`control_request` 携带 `requestId`、owning run/turn、policy revision 和 JSON-safe payload。
`control_response` 只以同一 requestId 在所属 thread mailbox 中结案，随后发出 `control_resolved`。

## 5. Canonical headless NDJSON

协议版本为 `2.0.0`。stdout 的首帧为：

```json
{"type":"protocol","protocolVersion":"2.0.0","workspaceId":"…"}
```

之后 stdout 只允许完整 `EventEnvelope`、`{"type":"op_receipt","receipt":…}` 和
`{"type":"transport_error",…}`。stdin 每个非空行是一个完整 `RuntimeOp`；无效 JSON 或无效 op 产生
non-fatal `transport_error`，后续行仍可处理。EOF 是有序关闭：已读完整行先完成 dispatch，随后 Runtime
关闭并 drain 输出。读取 stdout 的 public wire consumer 在识别 envelope frame 后使用
`readEventEnvelope`，并根据其 `kind` 执行已知事件投影或未知事件的显式保留/忽略策略。

## 6. One-shot stream-json records

`--output=stream-json` 是带终态摘要的 one-shot record 语法，不新增 core RuntimeOp、control 或事件协议。
首条 `stream_start` 的 record schema `version` 为 `2`，并单独公告当前 core `PROTOCOL_VERSION`；
两者不可混用。中间记录固定为
`{"type":"event","envelope":EventEnvelope}`；最后恰好一条 `result`。`EventEnvelope` 必须是 RuntimePort
实际交付的完整值，保留 workspace/thread/run/turn/op identity、per-thread `seq`、`timestamp` 与 event payload
及其顺序。前端只能另行投影 `envelope.event` 以计算进度或终态，不得把投影、合成 fallback 或重建 identity
写入 event record。`--final-only` 省略 `stream_start` 和所有 event record，只保留 `result`。
