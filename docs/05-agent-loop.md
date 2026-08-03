# Agent Loop

Agent 是单 thread 的 run/turn 执行引擎。它接收由 ThreadRuntime 注入的不可变 model、provider、catalog、
policy 与 transcript snapshot，不认识 workspace lifecycle、durable storage 或 UI。

## Run 与 turn

- prompt/continue/retry 创建新 run；retry 通过 predecessor relation 连接，绝不复活旧 run。
- run 依序处理 turn。每个 turn 先捕获 catalog/provider/policy snapshot，再渲染请求并消费 provider stream。
- steering 与 follow-up 进入 thread-local queue，并在规定 turn 边界注入；不能绕过 active-run gate。
- 完成、错误和取消都必须关闭已开始的消息/turn/run，并写回可重放 transcript。

## 工具

provider tool call 经参数修补、schema 验证与 capability prepare 形成 `PreparedInvocation`。同一 turn 内
不得重新查询 live registry 或替换 executor。可恢复失败写成 `ToolResultMessage(isError:true)` 并反馈模型；
不可恢复错误以合法终态结束 run。

## 取消与背压

Agent 在关键 `await` 后检查 `AbortSignal`。取消后停止创建新副作用；已经提交的事实由 ThreadRuntime
按确定顺序结案。只有 transcript、control 和 event commit 可以背压 Agent；UI observer、日志和 headless
订阅者不能阻塞它。
