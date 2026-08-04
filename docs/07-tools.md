# Capabilities、工具与权限

工具执行建立在 capability registry 之上。Capability 是 schema、validator、executor、resource resolver 和
metadata 的原子注册项；注册后的可观察身份由 capability id、version、registration digest 与 catalog
revision 共同确定。

## 1. Catalog snapshot 与 PreparedInvocation

一个 turn 在开始时捕获 `ToolCatalogSnapshot`。provider 可见的 tool schema、参数验证、policy 输入和
executor 必须来自同一 snapshot。运行期间的 registry 更新只影响下一 turn。

```text
provider tool call
  → argument repair
  → JSON Schema validation
  → resource normalization
  → policy preflight
  → PreparedInvocation
  → executor / ToolResultMessage
```

`PreparedInvocation` 创建后不可按名称回查 registry，也不能替换 executor。资源 resolver 输出 canonical
resource facts；policy 不猜工具名称、参数位置或 shell 文本。

## 2. Executor

executor 通过 `ToolContext` 获得所属 invocation 的 identity、abort signal、受限服务和进度回调。它不得
写 RuntimeEvent、transcript 或 UI；可恢复错误必须返回 error tool result。任何工具参数先修补再校验，
不得让未验证 provider JSON 直接进入副作用边界。

内置 read、ls、glob、grep、bash、edit、write 和 plan 都作为 capability 注册。具体工具 binding 与
resource analyzer 位于 `integrations/coding-capabilities/`；generic registry 不 import 具体工具。

## 3. Policy

workspace policy 给出不可突破的上限，thread/run narrowing 只能进一步收紧。一个 invocation 的有效决策
至少绑定：workspace、thread、run、turn、capability id/version/digest、catalog revision、冻结 policy
revision 与 canonical normalized resources。

`allow_always` 产生 workspace-scoped `PolicyGrant`，其 scope 使用
`canonical_resources_v1`，并包含 resource patterns 与 attributes。grant 只命中完全相同的 capability
identity 与 policy basis；更新 schema/executor/digest 后不得继承旧授权。grant repository 以
`workspaceId` 和 Supervisor fence 确认归属，公共契约不再携带只有 `workspace` 一个取值的 mode 字段。

## 4. Approval 与 control

需要人工决策时，ThreadRuntime 在权威 event 链提交：

```text
EventEnvelope(control_request)
  { requestId, owningRunId, owningTurnId, policyRevision, payload }
          ↓
RuntimeOp(control_response)
  { workspaceId, threadId, opId, requestId, decision }
          ↓
EventEnvelope(control_resolved)
```

request payload 是 Runtime 编写的 JSON-safe presentation：目标 identity、capability identity、归一化资源、
risk、revisions 和允许的决策。前端可以格式化它，但不得从原始 args 重建授权信息。

response 只对同 thread、未结案 request 有效；重复 response 由 external OpId 幂等处理。abort/thread close
会把 pending control 以 `aborted` 结案，不得伪装成 deny。审批、资源确认、重试和工具执行均使用同一
mailbox 与 EventCommitter，不存在独立 approval event 或 promise 通道。

## 5. 安全不变量

- capability 注册、schema、validator、executor 和 resolver 原子冻结。
- tool call id 仅作 provider 关联；Runtime 另行生成 invocation/run/turn identity。
- executor 的 side effect 必须响应 `AbortSignal`；停止后不得继续写文件、进程或网络。
- policy 与 grant durable 写入使用 workspace fencing；unknown commit outcome 不得再次授权。
- renderer/headless 不执行 policy 判断，只消费 canonical control/event。
