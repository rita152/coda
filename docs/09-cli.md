[← 返回地图](./README.md)

# 09 CLI / REPL:交互模式、流式渲染、键位与 headless JSON 模式

CLI 是整个系统里**最薄**的一层:它只做两件事——把用户输入翻译成对 `Agent` 的方法调用(`prompt` / `steer` / `followUp` / `abort`),把 `AgentEvent` 流翻译成终端上的像素。所有智能都在 agent 核心;CLI 不持有任何会话状态副本,不理解 provider,不解析工具参数。这一「哑终端」定位是 opencode V1→V2 最重要的教训:V1 把状态揉进 UI 后无法演化,V2 被迫重写为 client/server;我们从第一天起就把 CLI 当成内部协议的一个普通消费者来写,headless JSON 模式(见第 6 节)就是这条纪律的机械验证——**交互 REPL 能做的每一件事,都必须能用一行 JSON 命令表达**。

## 1. v1 形态:Node readline + ANSI 自绘

### 1.1 决策:不引 TUI 框架

v1 不使用 Ink/React、blessed、SolidJS-terminal 等任何 TUI 框架,用 Node 内置 `readline`(raw keypress 事件)加手写 ANSI 控制序列。理由:

1. **项目的验证目标在 agent 核心,不在 UI。** 本项目的三条核心需求(协议隔离、双队列、工具集)全部位于 CLI 之下;UI 每多一层抽象,调试流式渲染问题时就多一层不可控的重绘时机。pi-mono 的 TUI 同样是自研组件而非通用框架,其经验是:coding agent 的渲染模式非常固定(追加式转录 + 底部少量动态区),用不到通用 TUI 框架的布局/组件树能力。
2. **React 式重绘模型与流式输出天然冲突。** Ink 按帧 diff 重绘整屏,`text_delta` 每秒可达上百次,要么节流(引入延迟感)要么闪烁;而 append-only 的 `process.stdout.write(delta)` 是零成本的。gemini-cli(Ink)在长输出场景的性能问题是公开的反面案例。
3. **依赖重量与启动时间。** v1 的 CLI 依赖清单目标为零(readline、tty、process 全部是 Node 内置);这对一个要求 Node ≥ 20、ESM、tsup 单文件产物的 CLI 意义直接。

### 1.2 升级路径

不引框架不等于放弃升级。两条已铺好的路:

- **渲染器接口隔离**:所有 ANSI 细节收敛在 `Renderer` 接口(第 4 节)之后,`cli/` 内没有第二处直接写 stdout。将来若换 Ink 或自研组件系统,只替换 `Renderer` 实现,键位层与命令层不动。
- **headless 模式即 server 雏形**:更彻底的升级是把富 TUI 做成 headless 模式的独立客户端(TUI 进程 spawn `coda --json`,走 NDJSON 管道),这正是 codex `submit(Op)` / `next_event()` 与 opencode V2 client/server 的架构。届时 v1 的 readline REPL 保留为轻量默认前端。

### 1.3 渲染模型:append-only 转录区 + 底部动态区

不进入 alternate screen buffer(保留终端 scrollback,可复制、可 `| tee`),屏幕分两个逻辑区:

- **转录区**:只追加、永不回改。assistant 文本、工具结果摘要、注入的 steering 消息按发生顺序写入。
- **底部动态区**(最多 3–4 行):当前活动(spinner + 工具进度 tail)、队列徽标、输入行。每次更新用 `\x1b[<n>F\x1b[J`(光标上移 n 行 + 清屏到底)整体重绘。

关键纪律:**stdout 只有 Renderer 一个写入者**。流式 delta 到来时,先清底部动态区 → 追加 delta 到转录区 → 重绘动态区。这是 readline 与流式输出共存的唯一稳妥办法(风险详见 [11-roadmap](./11-roadmap.md) 风险清单)。非 TTY(`!process.stdout.isTTY`)或 `NO_COLOR`/`--no-color` 时降级为纯追加、无 ANSI 的 plain 模式。

## 2. 启动流程与会话选择

```
coda                    # 新会话
coda -p "..."           # 一次性:发送 prompt,跑完打印结果退出(脚本友好,复用 headless 内核)
coda --continue         # 恢复最近一个会话
coda --resume [id]      # 无 id 时列出 ~/.coda/sessions/ 供选择(编号 + 首条 prompt 摘要 + 时间)
coda --json             # headless JSON 模式(第 6 节)
```

启动组装顺序(伪码):

```ts
const config      = resolveConfig(flags, env, readConfigFile());   // 第 7 节
const model       = toModelConfig(config);                         // ModelRef + baseURL/apiKey/compat
const agentConfig = { streamFn: openaiChatStream, model, tools: builtinTools, systemPrompt };
const session     = resuming
  ? await Session.resume(sessionId, { agentConfig })   // 加载 JSONL,内部组装 Agent 并注入 initialMessages
  : await Session.create({ agentConfig });             // 见 08 文档第 2 节
const renderer = createRenderer(process.stdout, { color, width });
session.subscribe(e => renderer.render(e));            // SessionEvent = AgentEvent 透传 + retry/compaction 等叠加事件
if (resuming) renderer.replayTranscript(session.messages);   // 重放 session 恢复出的转录
startRepl(session, renderer);   // 或 startHeadless(session)
```

Agent 由 Session 内部组装并持有(见 [08-session-persistence](./08-session-persistence.md) 第 1–2 节),CLI 订阅的是 Session 而非 Agent——这样 `retry_scheduled` / `compaction_start` 等 SessionEvent 才能透传到 UI。注意 `subscribe` 的监听器是 await 串行的(pi 的取舍:换取 `waitForIdle()` 后落盘确定的语义),落盘由 session 内部的监听完成、在透传渲染之前,且两者都必须快——渲染器内部不做任何 IO 等待。

## 3. 键位表

| 状态 | 键 | 行为 |
|---|---|---|
| 空闲 | `Enter` | 发送输入(`agent.prompt(text)`) |
| 空闲 | `Ctrl+C` | 输入非空:清空输入行;输入为空:提示「再按一次退出」,1.5s 内再按退出 |
| 空闲 | `Ctrl+D` | 输入为空时退出 |
| 空闲 | `↑` / `↓` | 输入历史(仅本会话) |
| 流式中 | `Enter` | 当前输入入 **steering** 队列(`agent.steer(text)`) |
| 流式中 | `Alt+Enter` | 当前输入入 **follow-up** 队列(`agent.followUp(text)`) |
| 流式中 | `Esc` | `agent.abort()`(硬中断) |
| 任意 | `Esc Esc`(500ms 内)或 `Ctrl+C Ctrl+C` | 退出(流式中先 abort,`waitForIdle` 落盘后退出) |

### 3.1 为什么与 pi 完全一致

这套键位照搬 pi 的 TUI,不是偷懒而是语义正确:

- **流式期间打字的默认去向应当是风险最低的动作。** 用户在模型工作时输入,绝大多数意图是「补充/纠偏」,而 steering 恰好是不打断执行中工具、在 turn 边界温和注入的语义(见 [06-steering-following](./06-steering-following.md))——把它放在无修饰的 `Enter` 上,让最自然的动作对应最安全的语义。
- **升级动作配升级键。** follow-up(等整个任务结束)是更「延后」的意图,配组合键 `Alt+Enter`;abort 是破坏性动作,配独立键 `Esc`,与输入内容无关(Esc 不消费输入框文本)。
- **`prompt()` 运行中 throw 在 UI 层被键位表吸收**:CLI 永远不会在 running 状态调 `prompt`,用户无需理解这个约束,键位已经替他选好了。

### 3.2 Esc 与 Alt+Enter 的终端现实

- `Esc` 是所有 ANSI 转义序列的前缀。用 readline `keypress` 事件 + `escapeCodeTimeout`(设 50ms)消歧:超时内无后续字节才认定为裸 Esc。方向键等序列不会被误判为 abort。
- `Alt+Enter` 在多数终端编码为 `ESC CR`,但 macOS Terminal.app 默认 Option 输入特殊字符、部分终端发 `M-Enter` meta 位。检测 `key.meta && key.name === 'return'` 为主,同时提供**斜杠命令兜底**:流式中输入以 `/f `(或 `/followup `)开头再 Enter,等价于 follow-up。斜杠命令保证任何终端都有全功能路径。
- 其余斜杠命令(空闲时):`/quit`、`/queue`(打印两队列内容)、`/status`(模型、token/成本累计)、`/help`。v1 不做更多。

## 4. 渲染器与 AgentEvent 对应表

`Renderer` 接口:

```ts
// src/cli/renderer.ts
export interface Renderer {
  render(e: AgentEvent): void;
  replayTranscript(messages: AgentMessage[]): void;   // --continue/--resume 启动时
}
```

每种 `AgentEvent`(定义见 [03-internal-protocol](./03-internal-protocol.md))的渲染行为:

| AgentEvent | 渲染行为 |
|---|---|
| `agent_start` | 底部动态区出现 spinner;`reason: 'follow_up'` 时先打印一行 `↪ follow-up` 标记 |
| `agent_end` | 收起 spinner;`reason: 'error'` 打印醒目错误行;打印本次 usage 小结(tokens / cost) |
| `turn_start` | 无可见输出(内部计数) |
| `turn_end` | 转录区补一个空行分隔;刷新队列徽标 |
| `message_start` (user) | `source: 'steering'` 渲染为 `» steering: <text>`(注入回显);`'follow_up'` 同理;`'synthetic'` 用暗色渲染 |
| `message_start` (assistant) | 准备流式区域(记录当前 contentIndex 状态) |
| `message_update` | 解包内层 `ProviderEvent`:`text_delta` 直接 `stdout.write(delta)`;`reasoning_delta` 暗色斜体输出(可 `--no-reasoning` 折叠为一行 `thinking…`);`tool_call_start/delta` 不渲染参数流,只在动态区显示 `preparing <name>…`;`text_end`/`reasoning_end` 补换行 |
| `message_end` (assistant) | `stopReason: 'length'` 追加警示行 `[output truncated by model limit]`;`'aborted'` 追加 `[aborted]` |
| `message_end` (tool_result) | 已由 `tool_execution_end` 渲染,此处无输出(去重) |
| `tool_execution_start` | 转录区一行工具头:`● bash: npm test`(按工具定制单行摘要,见下表);动态区 spinner 挂上该工具 |
| `tool_execution_update` | 动态区显示 `update.output` 的尾部(bash 流式输出;100ms 节流已由工具层保证)。v1 动态区总高 ≤4 行(§1.3),工具输出取**尾部 1 行**并入活动行;尾部多行展示随富 TUI 升级 |
| `tool_execution_end` | 工具头行补状态与摘要:成功 `✓ read src/a.ts (120 lines)` / 失败 `✗ edit: oldText not found`;`details` 中的 diff 以 ±着色渲染(上限 40 行,超出提示行数) |
| `queue_update` | 刷新底部队列徽标:`[steer 1 · follow-up 2]`;两队列皆空时不显示 |
| `plan_update` | 以清单渲染 plan 块:`✔ 已完成` / `▶ in_progress` / `○ pending`。事件语义是整表替换;v1 转录区 append-only(§1.3),每次**追加**完整新表,覆盖式原地重绘随富 TUI 升级 |
| `approval_request` | (M6)动态区变审批提示:`Allow bash: rm -rf dist? [y=once / a=always / n=deny / Esc=abort]`,期间键位表切换为审批模式 |
| `error` | `fatal: false` 打印警告行;`fatal: true` 打印错误并进入退出流程 |

工具头单行摘要规则(`tool_execution_start` 用 `args` 生成,不等结果):

| 工具 | 摘要示例 |
|---|---|
| read | `read src/agent/loop.ts [offset=200]` |
| ls / glob / grep | `grep "StreamFn" src/ (limit 100)` |
| bash | `bash: <command 首行,截 80 列>` |
| edit / write | `edit src/cli/repl.ts (2 edits)` / `write docs/x.md` |
| plan | 不渲染工具头,由 `plan_update` 事件负责(旁路事件,codex `update_plan` 同构) |

## 5. 交互模式一屏示意

```
you: 把 renderer 抽成接口
● read src/cli/repl.ts (312 lines)          ✓
● edit src/cli/repl.ts (1 edit)             ✓
  - function render(e) {            + interface Renderer {
好的,我把渲染逻辑抽成了 Renderer 接口……▌
──────────────────────────────────────────────
⠸ streaming…                 [steer 1 · follow-up 0]
> 顺便把颜色常量也挪过去_
```

分隔线以下是动态区:活动行 + 队列徽标 + 输入行。用户此刻按 `Enter`,输入行文本进 steering 队列,徽标变 `[steer 2]`,转录区不动。

## 6. Headless JSON 模式(`--json`)

### 6.1 定位:内部协议的对外验证面

`coda --json` 把 REPL 换成纯 JSON 管道:stdin 一行一条命令,stdout 一行一条 `AgentEvent`(NDJSON)。这不是附赠功能,而是架构自证:

- **它证明 CLI 没有私藏语义。** 键位表的每个动作(第 3 节)在这里都有同构命令;若某能力只能在交互模式做到,说明该逻辑放错了层。
- **它是 codex 外协议的最小同构。** codex 的边界只有 `submit(Op)` 与 `next_event()`,一切 UI 交互(含审批应答)都是可序列化的 Op;我们的命令流/事件流与之同形,天然可保序、可跨进程。
- **它是未来 server 化 / IDE 集成的基础。** 把 stdin/stdout 换成 WebSocket 或 HTTP+SSE,协议一字不改——opencode V2 的 client/server 重写之所以痛苦,正因为 V1 没有先留下这个面。
- **它是 e2e 测试的执行面。** [10-testing](./10-testing.md) 的 REPL e2e 用 faux provider + `--json` 管道断言事件序列,完全离线、无 PTY 依赖。

### 6.2 命令规格(stdin,一行一条 JSON)

```ts
// src/cli/headless.ts
export type CliCommand =
  | { type: 'prompt';    text: string }   // 空闲时开新任务;运行中返回 error 事件(non-fatal)
  | { type: 'steer';     text: string }   // 入 steering 队列(随时)
  | { type: 'follow_up'; text: string }   // 入 follow-up 队列(随时)
  | { type: 'abort' }                     // agent.abort()
  | { type: 'shutdown' };                 // 见 6.4
```

命名对齐内部协议:`follow_up` 与 `UserMessage.source`、`QueuedMessage.kind` 的字面量一致,snake_case 贯穿 wire 面。

映射规则:

| 命令 | Agent API | 运行中语义 |
|---|---|---|
| `prompt` | `agent.prompt(text)` | running 时 **不 throw 到进程**,输出 `{type:'error', fatal:false, message:'agent is running; use steer or follow_up'}` |
| `steer` | `agent.steer(text)` | 随时合法;idle 时消息滞留队列,由下一次 prompt/continue 消费(与 pi 「启动前 poll 一次 steering」语义一致) |
| `follow_up` | `agent.followUp(text)` | 随时合法 |
| `abort` | `agent.abort()` | idle 时为 no-op |
| `shutdown` | 见 6.4 | — |

### 6.3 输出规格(stdout,NDJSON)

- 启动时 stdout 先输出一条旁路事件 `{"type":"protocol","protocolVersion":"<semver>"}`(见 [03](./03-internal-protocol.md) §9.2),声明事件流的协议版本;tolerant reader 可忽略未知事件类型。
- 其后每行一个 JSON 序列化的 `AgentEvent`,原样外发、不包裹信封,`AgentEvent` 行不加任何自定义字段——事件类型本身自带判别。消费者据 `agent_end` 判断任务边界,据 `message_update` 内层 `ProviderEvent` 做流式渲染,与交互 Renderer 用同一张对应表(第 4 节)。
- **stdout 纪律:除 NDJSON 外零输出。** 日志、警告一律走 stderr。这条不守住,下游 `| jq` 直接坏。
- 无法解析的 stdin 行:输出 `{type:'error', fatal:false, message:'invalid command: …'}`,继续读下一行(容错,不退出)。
- `partial` 快照会让 `message_update` 事件体较大;v1 照发(简单正确优先),`--json-compact`(剥离 partial 只留 delta)留作后续 flag,不进 v1。

### 6.4 生命周期与退出

```
stdin EOF        → 视同 shutdown
shutdown(空闲)  → flush 会话,exit 0
shutdown(运行中)→ agent.abort() → waitForIdle() → flush → exit 0
SIGINT / SIGTERM → 同 shutdown(运行中)
致命错误         → 输出 {type:'error', fatal:true} 后 exit 1
```

`-p "..."` 一次性模式即 headless 内核的特例:注入一条 `prompt`,`agent_end` 后自动 `shutdown`,人类可读输出(或加 `--json` 输出事件流)。

### 6.5 headless 会话示例

```
stdin : {"type":"prompt","text":"列出 src 下的 ts 文件"}
stdout: {"type":"agent_start","reason":"prompt"}
stdout: {"type":"turn_start"}
stdout: {"type":"message_start","message":{"role":"user",…}}
stdout: {"type":"message_update","messageId":"…","event":{"type":"text_delta",…}}
stdin : {"type":"steer","text":"只要 cli 目录的"}
stdout: {"type":"queue_update","steering":[{"id":"…","text":"只要 cli 目录的","kind":"steering"}],"followUp":[]}
stdout: {"type":"tool_execution_start","toolCallId":"…","toolName":"glob",…}
…
stdout: {"type":"agent_end","reason":"completed","messages":[…]}
stdin : {"type":"shutdown"}
```

M6 起本协议增补 `{ type: 'approval'; approvalId: string; decision: 'allow_once' | 'allow_always' | 'deny' | 'abort' }` 命令(codex 把审批应答也做成 Op 的同构做法)。审批策略由 `--approval-mode <interactive|allow|deny>` 控制:交互 REPL 默认 `interactive`;headless 与 `-p` 默认 `allow`(机器驱动的管道是调用方自决的信任边界,默认 deny 会让每个脚本都得先学一个 flag;需要审批流的客户端显式开 `interactive` 并应答 approval 命令),不阻塞管道。

## 7. 配置:模型 / baseURL / apiKey

### 7.1 来源与优先级

**flags > 环境变量 > `~/.coda/config.json` > 内置默认**。逐字段独立合并(flag 只给了 `--model` 时,baseURL 仍可来自配置文件)。

| 配置项 | flag | 环境变量 | config.json 字段 |
|---|---|---|---|
| 模型 | `--model` | `CODA_MODEL` | `model` |
| baseURL | `--base-url` | `CODA_BASE_URL` | `baseURL` |
| apiKey | `--api-key`(不推荐,进程列表可见) | `CODA_API_KEY`,回退 `OPENAI_API_KEY` | `apiKeyEnv`(推荐)/ `apiKey`(明文,警告) |

```ts
// ~/.coda/config.json
interface CodaConfig {
  model?: string;              // 如 "gpt-5.2";带斜杠时解析为 provider/model
  baseURL?: string;
  apiKeyEnv?: string;          // 指向环境变量名,避免密钥落盘
  apiKey?: string;             // 明文兜底;存在时启动打印警告
  defaults?: { temperature?: number; reasoningEffort?: string; maxOutputTokens?: number };
  compat?: CompatFlags;        // 显式方言覆盖,見 04 文档;省缺按 baseURL 自动推断
}
```

### 7.2 解析伪码

```ts
function resolveConfig(flags, env, file): ResolvedConfig {
  const pick = <K>(f?: K, e?: K, c?: K, d?: K) => f ?? e ?? c ?? d;
  const model   = pick(flags.model, env.CODA_MODEL, file.model, 'gpt-5.2');
  const baseURL = pick(flags.baseUrl, env.CODA_BASE_URL, file.baseURL, undefined);
  const apiKey  = pick(flags.apiKey, env.CODA_API_KEY ?? env.OPENAI_API_KEY,
                       file.apiKeyEnv ? env[file.apiKeyEnv] : file.apiKey, undefined);
  if (!apiKey) exitWithHint('未找到 API key:设置 OPENAI_API_KEY,或 ~/.coda/config.json 的 apiKeyEnv');
  return { modelConfig: { ref: { provider: 'openai', api: 'openai-chat', model },
                          baseURL, apiKey, compat: file.compat,
                          defaults: file.defaults } };
}
```

要点:

- 缺 key 的报错必须给出**可执行的修复提示**(设哪个变量、改哪个文件),这是 CLI 第一印象。
- 密钥永远不进 `~/.coda/sessions/` 的 JSONL,也不出现在任何 `AgentEvent` 里(`ModelConfig` 不随事件外发)。
- v1 单 profile;多 profile(`profiles: Record<string, …>` + `--profile`)是纯增量扩展,结构上已预留。

## 8. 边界情况

- **非 TTY stdin**(`echo "..." | coda`):自动等价 `-p` 模式读完 stdin 作为 prompt;`--json` 显式给出时按 headless 协议解析。
- **粘贴多行文本**:启用 bracketed paste(`\x1b[?2004h`),粘贴内容含换行不触发发送;不支持的终端退化为逐行(已知限制,记文档)。
- **窗口 resize**:`SIGWINCH` 时重绘底部动态区;转录区不回改(append-only 的代价,可接受)。
- **CJK / emoji 宽字符**:动态区截断按显示宽度(简化版 wcwidth)而非 code unit,否则重绘错位。
- **Windows**:`\r\n` 键入事件、conhost 对部分 ANSI 序列支持差——v1 明确只承诺 Windows Terminal;plain 模式是所有终端的保底。

## 9. 验收清单

- [ ] 流式输出期间打字,输入行内容不被 delta 冲花;Enter 后徽标出现 `steer 1`,转录区在下个 turn 边界出现 `» steering:` 回显
- [ ] `Esc` 在 50ms 消歧下:方向键不触发 abort;流式中裸 Esc 一次即 abort,assistant 消息以 `[aborted]` 收尾
- [ ] `Alt+Enter` 与 `/f ` 前缀均能入 follow-up 队列(至少各在一种终端验证)
- [ ] `coda --continue` 重放转录后,新输入接在原上下文继续
- [ ] `coda --json` 下:乱输入一行非 JSON 不退出;`prompt`-running 冲突返回 non-fatal error 事件;`shutdown` 在运行中先 abort 再 flush 退出,exit code 0
- [ ] `--json` 的 stdout 每一行都能被 `jq .` 解析(管道纪律)
- [ ] 配置优先级:同时给 flag/env/config 三处不同 model,生效的是 flag;去掉 flag 生效 env
- [ ] 非 TTY 管道输入自动走一次性模式;`NO_COLOR` 下输出无 ANSI 序列

## 相关文档

- [03-internal-protocol.md](./03-internal-protocol.md) —— 本文渲染与外发的 `AgentEvent` / `ProviderEvent` 的定义
- [06-steering-following.md](./06-steering-following.md) —— Enter=steer / Alt+Enter=followUp 背后的队列语义
- [08-session-persistence.md](./08-session-persistence.md) —— `--continue` / `--resume` 依赖的会话存储与恢复
- [10-testing.md](./10-testing.md) —— 基于 `--json` 管道的 e2e 测试方案
