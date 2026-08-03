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
猜测出来的关联。reader 对未知 event type/字段保持 tolerant，但 writer 必须发出已验证的 canonical
事件。

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
关闭并 drain 输出。
