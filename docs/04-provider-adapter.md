# Provider Adapter

Provider adapter 位于 `src/providers/<provider>/`，只负责 provider wire 与 `src/protocol/` 之间的双向
转换。adapter 彼此隔离，不共享 provider 私有类型，不访问 session、runtime、queue、TTY 或具体工具。

## 请求

每个 turn 使用开始时冻结的 provider adapter snapshot、model 与 rendered tool schema。adapter 将完整的
本地 transcript、system instructions、模型参数和 schema 转成 provider 请求；不得依赖远端 response id
作为本地正确性的来源。

## 流

`StreamFn` 调用后不得 throw 或 reject。请求、解析、网络和 provider 错误必须转换为合法终态事件，令
Agent 能关闭消息和 run 生命周期。流式 delta 只转换为 `ProviderEvent`；Agent/ThreadRuntime 决定消息、
工具和 transcript 的权威提交。

adapter 必须及时检查 `AbortSignal`，停止后不再产生副作用或继续消费输出。未知 provider 字段可忽略，
但已识别字段必须做 JSON/类型收窄，不能用未校验断言穿透到 core。

OpenAI Chat adapter 的 `compat.supportsReasoning` 控制对已知 reasoning delta 扩展字段的读取。旧配置的
`reasoningFormat` 会在启动时告警并迁移：`none` 映射为 `supportsReasoning: false`，`openai` 与
`reasoning_content` 映射为 `true`。两者同时存在时，当前 `supportsReasoning` 显式值优先；其他未知或非法
compat 值仍被告警后忽略。

## 注册

宿主通过 `ProviderAdapterRegistry` 显式注册 adapter。每 turn 捕获不可变 adapter snapshot；运行中增删
provider 只影响下一 turn。provider 配置、API key 与 base URL 属于可信 composition 边界，绝不进入
RuntimeOp、EventEnvelope、transcript 或 renderer。

CLI 未显式选择 provider 时，未设置 base URL 或 HTTPS `api.openai.com` 使用 OpenAI Responses adapter；
其他 base URL 默认使用 OpenAI Chat adapter，以保留 OpenAI-compatible endpoint 的保守兼容路径。显式
`openai-chat`、`openai-responses` 和第三方 provider 的模型协议映射优先于该默认规则。
