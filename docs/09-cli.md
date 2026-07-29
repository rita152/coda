[← 返回地图](./README.md)

# 09 CLI / TUI:交互模式、流式渲染、键位与 headless JSON 模式

CLI 是整个系统里**最薄**的一层:它只做两件事——把用户输入翻译成对 `Session` 门面的调用(`prompt` / `steer` / `followUp` / `abort`),把 `SessionEvent` 流翻译成终端像素。所有智能都在 agent/session 核心;CLI 的局部视图状态只是事件投影,不是新的事实源,也不理解 provider wire 或执行工具。headless JSON 模式(见第 6 节)继续机械验证这条纪律——**交互 TUI 能做的每件事,都必须能由同一组方法或一行 JSON 命令表达**。

## 1. 交互形态:Bun + `@opentui/core`

### 1.1 模式分派与依赖边界

双 TTY 的默认交互面是 `@opentui/core` 0.4.x 全屏 TUI。OpenTUI 只在确认进入该分支后动态导入,所以脚本路径不加载 native 包:

| 条件 | 前端 |
|---|---|
| `--json` | `startHeadless()`;stdin/stdout NDJSON |
| `-p`、裸 prompt、非 TTY stdin | plain `Renderer`;跑完退出 |
| stdin/stdout 都是 TTY 且 `TERM != dumb` | `startTui()`;alternate screen |
| 双 TTY + `TERM=dumb` | classic readline/raw TTY + ANSI `Renderer` |
| OpenTUI 初始化失败，且 API key 已配置 | 清理 OpenTUI 后降级 classic |
| OpenTUI 初始化失败，且 API key 因 eligible TUI 延迟校验 | 关闭 Session，打印缺 key 提示并退出 2 |
| stdin 是 TTY、stdout 非 TTY | classic 输入 + plain 追加输出 |

OpenTUI 与 classic REPL 不能同时存在:二者都会接管 raw stdin/stdout。`main.ts` 因此必须在创建 stdout FileSink/legacy renderer **之前**选择 TUI。没有额外的 `--classic` 开关；初始化失败时先完整销毁 OpenTUI，已配置 key 的会话再自动进入 classic。唯一例外是缺 key 只因 eligible TUI 配置面而延迟校验的会话:classic 没有密钥配置面，不能把它降级到一个必然认证失败的界面，必须关闭 Session、给出 provider 对应提示并退出 2。生产构建保持 `Bun.build({ packages: 'external' })`;运行时安装当前平台的 OpenTUI optional native package。`--json`、`-p` 和管道协议不因 TUI 发生任何变化。

### 1.2 全屏布局与顶部起排不变量

TUI 进入 alternate screen，组件树固定为:

```text
root column (100% × 100%)
├── header:版本 + Unicode 像素 Logo + tips
├── transcript:ScrollBox(flexGrow:1)
└── composer
    ├── prompt box
    ├── workspace
    └── context usage                         provider/model
```

- **header**:从 `package.json.version` 取当前版本;Logo 是 ImageGen 参考图
  `assets/branding/coda-pixel-logo-reference.png` 的 6 行 Unicode block 复刻,运行时不读 PNG、不依赖终端图片协议。
- **transcript**:assistant Markdown、user/steering/follow-up、工具进度、diff、plan 与告警按事件顺序向下排列。关键配置是 `contentOptions.flexDirection:'column'`、`justifyContent:'flex-start'`、`minHeight:'auto'`;禁止 `column-reverse` / `flex-end`。短内容从中区第一行向下增长,不是 pi 风格从 prompt 上方向上堆。`stickyScroll:true, stickyStart:'bottom'` 只在内容溢出后跟随尾部;用户手动上滚时暂停跟尾。
- **composer**:固定在屏幕底部。prompt 下方严格两行:第一行 workspace(可带 Git branch),第二行左侧当前 `usage.contextTokens`、右侧当前 `ModelRef`。只有 `ModelConfig.limits.context` 明确存在时才显示百分比;缺上限显示 `limit unknown`,不得按模型名猜窗口大小。
- **响应式**:窄屏先隐藏 tips,再隐藏 Logo和右侧 model;版本、prompt、workspace/context 始终保留。
- **主题**:默认主画布与 transcript 使用纯白 `#ffffff`,header/prompt 使用轻微灰阶分层；正文、muted 与各语义状态色都按白底重新取值。OpenTUI 0.4.5 的运行时构造器不读取 `backgroundColor` 配置,所以生产初始化还必须调用 `renderer.setBackgroundColor(...)` 同步 native framebuffer。主画布白色必须构造成 `RGBA.fromIndex(231, '#ffffff')`,header 浅灰构造成 `RGBA.fromIndex(255, '#fafafa')`,不能让高亮 RGB 在非 truecolor 环境量化为主题可重定义的 ANSI 亮白槽 15。该 setter 不能替代视图绘制:页面、header 子层、ScrollBox 的 root/wrapper/viewport/content、转录内容和 footer 仍必须显式绘制对应不透明底色,让首帧在没有 `COLORTERM=truecolor` 时也保持白色/浅灰背景,而不是通过 SGR 49 露出用户的深色终端背景。`NO_COLOR` / `--no-color` 时不设置这些自定义底色,回到终端默认配色。

OpenTUI 是这一分支的唯一终端写入者和键盘焦点管理者。`exitOnCtrlC:false`、`exitSignals:[]` 让 CLI 在销毁 alternate screen 前先执行 `abort → approval.onAbort → Session.close()`;`destroy()` 恢复 raw mode、鼠标与主屏。`NO_COLOR` / `--no-color` 禁用 coda 自定义调色,但不改变布局和键位。

所有来自模型、工具、仓库、配置与持久化会话的文本都按不可信终端输入处理。进入 Text/Markdown、状态栏、工具摘要、diff 或终端标题前统一经过 `sanitizeTerminalText`:剥离 ANSI CSI/OSC/DCS/APC/PM/SOS 序列,移除除 `\t` / `\n` 外的 C0 与全部 C1 控制字符。不得依赖组件转义来阻止 OSC 52、标题注入或隐藏控制字符。

### 1.3 classic / plain 保底

`renderer.ts` 与 `repl.ts` 仍是受支持的降级面:classic 用 readline/raw TTY compatibility + ANSI 动态区;plain 是纯追加输出。它们同时服务 `TERM=dumb`、非 TTY 与一次性路径,不能删除。classic 的单写入者、stdout 有序 FileSink、动态区宽度清洗与写失败收尾契约保持不变;TUI 则由 OpenTUI 自己调度帧,不经过这个 FileSink。

## 2. 启动流程与会话选择

```
coda                    # 新会话
coda -p "..."           # 一次性:发送 prompt,跑完以 plain 输出退出
coda --continue         # 恢复最近一个会话
coda --resume [id]      # 无 id 时列出 ~/.coda/sessions/ 供选择(编号 + 首条 prompt 摘要 + 时间)
coda --json             # headless JSON 模式(第 6 节)
```

启动组装顺序(伪码):

```ts
const tuiEligible = isFullScreenTuiEligible(flags, terminal);
const config      = resolveConfig(flags, env, readConfigFile(), {  // 第 7 节
  allowMissingApiKey: tuiEligible,
});
const model       = toModelConfig(config);                         // ModelRef + baseURL/apiKey/compat
const agentConfig = { streamFn: openaiChatStream, model, tools: builtinTools, systemPrompt };
const session     = resuming
  ? await Session.resume(sessionId, { agentConfig })   // 加载 JSONL,内部组装 Agent 并注入 initialMessages
  : await Session.create({ agentConfig });             // 见 08 文档第 2 节
if (flags.json) return startHeadless(session, ...);
if (flags.prompt !== undefined) return runOneShotWithPlainRenderer(session, ...);
if (stdinIsTty && stdoutIsTty && TERM !== 'dumb') {
  try {
    const { startTui } = await import('./tui.js');     // native 依赖只在这里加载
    return await startTui(session, approval, {
      cwd, model: model.ref, version: packageJson.version,
      contextLimit: model.limits?.context,
    });
  } catch (error) {
    if (getMissingApiKeyMessage(config)) {
      logTuiUnavailable(error);
      logMissingApiKey(config);
      await session.close();
      return 2;                                       // classic 没有 key 配置面
    }
    logTuiFallback(error);                             // startTui 已恢复终端
  }
}
return startRepl(session, createClassicRenderer(...), approval);
```

Agent 由 Session 内部组装并持有(见 [08-session-persistence](./08-session-persistence.md) 第 1–2 节),CLI 订阅的是 Session 而非 Agent——这样 `retry_scheduled` / `compaction_start` 等 SessionEvent 才能透传到 UI。落盘监听在 UI 监听之前。TUI 监听器只同步更新组件树,OpenTUI 按 `maxFps:30` 合并绘制;plain/classic 监听器继续在每个事件后等待 stdout `drain` 施加背压。审批事件由 `ApprovalBroker` 的旁路订阅送进同一前端。

## 3. 键位表

| 状态 | 键 | 行为 |
|---|---|---|
| 空闲 | `Enter` | 发送输入(`session.prompt(text)`) |
| 任意输入 | `Shift+Enter` | 插入换行,不发送 |
| 任意 | `Ctrl+C` | 输入非空:清空输入行;输入为空:提示「再按一次退出」,1.5s 内再按退出 |
| 空闲 | `Ctrl+D` | 输入为空时退出 |
| 任意 | `Meta+↑` / `Meta+↓` | 输入历史(普通方向键留给多行编辑) |
| 流式中 | `Enter` | 当前输入入 **steering** 队列(`session.steer(text)`) |
| retry backoff | `Enter` | 当前输入入 **steering** 队列,等待重试 turn 消费 |
| compacting | `Enter` | 按空闲语义调用 `session.prompt(text)`;Session 在 compaction 完成后启动 |
| 任意 | `Alt+Enter` | 当前输入入 **follow-up** 队列(`session.followUp(text)`；空闲时只排队) |
| 流式中 | `Esc` | `session.abort()`(硬中断) |
| retry backoff / compacting | `Esc` | `session.abort()`;取消待重试或压缩 |
| 任意 | `PageUp` / `PageDown` | 滚动中间 transcript,输入框保持焦点 |
| 任意 | `Esc Esc`(500ms 内)或 `Ctrl+C Ctrl+C` | 退出(流式中先 abort,`waitForIdle` 落盘后退出) |
| 审批中 | 无修饰的 `y` / `a` / `n` / `Esc` | 本次允许 / 始终允许 / 拒绝 / 中止；修饰键组合、普通键与 bracketed paste 全部冻结 |

### 3.1 为什么与 pi 完全一致

键位延续原 classic REPL 与 pi 的交互语义:

- **流式期间打字的默认去向应当是风险最低的动作。** 用户在模型工作时输入,绝大多数意图是「补充/纠偏」,而 steering 恰好是不打断执行中工具、在 turn 边界温和注入的语义(见 [06-steering-following](./06-steering-following.md))——把它放在无修饰的 `Enter` 上,让最自然的动作对应最安全的语义。
- **升级动作配升级键。** follow-up(等整个任务结束)是更「延后」的意图,配组合键 `Alt+Enter`;abort 是破坏性动作,配独立键 `Esc`,与输入内容无关(Esc 不消费输入框文本)。
- **`prompt()` 运行中 throw 在 UI 层被键位表吸收**:CLI 在 running/retrying 状态不会调 `prompt`;compacting 是 Session 明确定义的可暂存新 prompt 状态。用户无需理解这些约束,键位已经替他选好了。

### 3.2 终端编码现实

- OpenTUI 默认启用 Kitty keyboard disambiguation;支持该协议的终端能可靠区分 `Esc`、`Alt+Enter` 与 `Shift+Enter`。不支持时由解析器降级;classic 仍用 readline `escapeCodeTimeout=50ms`。
- `Alt+Enter` 以 `key.meta && return` 为主。始终保留 `/f ` / `/followup ` 兜底,保证不能发送 Meta+Enter 的终端仍有完整功能。
- Shift+Enter 在不报告修饰键的旧终端可能退化成普通 Enter;可用 bracketed paste 输入多行。
- 其余空闲斜杠命令:`/quit`、`/queue`、`/status`、`/help`。

## 4. 渲染器与 SessionEvent 对应表

交互 TUI 直接消费 `SessionEvent`;classic/plain 继续实现 `Renderer` 接口:

```ts
// src/cli/renderer.ts
export interface Renderer {
  render(e: SessionEvent): void;
  replayTranscript(messages: readonly AgentMessage[]);// --continue/--resume 启动时
  drain(): Promise<void>;                             // 等待此前排队的 stdout 内容
}
```

`SessionEvent` 是 [03-internal-protocol](./03-internal-protocol.md) 的
`AgentEvent` 加上 retry/compaction 等会话级事件。各事件的 TUI 渲染行为:

| SessionEvent | TUI 渲染行为 |
|---|---|
| `agent_start` | prompt title 进入 working;`reason:'follow_up'` 追加 `↪ follow-up` |
| `agent_end` | 最终边界追加 done/aborted/error;`willRetry:true` 保持 retrying,不误报完成 |
| `turn_start` | 无可见输出(内部计数) |
| `turn_end` | 无额外分隔组件 |
| `message_start` (user) | 追加 user / steering / follow-up / synthetic 块 |
| `message_start` (assistant) | 创建按 message id 索引的流式 Markdown 块 |
| `message_update` | `text_delta` / `reasoning_delta` 分别按 `contentIndex` 累积到有序块,块间保留空行；不能把多个 content part 粘成一个单词或在最终消息到达时跳变；tool-call 参数流只更新 activity |
| `message_end` (assistant) | `stopReason: 'length'` 追加警示行 `[output truncated by model limit]`;`'aborted'` 追加 `[aborted]` |
| `message_end` (tool_result) | 已由 `tool_execution_end` 渲染,此处无输出(去重) |
| `tool_execution_start/update/end` | 原位更新同一工具块:`●` → 尾行 → `✓/✗`;diff 以语义颜色追加(上限 24 行) |
| `queue_update` | 完整替换计数;running 时显示在 prompt bottom title |
| `plan_update` | 原位替换同一 plan 块:`✓` / `▶` / `○`,不重复追加整表 |
| `approval_request` | transcript 留痕,prompt box 切黄色审批标题与专用键位 |
| `usage_update` | 用 `contextTokens` 刷新 footer;不使用 cumulative 伪装当前上下文 |
| `retry_scheduled` / `compaction_*` | 追加 notice 并更新 activity；controller 与 view 共享同一个 SessionEvent 状态投影,不得分别读取瞬时的 `agent.state`；取消重试后的 error 与 compaction_end 都回到 idle |
| `error` | `fatal: false` 打印警告行;`fatal: true` 打印错误并进入退出流程 |

工具头单行摘要规则(`tool_execution_start` 用 `args` 生成,不等结果):

| 工具 | 摘要示例 |
|---|---|
| read | `read src/agent/loop.ts [offset=200]` |
| ls / glob / grep | `grep "StreamFn" src/ (limit 100)` |
| bash | `bash: <command 首行,截 80 列>` |
| edit / write | `edit src/cli/repl.ts (2 edits)` / `write docs/x.md` |
| plan | 不渲染工具头,由 `plan_update` 事件负责(旁路事件,codex `update_plan` 同构) |

## 5. 全屏一屏示意

```
┌─ coda v0.0.1 ─────────────────────────────────────────────┐
│ [pixel logo]  Welcome back!  │ Tips for getting started  │
└───────────────────────────────────────────────────────────┘
  you
  把 renderer 抽成接口

  coda
  我会先检查事件边界，然后修改实现……▌

                 （剩余空间；内容继续向下增长）

╭─ coda · working ──────────────────────────────────────────╮
│ 顺便把颜色常量也挪过去_                                  │
╰─ Enter steer · Alt+Enter follow-up · Esc abort ──────────╯
 ~/Desktop/openai/openai-sdk-ts  (main)
 context 2.4k / 128k · 1.9%                    openai/gpt-5.2
```

中间转录短时锚定顶部;只有填满后才滚动并跟随最新内容。用户此刻按 `Enter`,输入文本进 steering 队列;prompt 和两行 footer 的屏幕位置不动。

## 6. Headless JSON 模式(`--json`)

### 6.1 定位:内部协议的对外验证面

`coda --json` 把交互前端换成纯 JSON 管道:stdin 一行一条命令,stdout 一行一条 `SessionEvent`(NDJSON)。这不是附赠功能,而是架构自证:

- **它证明 CLI 没有私藏语义。** 键位表的每个动作(第 3 节)在这里都有同构命令;若某能力只能在交互模式做到,说明该逻辑放错了层。
- **它是 codex 外协议的最小同构。** codex 的边界只有 `submit(Op)` 与 `next_event()`,一切 UI 交互(含审批应答)都是可序列化的 Op;我们的命令流/事件流与之同形,天然可保序、可跨进程。
- **它是未来 server 化 / IDE 集成的基础。** 把 stdin/stdout 换成 WebSocket 或 HTTP+SSE,协议一字不改——opencode V2 的 client/server 重写之所以痛苦,正因为 V1 没有先留下这个面。
- **它是 e2e 测试的执行面。** [10-testing](./10-testing.md) 的 CLI e2e 用 faux provider + `--json` 管道断言事件序列,完全离线、无 PTY 依赖。

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
- 其后每行一个 JSON 序列化的 `SessionEvent`,原样外发、不包裹信封,事件行不加任何自定义字段——事件类型本身自带判别。消费者据 `agent_end` 判断任务边界；其中 `willRetry:true` 表示 Session 已安排自动重试，是中间边界，只有不带该标记的 `agent_end` 才是最终边界。据 `message_update` 内层 `ProviderEvent` 做流式渲染,与交互前端用同一张对应表(第 4 节)。
- **stdout 纪律:除 NDJSON 外零输出。** 日志、警告一律走 stderr。这条不守住,下游 `| jq` 直接坏。
- Session 事件监听器在每条 NDJSON 后等待同一有序输出队列 `drain`；命令错误与审批旁路事件也进入该队列，保持全局顺序并观察写入失败。
- 无法解析的 stdin 行:输出 `{type:'error', fatal:false, message:'invalid command: …'}`,继续读下一行(容错,不退出)。
- `partial` 快照会让 `message_update` 事件体较大;v1 照发(简单正确优先),`--json-compact`(剥离 partial 只留 delta)留作后续 flag,不进 v1。

### 6.4 生命周期与退出

```
stdin EOF        → 视同 shutdown
shutdown(空闲)  → flush 会话 → drain stdout → exit 0
shutdown(运行中)→ agent.abort() → waitForIdle() → flush → drain stdout → exit 0
SIGINT / SIGTERM → 同 shutdown(运行中)
致命错误         → 输出 {type:'error', fatal:true} → drain stdout → exit 1
```

`-p "..."` 一次性模式与 headless 共用同一套 one-shot 生命周期语义:注入一条 `prompt`,忽略带 `willRetry:true` 的中间 `agent_end`,等待最终 `agent_end` 后自动 `shutdown`,默认用 plain 人类可读输出(加 `--json` 时改为事件流)。它不调用 `startHeadless()`。初次 `prompt()` 返回只代表首轮 agent run 已落定,不能据此提前关闭 Session；自动重试属于 Session 的 detached follow-up,必须一并等待。若等待期间收到 `fatal:true` error（例如注入的 retry sleep 失效），则立即按致命错误路径收尾并以 1 退出。

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

M6 起本协议增补 `{ type: 'approval'; approvalId: string; decision: 'allow_once' | 'allow_always' | 'deny' | 'abort' }` 命令(codex 把审批应答也做成 Op 的同构做法)。审批策略由 `--approval-mode <interactive|allow|deny>` 控制:交互 TUI/classic 默认 `interactive`;headless 与 `-p` 默认 `allow`(机器驱动的管道是调用方自决的信任边界,默认 deny 会让每个脚本都得先学一个 flag;需要审批流的客户端显式开 `interactive` 并应答 approval 命令),不阻塞管道。

## 7. 配置:模型 / baseURL / apiKey

### 7.1 来源与优先级

**flags > 环境变量 > `~/.coda/config.json` > 内置默认**。逐字段独立合并(flag 只给了 `--model` 时,baseURL 仍可来自配置文件)。

| 配置项 | flag | 环境变量 | config.json 字段 |
|---|---|---|---|
| 模型 | `--model` | `CODA_MODEL` | `model` |
| baseURL | `--base-url` | `CODA_BASE_URL` | `baseURL` |
| apiKey | `--api-key`(不推荐,进程列表可见) | `CODA_API_KEY`;OpenAI 回退 `OPENAI_API_KEY`;Anthropic 回退 `ANTHROPIC_API_KEY` | `apiKeyEnv`(推荐)/ `apiKey`(明文,警告) |

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
function resolveConfig(flags, env, file, { allowMissingApiKey = false } = {}): ResolvedConfig {
  const provider = flags.provider ?? 'openai-chat';
  const pick = <K>(f?: K, e?: K, c?: K, d?: K) => f ?? e ?? c ?? d;
  const nonBlank = (value?: string) => value?.trim() || undefined;
  const model   = pick(flags.model, env.CODA_MODEL, file.model, 'gpt-5.2');
  const baseURL = pick(flags.baseUrl, env.CODA_BASE_URL, file.baseURL, undefined);
  const providerKeyEnv =
    provider === 'anthropic-messages' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKeyEnv = file.apiKeyEnv?.trim();
  const fileKey = apiKeyEnv ? nonBlank(env[apiKeyEnv]) : nonBlank(file.apiKey);
  const apiKey =
    nonBlank(flags.apiKey) ??
    nonBlank(env.CODA_API_KEY) ??
    nonBlank(env[providerKeyEnv]) ??
    fileKey;
  if (provider !== 'faux' && !apiKey && !allowMissingApiKey) {
    exitWithHint(`未找到 API key:设置 ${providerKeyEnv},或 ~/.coda/config.json 的 apiKeyEnv`);
  }
  return { modelConfig: { ref: toModelRef(provider, model),
                          baseURL, apiKey, compat: file.compat,
                          defaults: file.defaults } };
}
```

要点:

- key 值在来源边界去除首尾空白；空串或全空白等同缺失，不得遮蔽下一级来源。`apiKeyEnv` 一旦指向非空变量名，该变量就是 config 层的唯一 key 来源，不再静默回退同文件中的明文 `apiKey`。
- 缺 key 是 eligible 全屏 TUI 的合法启动状态,不得阻拦页面打开；本阶段尚不实现 TUI 内密钥输入或持久化,用户在配置能力完成前提交 prompt 会得到 provider 的认证错误事件。
- `--json`、`-p`、裸 prompt、管道输入、非双 TTY 与 `TERM=dumb` 没有 TUI 配置面,仍在创建 Session 前 fail-fast,并给出**可执行的 provider 对应提示**(OpenAI 设置 `OPENAI_API_KEY`,Anthropic 设置 `ANTHROPIC_API_KEY`;两者都可设置 `CODA_API_KEY` 或配置文件 `apiKeyEnv`)。OpenTUI 初始化失败时也不得把缺 key 会话降级进 classic。
- 密钥永远不进 `~/.coda/sessions/` 的 JSONL,也不出现在任何 `SessionEvent` 里(`ModelConfig` 不随事件外发)。
- v1 单 profile;多 profile(`profiles: Record<string, …>` + `--profile`)是纯增量扩展,结构上已预留。

## 8. 边界情况

- **非 TTY stdin**(`echo "..." | coda`):自动等价 `-p` 模式读完 stdin 作为 prompt;`--json` 显式给出时按 headless 协议解析。
- **粘贴多行文本**:OpenTUI Textarea 与 classic 都启用 bracketed paste,粘贴换行不发送;审批期间整段 paste 被输入边界拦截,不能把首字符误判为 `y` / `a` / `n`;不支持 bracketed paste 时是终端自身的已知限制。
- **窗口 resize**:OpenTUI 重跑 Yoga 布局;宽度不足依次收起 tips、Logo、model。transcript 内容重排但顺序不变,composer 始终在底部。
- **CJK / emoji 宽字符**:OpenTUI native buffer 负责全屏分支的列宽;程序化设置输入历史后调用 Textarea 的 buffer-end API,不能用 JavaScript UTF-16 `string.length` 猜光标列。classic 动态区继续用仓库的 `displayWidth`/截断实现。
- **过小终端**:header/composer 先进入 compact 高度,中区至少保留 1 行;无法容纳时由终端裁切,不改变事件或输入语义。
- **Windows**:OpenTUI 依赖对应 win32 native optional package;classic/plain 仍是 `TERM=dumb` 或初始化失败时的保底。只承诺现代 Windows Terminal。
- **恢复转录**:`--continue` / `--resume` 在显示 TUI 前用最终 `AgentMessage` hydrate,不伪造生命周期事件。assistant 的多 text/reasoning part 按原顺序分块；历史 tool call 必须从参数恢复工具摘要；plan tool result 从 `details.steps` 恢复最新 plan,失败结果仍可见。初始化/重放失败必须 destroy OpenTUI 后才允许降级 classic。

## 9. 验收清单

- [ ] 100×30 下 header 含版本/Logo/tips;首条 user/assistant 紧跟中区顶部,短内容下方留白而不是贴 footer
- [ ] 长输出填满中区后自动跟尾;PageUp 手动上滚后不抢回,PageDown 可回到最新内容
- [ ] prompt 下恰有 workspace 与 context/model 两行;resize 窄→宽后完整快捷键恢复,审批提示不被 compact 文案覆盖
- [ ] 流式输出期间输入框稳定;Enter 后出现 steering 回显,Shift+Enter 只插入换行
- [ ] retry backoff 期间 Enter 入 steering 队列、Esc 取消重试；compacting 期间 Enter 的 prompt 在压缩完成后启动
- [ ] `Esc` 不与方向键冲突;流式中裸 Esc 一次 abort,assistant 以 `[aborted]` 收尾
- [ ] `Alt+Enter` 与 `/f ` 前缀均能入 follow-up 队列(至少各在一种终端验证)
- [ ] `coda --continue` 重放转录后,tool 摘要、最新 plan 与 plan error 都保留,新输入接在原上下文继续
- [ ] 模型/工具/持久化文本中的 CSI/OSC/DCS 与 C0/C1 控制字符不会进入帧或终端标题
- [ ] 无 `COLORTERM` 的 256 色双 TTY 中首帧使用白色槽 231,不依赖主题槽 15
- [ ] TUI 正常退出、fatal、审批中 abort 与初始化失败四条路径都恢复主屏/raw mode；初始化失败后 classic 无双重输入
- [ ] `coda --json` 下:乱输入一行非 JSON 不退出;`prompt`-running 冲突返回 non-fatal error 事件;`shutdown` 在运行中先 abort 再 flush 退出,exit code 0
- [ ] `--json` 的 stdout 每一行都能被 `jq .` 解析(管道纪律)
- [ ] 配置优先级:同时给 flag/env/config 三处不同 model,生效的是 flag;去掉 flag 生效 env
- [ ] 非 TTY 管道输入自动走一次性模式;`NO_COLOR` 下不出现 coda 自定义调色

## 相关文档

- [03-internal-protocol.md](./03-internal-protocol.md) —— `SessionEvent` 所承载的 `AgentEvent` / `ProviderEvent` 定义
- [06-steering-following.md](./06-steering-following.md) —— Enter=steer / Alt+Enter=followUp 背后的队列语义
- [08-session-persistence.md](./08-session-persistence.md) —— `--continue` / `--resume` 依赖的会话存储与恢复
- [10-testing.md](./10-testing.md) —— 基于 `--json` 管道的 e2e 测试方案
