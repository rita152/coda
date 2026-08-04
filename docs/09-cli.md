# CLI 与 Headless

CLI 只承担参数解析、可信 composition、RuntimePort 调用和 presentation。它不实现 run、权限、重试、
compaction、transcript 或 event sequencing。

## 1. 路由

- 完整双 TTY 且未选择 one-shot/headless 时启动 TUI。
- `-p` 或 `exec` 使用 human one-shot 输出，除非同时给出 `--json`。
- `--json` 始终选择 canonical NDJSON transport。
- 非 TTY、无 prompt 且 stdin EOF 的人类模式输出用法提示并以退出码 2 结束。

CLI 在创建 Runtime 后只通过 `RuntimePort` 进行 create/resume、prompt、steer、abort、control response
和 close。任何 convenience flag 都先转换为完整 identity-bearing RuntimeOp。

## 2. Canonical `--json`

协议版本固定为 `2.0.0`。stdout 第一行：

```json
{"type":"protocol","protocolVersion":"2.0.0","workspaceId":"…"}
```

stdin 为每行一个完整 `RuntimeOp`。例如：

```json
{"type":"thread_create","opId":"op_e_…","workspaceId":"…","threadId":"…","model":{"provider":"faux","api":"faux","model":"faux"}}
{"type":"prompt","opId":"op_e_…","workspaceId":"…","threadId":"…","text":"review this"}
```

stdout 后续只允许完整 `EventEnvelope`、`op_receipt` 与 `transport_error`。没有 identity-free prompt、
steer、approval、abort 或 shutdown command；没有可切换的协议选择器；不输出裸 event。

invalid JSON、非对象或 Runtime validation failure 产生 `transport_error{fatal:false,code:'invalid_input'}`，
transport 继续读取。scope dispatch partial failure 使用其专用 error frame。EOF 是关闭请求，不是输入帧；
headless 在关闭前完成已读完整行、关闭 Runtime 并 drain stdout。

## 3. `--json -p`

`-p` 不改变协议。composition root 生成一个完整 `thread_create` 或 `thread_resume` op，再生成完整 prompt
op，并将它们作为 initial operation sequence 提交。headless 订阅先于 initial op 安装；initial prompt 的
最终（非 retry）`agent_end` 后自然关闭。错误终态退出码为 1，完成/abort 为 0。

## 4. TUI 与 one-shot

TUI 和 one-shot 订阅 EventEnvelope 并建立可丢弃 view state；渲染器消费的是 envelope 的 `event` payload。
approval UI 等待 `control_request`，向
Runtime 提交 `control_response`；它不持有 resolver 或 policy state。stdout 是机器输出时诊断和 warning
只写 stderr，避免污染 NDJSON。

`--output=stream-json` 是 one-shot record 流，不是第二套 core input/control 协议。首条记录为
`{type:"stream_start",version:2,protocolVersion:PROTOCOL_VERSION}`；`version` 标识 one-shot record schema，
`protocolVersion` 标识 core Runtime 协议。其后每条 Runtime 事件记录必须是
`{"type":"event","envelope":EventEnvelope}`，完整保留 RuntimePort 交付的 identity、`seq`、`timestamp` 和
event payload，最后恰好一条 `result`。人类 view 可用 canonical `op_completed` 合成终止投影，但该投影不得
进入机器事件记录；机器输出不得重建、补造或剥离 envelope identity。`--final-only` 只写 terminal result。

## 5. 退出与信号

SIGINT/SIGTERM 关闭 Runtime；in-flight run 由 Runtime abort/close 结案。stdout 写入失败是 transport
fatal：停止接收后续输入、关闭 Runtime 并以退出码 1 返回。所有路径都应在退出前 drain 已提交输出。
