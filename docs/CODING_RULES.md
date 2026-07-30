# coda 编码规则

本规则适用于整个仓库。架构与协议语义以 `docs/`、`src/protocol/` 中的 canonical 类型为准；可执行边界以 `eslint.config.mjs`、`tsconfig.json` 和测试为准。

## 1. 技术基线

- 使用 Bun 1.3.14、`bun.lock`、ESM 和严格 TypeScript；不要引入 CommonJS 写法。项目命令统一经 `bun` / `bun run` 执行。
- Bun API 是默认运行时接口；普通文件内容 I/O、哈希、子进程与流优先使用 `Bun.file` / `Bun.write`、`Bun.CryptoHasher`、`Bun.spawn` 与 Web Streams。Node compatibility 仅限 Bun 暂无等价能力的系统边界：`node:fs` / `node:os` 的目录、元数据、临时目录、符号链接和同步耐久性操作，`node:path`，classic 保底的 readline/raw TTY，以及 `process` 的 cwd、TTY、退出、signal/PGID 控制。eligible 双 TTY（stdin/stdout 均为 TTY 且 `TERM != dumb`）默认由 `@opentui/core` 管理；必须在交互分支动态加载，headless/一次性模式不得初始化 native TUI。初始化失败必须先清理 OpenTUI，再回退到同样支持 `/login`、`/model`、`/logout` 的 classic。交互冷启动允许没有 provider/model，且在恢复了有效的用户显式选择或 `/model` 选定模型前不得创建 `Session`；headless/一次性模式仍必须在创建 `Session` 前取得完整 `ModelConfig`。新增或扩大例外必须同步维护对应设计契约；本项目是 Bun-native，但不宣称零 Node API。
- 相对导入必须写编译后的 `.js` 后缀；纯类型依赖使用 `import type`。
- 遵守 `strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` 等现有检查；优先用 `unknown` 加收窄，禁止无说明的 `any`、双重断言和规则豁免。
- 不手改 `dist/`、`node_modules/`、快照或录制 fixture；快照和 fixture 只能通过对应测试/录制流程更新。依赖变更通过 Bun 同步更新 `bun.lock`，禁止提交密钥与 `.env`。

## 2. 分层与依赖

| 目录 | 职责与边界 |
|---|---|
| `src/protocol/` | canonical 消息、事件、provider 契约与 `EventStream`；运行时代码零 bare import，只能依赖本目录。 |
| `src/shared/` | 与业务层无关的底层工具；不得反向依赖其他 `src` 层。 |
| `src/providers/<provider>/` | wire 协议双向转换；provider 彼此隔离，生产代码中的第三方 SDK 只能留在所属 adapter。 |
| `src/agent/` | Agent 状态、loop、队列、transform 与工具调度；通过 `StreamFn` 和 `ToolDefinition` 注入实现，不认识具体 provider 或工具。 |
| `src/tools/` | 工具契约和内置工具；通过 `ToolContext` 通信，不依赖 agent、provider、session 或 CLI。 |
| `src/session/` | JSONL 持久化、恢复、usage、retry 与 compaction；不做 provider 转换或 UI 渲染。 |
| `src/cli/` | composition root、配置、审批、headless、OpenTUI 与 classic/plain 渲染；只负责组装和输入/事件适配。TUI state 必须是 `SessionEvent` 的可丢弃投影，不得成为第二份会话事实源。 |

- 新代码放到拥有该语义的最低层；不得为复用方便绕过 ESLint zone。
- 新增 provider 时保持独立 adapter，并在 CLI 配置/分发处注册；新增工具时更新 `src/tools/index.ts` 的导出和工具集合。
- 跨目录优先使用各层 `index.ts` 公共出口；只有刻意收窄边界（如 agent → `tools/types.ts`）时才直接导入指定模块，避免无意扩大公共 API。

## 3. TypeScript 与排版

- 沿用现有格式：2 空格缩进、单引号、分号、多行结构尾逗号；不要夹带无关的全文件格式化。
- 文件名使用 kebab-case；类型/类用 PascalCase，函数/变量用 camelCase，模块级限制值和协议常量用 UPPER_SNAKE_CASE。
- 对象契约优先 `interface`，联合与别名使用 `type`；状态机和事件使用带 `type`/`role`/`kind` 标签的 discriminated union。
- 导出的函数、回调和异步边界写清返回类型；异步函数返回 `Promise<T>`，只读视图使用 `readonly`。
- 用类型守卫、`Extract`、`zod.safeParse` 或显式判定收窄外部数据；类型断言只允许出现在已校验、测试构造或 SDK 边界，并让理由可见。
- 文件顶部简述职责与关键契约；JSDoc 说明公开 API、不变量和非显然语义。注释解释“为什么”和边界条件，保持与邻近代码一致的语言。

## 4. 运行时不变量

- `StreamFn` 调用后不得 throw/reject；provider 的失败必须转换为终态 `error` 事件，并以合法 `AssistantMessage` 结束流。
- 转录是权威、可重放的事实存储；错误、中止和工具失败也必须形成完整消息。新增事件时保持 `agent/turn/message/tool` 生命周期成对闭合。
- 工具参数先修补再经 zod 校验；可恢复错误回喂 `ToolResultMessage(isError)`，不要让单个工具失败击穿 agent loop。
- 透传并及时检查 `AbortSignal`，尤其是在流迭代、工具执行和关键 `await` 之后；中止后不得继续产生副作用。
- 并发完成顺序可以变化，但写回转录、持久化和用户可观察的结果顺序必须确定。
- 可选字段在“缺失”和 `undefined` 语义不同的 wire/持久化边界应直接省略；序列化前确保数据为 JSON-safe。

## 5. 测试与交付

- 模块单测与实现共置为 `src/**/*.test.ts`；跨模块 agent/session 测试放 `tests/`；构建产物和进程级验证放 `e2e/`。
- 默认测试必须离线：核心测试使用 faux provider，adapter 使用已录制 JSONL fixture；不得依赖真实 API、密钥或网络。
- 异步时序优先使用 gate、事件等待和注入式 `sleep` / clock，禁止用裸 `setTimeout` 猜时机；只有 e2e 可使用有宽松边界的真实时间。
- 文件工具测试使用独立临时目录并清理；断言事件序列、转录内容和副作用，不读取私有状态猜行为。
- 行为或协议变化必须补回归测试并同步相关 `docs/`；修改架构边界或 ESLint 规则时同步扩展 `tests/boundaries.test.ts`。
- 开发时可先跑定向 `bun test`；交付前必须运行 `bun run check`（lint、typecheck、build、全部测试）。
