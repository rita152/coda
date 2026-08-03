# coda 编码规则

本规则适用于整个仓库。架构与协议语义以 `docs/`、`src/protocol/` 中的 canonical 类型为准；可执行边界以 `eslint.config.mjs`、`tsconfig.json` 和测试为准。

## 1. 技术基线

- 使用 Bun 1.3.14、`bun.lock`、ESM 和严格 TypeScript；不要引入 CommonJS 写法。项目命令统一经 `bun` / `bun run` 执行。
- Bun API 是默认运行时接口；普通文件内容 I/O、哈希、子进程与流优先使用 `Bun.file` / `Bun.write`、`Bun.CryptoHasher`、`Bun.spawn` 与 Web Streams。Node compatibility 仅限 Bun 暂无等价能力的系统边界：`node:fs` / `node:os` 的目录、元数据、临时目录、符号链接和同步耐久性操作，`node:path`，headless NDJSON、CLI 单次问答所需的 readline，以及 `process` 的 cwd、TTY、退出、signal/PGID 控制。长驻交互只由 `@opentui/core` 管理；必须在完整双 TTY（stdin/stdout 均为 TTY 且 `TERM != dumb`）交互分支动态加载，headless/一次性模式不得初始化 native TUI。初始化失败必须先清理 OpenTUI，再明确报错退出，不得切换到另一套交互前端。交互冷启动允许没有 provider/model，且在恢复了有效的用户显式选择或 `/model` 选定模型前不得创建 `Session`；headless/一次性模式仍必须在创建 `Session` 前取得完整 `ModelConfig`。新增或扩大例外必须同步维护对应设计契约；本项目是 Bun-native，但不宣称零 Node API。
- 相对导入必须写编译后的 `.js` 后缀；纯类型依赖使用 `import type`。
- 遵守 `strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` 等现有检查；优先用 `unknown` 加收窄，禁止无说明的 `any`、双重断言和规则豁免。
- 不手改 `dist/`、`node_modules/`、快照或录制 fixture；快照和 fixture 只能通过对应测试/录制流程更新。依赖变更通过 Bun 同步更新 `bun.lock`，禁止提交密钥与 `.env`。

## 2. 分层与依赖

下表同时包含 [11](./11-roadmap.md) 阶段 1–3 将落地的目标目录。阶段 0 必须保持当前生产行为，
因此尚未迁移的 `Session` 直连、裸 `SessionEvent`、`ToolDefinition` 与静态 provider dispatch 可作为
原位兼容路径继续存在，但不得扩大或被新 core 依赖；每个目标目录落地的同一阶段，本规则对应边界
才转为 ESLint 与测试的机械门禁。兼容时限与投影以 [12](./12-supervisor-runtime.md) §11 为准。

| 目录 | 职责与边界 |
|---|---|
| `src/protocol/` | canonical 消息、事件、provider 契约与 `EventStream`；运行时代码零 bare import，只能依赖本目录。 |
| `src/shared/` | 与业务层无关的底层工具；不得反向依赖其他 `src` 层。 |
| `src/providers/<provider>/` | wire 协议双向转换；provider 彼此隔离，生产代码中的第三方 SDK 只能留在所属 adapter。 |
| `src/capabilities/` | JSON-Schema-first 能力注册、不可变 catalog/provider snapshot、prompt 组装与权限策略；不得执行 CLI/UI 逻辑，也不得在 invocation 执行时回查最新 registry。 |
| `src/agent/` | 单 thread 内的 run/turn 执行引擎、队列、transform 与工具调度；通过 snapshot/adapter 注入实现，不认识具体 provider、工具、Supervisor 或 CLI。 |
| `src/tools/` | 工具契约和内置工具；通过 `ToolContext` 通信，不依赖 agent、provider、session 或 CLI。 |
| `src/session/` | 单 thread runtime、transcript repository、retry/compaction coordinator、权威 event commit 与异步 event hub；不保存 workspace 级 thread map，不做 provider 转换或 UI 渲染。 |
| `src/runtime/` | `Supervisor`、workspace/thread 生命周期、op 路由与无副作用 public `RuntimePort`；不采样模型、不执行工具、不渲染。 |
| `src/cli/` | composition root、配置、headless、one-shot human renderer 与 OpenTUI 前端；只负责注册具体 adapter/capability、把输入映射成 op、消费 envelope/兼容投影。业务操作必须经过 `RuntimePort`，UI state 不得成为第二份事实源。 |

- 新代码放到拥有该语义的最低层；不得为复用方便绕过 ESLint zone。
- 新增 provider 时保持独立 adapter，并通过 `ProviderAdapterRegistry` 注册；新增工具时通过 legacy adapter 或原生 capability registration 原子注册 schema、validator 与 executor。
- 认识具体内置工具的 capability binding 只放 `integrations/legacy-coding-tools/`；generic capabilities
  不得 import 具体 tools，tools 不得反向 import capabilities，CLI 不得复制权限/resource switch。
- 跨目录优先使用各层 `index.ts` 公共出口；只有刻意收窄边界（如 agent → `tools/types.ts`）时才直接导入指定模块，避免无意扩大公共 API。
- 分阶段迁移期间允许 `Session`、`ToolDefinition` 与 provider switch 的兼容适配层存在；新 core 不得反向依赖兼容层，新增目录出现的同一阶段必须同步补 ESLint zone 与边界测试。

## 3. TypeScript 与排版

- 沿用现有格式：2 空格缩进、单引号、分号、多行结构尾逗号；不要夹带无关的全文件格式化。
- 文件名使用 kebab-case；类型/类用 PascalCase，函数/变量用 camelCase，模块级限制值和协议常量用 UPPER_SNAKE_CASE。
- 对象契约优先 `interface`，联合与别名使用 `type`；状态机和事件使用带 `type`/`role`/`kind` 标签的 discriminated union。
- 导出的函数、回调和异步边界写清返回类型；异步函数返回 `Promise<T>`，只读视图使用 `readonly`。
- 用类型守卫、`Extract`、`zod.safeParse` 或显式判定收窄外部数据；类型断言只允许出现在已校验、测试构造或 SDK 边界，并让理由可见。
- 文件顶部简述职责与关键契约；JSDoc 说明公开 API、不变量和非显然语义。注释解释“为什么”和边界条件，保持与邻近代码一致的语言。

## 4. 运行时不变量

下列 identity/envelope/Supervisor/snapshot 条款是阶段 1–3 的目标不变量；阶段 0 的
characterization tests 刻意记录迁移前形态，不视为违规。某条款对应阶段一旦提交，后续代码必须
持续遵守，不能退回兼容实现作为新的事实源。

- `StreamFn` 调用后不得 throw/reject；provider 的失败必须转换为终态 `error` 事件，并以合法 `AssistantMessage` 结束流。
- 转录是权威、可重放的事实存储；错误、中止和工具失败也必须形成完整消息。新增事件时保持 `agent/turn/message/tool` 生命周期成对闭合。
- `WorkspaceId`、`ThreadId`、`RunId`、`TurnId`、`OpId` 是不可互换的 opaque identity；不得用数组下标、时间顺序或可变名称代替。每次 prompt/continue/retry 创建新 `RunId`，续跑用 predecessor 关系连接，禁止复活旧 run。
- 并发门禁是“每个 thread 至多一个 active run”，不是进程级单 Agent；不同 thread 必须能并发运行，mailbox、取消、转录、usage、control 与权限状态均不得串线。子 Agent 必须由 Supervisor 建为独立 thread，不得伪装成工具调用或共享父 Agent 可变状态。
- 外部操作经目标 thread 的 FIFO mailbox 路由；`OpId` 重投必须幂等。abort 默认只作用于目标 `(threadId, runId)`，跨 thread 或迟到的 `expectedRunId` 不得误杀 successor run。
- canonical runtime 事件必须使用 `EventEnvelope`。`seq` 只由目标 thread 的唯一 `EventCommitter` 在权威提交点分配，严格递增并在恢复后续接 high-water mark；不得制造跨 thread 的全局顺序。
- 只有 transcript/seq/control 的权威提交可以背压 Agent；普通 observer 必须通过 `EventHub` 异步消费，慢、失败或退订不得阻塞 run 或其他 thread。legacy `SessionEvent`/headless 是显式兼容投影，不是第二条事实链。
- 工具参数先修补再经 zod 校验；可恢复错误回喂 `ToolResultMessage(isError)`，不要让单个工具失败击穿 agent loop。
- 每个 turn 只捕获一次不可变 `ToolCatalogSnapshot` 与 provider adapter snapshot；prompt schema、参数校验、policy 输入和 executor 必须来自同一 revision。`PreparedInvocation` 创建后禁止按名称回查最新 registry 或替换 executor。
- 权限决策必须携带 workspace/thread/run/turn/capability/catalog revision 与冻结的 effective policy revision，workspace policy 给上限、thread/run 只能收窄；approval/control response 只在所属 thread 有效。
- 透传并及时检查 `AbortSignal`，尤其是在流迭代、工具执行和关键 `await` 之后；中止后不得继续产生副作用。
- 并发完成顺序可以变化，但写回转录、持久化和用户可观察的结果顺序必须确定。
- 可选字段在“缺失”和 `undefined` 语义不同的 wire/持久化边界应直接省略；canonical commit 在分配
  seq 前必须把 event/mutation 校验并深拷贝为严格 JSON value（finite number、无 cycle/BigInt/function/
  symbol/non-plain instance），durable 后只发布深冻结或逐观察者隔离的 envelope，不能暴露 producer/
  observer 可变引用。
- public runtime entry 的 import 必须无副作用：不得读取环境/配置、创建文件、初始化 TTY/provider、注册 signal handler 或发起网络请求；所有副作用从显式工厂/提交 op 开始。

## 5. 测试与交付

- 模块单测与实现共置为 `src/**/*.test.ts`；跨模块 agent/session 测试放 `tests/`；构建产物和进程级验证放 `e2e/`。
- 默认测试必须离线：核心测试使用 faux provider，adapter 使用已录制 JSONL fixture；不得依赖真实 API、密钥或网络。
- 异步时序优先使用 gate、事件等待和注入式 `sleep` / clock，禁止用裸 `setTimeout` 猜时机；只有 e2e 可使用有宽松边界的真实时间。
- 文件工具测试使用独立临时目录并清理；断言事件序列、转录内容和副作用，不读取私有状态猜行为。
- 并发/runtime 测试必须至少覆盖同 thread active-run 拒绝、跨 thread gate 并行与 abort 隔离、per-thread seq 恢复续接、重复 OpId，以及慢 observer 不背压；id、clock、lease 与持久化 gate 应可注入。
- registry/policy 改动必须有热更新对抗测试：turn 中更新同名 capability 后，当前 turn 仍使用旧 schema/validator/executor，下一 turn 才使用新 revision；权限断言必须基于 `PreparedInvocation` 的归一化参数。
- 行为或协议变化必须补回归测试并同步相关 `docs/`；修改架构边界或 ESLint 规则时同步扩展 `tests/boundaries.test.ts`。
- 开发时可先跑定向 `bun test`；交付前必须运行 `bun run check`（lint、typecheck、build、全部测试）。
