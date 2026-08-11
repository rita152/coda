# Coda CLI Composer 上方活动状态调研

调研日期：2026-08-11

## 问题

在 Coda CLI 的 Composer 上方靠左增加一个活动状态，使用户能看见 Coda 当前处于什么阶段，并据此判断它是在正常等待、正在推进，还是可能已经卡住。

本调研只使用项目自身的源码、测试和官方仓库作为事实来源。外部仓库链接均固定到调研时的 commit，而不是浮动分支。

## 执行摘要

最接近需求的现成实现是 OpenAI Codex：它明确把一条 live task status row 放在 Composer 上方，默认显示 `Working`，同一行带总耗时和 interrupt 提示，并允许上层更新标题与有限详情。Gemini CLI 的强项不是几何，而是状态内容优先级：等待用户操作优先于模型 thought 摘要，再退化到 loading phrase 或 `Thinking...`。Pi 证明了在 TypeScript TUI 中用独立 status container 区分 working、retry、compaction 等状态很直接。OpenCode 则展示了过度粗糙的 `idle | busy | retry` 状态只能回答“忙不忙”，无法回答“正在做什么”。

对 Coda 最合适的组合不是照搬单一项目，而是：

1. 采用 Codex/Pi 的 Composer 上方独立活动行；
2. 采用 Gemini 的“可操作状态优先”规则；
3. 从 Coda 已有的权威 `AgentEvent`、Tool Invocation、Approval 和 User Shell 状态投影，不另造一份独立 busy map；
4. 第一版显示可核实的阶段、阶段耗时和可选的“距上次语义事件多久”，不声称自动判定“卡住”；
5. 模型自行生成的自然语言进度可以以后作为次要说明，但不应成为主状态或 liveness 依据。

Coda 当前的数据已经足够做一个有用的第一版，通常不需要先扩展 `@coda/agent` 的公共事件协议。主要缺口位于 Run 开始前的输入准备，以及 `run_end` 观察者尚在 settle 的短窗口；是否必须精确覆盖这两个窗口，应在产品语义确定后再决定。

## Coda 当前实现

### 已有状态与事件

`AgentEvent` 已覆盖以下事实，并且每个事件都有 `runId`、单调 `sequence` 和 `timestamp`：

- `run_start` / `run_end`
- `turn_start` / `turn_end`
- `attempt_start` / `attempt_end`
- `message_start` / `message_end`
- `message_update`，其中又能区分 text、thinking、tool-call 的 start/delta/end
- `retry_scheduled`，包含 attempt、delay 和 reason
- `tool_execution_start` / `tool_execution_progress` / `tool_execution_end`
- Tool progress 的数值、总量和可选 message

证据：`packages/agent/src/types.ts:125-138,184-327`。

这意味着 UI 可以确定性地区分至少这些阶段：准备/等待模型、Thinking、输出文本、构造 Tool Invocation、执行 Tool、Tool progress、重试倒计时、结束。它不必从 Assistant 文本猜测状态。

### Chat 和 Timeline 已消费同一事件源

`ChatComponent.accept()` 已经接收全部 `AgentEvent`，把它们交给 `SemanticTimeline`，并在 `run_start`/`run_end` 上维护现有 `#running`。`SemanticTimeline` 已记录 Tool 的 `state`、`startedAt`、`endedAt`、`progress` 与 Approval 状态，还能查询是否存在 active Tool。

证据：

- `packages/coding-agent/src/interactive/chat-component.ts:305-420`
- `packages/coding-agent/src/interactive/semantic-timeline.ts:74-84,178-220,489-525`

现有 Tool 呈现层还已经拥有适合状态行复用的动作语言：`Reading`、`Searching`、`Editing`、`Writing`、`Running`、`Exploring`、`Calling`，并负责参数清洗、截断、duration 和 progress 格式化。

证据：`packages/coding-agent/src/interactive/tool-presentation.ts:44-156,307-323`。

因此不应在新状态行里再写一套容易漂移的 Tool 名称/参数格式器；更合理的 seam 是抽出一个 presentation-neutral 的“Tool 当前动作摘要”，让 Timeline 与活动行共同消费。

### 布局与动画已经有落点

当前全屏布局由一行 Header、Timeline viewport 和 bottom dock 组成。`ChatComponent.render()` 已统一计算 Editor、Attachments、drawer、footer 的 dock 高度和 cursor row；在 Editor 前插入一个活动行只需要把它纳入同一个 dock 几何计算。

证据：`packages/coding-agent/src/interactive/chat-component.ts:423-503`。

`@coda/tui` 已提供组件级 `animationInterval()` 和全局单一 animation scheduler。当前 Chat 只在 active Tool 且 motion 不是 reduced 时启动周期帧，所以如果状态要在“等待模型但尚无输出”时更新 elapsed time，这一条件需要扩展。Reduced motion 应关闭 spinner，而不是冻结 elapsed time。

证据：

- `packages/coding-agent/src/interactive/chat-component.ts:287-290`
- `packages/tui/src/tui.ts:544-567`

### 两个真实缺口

1. 用户提交后，`ChatComponent` 会乐观地把 `#running` 设为 true，但 `run_start` 之前还可能进行 extension reference 解析、Attachment 准备、Composer Submission 持久化和 Prompt 构建。这段只能显示 `Preparing`/`Starting`，除非 Input Queue Controller 额外提供细分活动。
2. `run_end` 事件把 Agent public state 先置为 `settling`，所有事件观察者完成后才转为 `idle`；但 `ChatComponent` 当前在收到 `run_end` 时就清除 `#running`。如果产品要求把慢 Session 持久化观察者也显示成 `Finishing`，需要增加一个 settle 完成通知或由 composition root 显式回调，不能只靠现有 `run_end`。

证据：

- `packages/coding-agent/src/interactive/chat-component.ts:765-880`
- `packages/agent/src/agent.ts:480-620`
- `packages/agent/src/reducer.ts:65-125`

## 竞品源码调研

### 1. OpenAI Codex：最接近目标几何

调研 commit：[`4c5fc230a9f35c24f863891e718e48377804ac9e`](https://github.com/openai/codex/tree/4c5fc230a9f35c24f863891e718e48377804ac9e)

Codex 的源码注释直接把组件定义为“agent busy 时渲染在 Composer 上方的 live task status row”，并说明这一行拥有 spinner timing、interrupt hint 和短 inline context；把这些内容放在一行是为了避免 bottom pane 的纵向布局频繁变化。[`status_indicator_widget.rs:1-5`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/status_indicator_widget.rs#L1-L5)

它的状态模型包含：

- 可更新的 header，默认 `Working`
- 可选 details，默认最多三行
- 可选 inline message
- elapsed timer
- interrupt binding/hint
- pause/resume timer

证据：[`status_indicator_widget.rs:35-198`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/status_indicator_widget.rs#L35-L198)。

渲染时，它把 activity indicator、header、elapsed、interrupt hint 和 optional context 放进同一行，并对宽度溢出做省略；details 只在有额外高度时出现。[`status_indicator_widget.rs:233-286`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/status_indicator_widget.rs#L233-L286)

BottomPane 在 task 从非运行转为运行时创建状态组件，在 task 完成时移除；布局顺序明确把状态行放在 Composer 之前。[`bottom_pane/mod.rs:1047-1074`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/bottom_pane/mod.rs#L1047-L1074) [`bottom_pane/mod.rs:1755-1805`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/bottom_pane/mod.rs#L1755-L1805)

Codex 还会在 modal 出现时暂停状态 timer、关闭 modal 后恢复。这表达的是“计时 Agent 工作时间，不把等待用户处理 modal 的时间算进去”。[`bottom_pane/mod.rs:1630-1642`](https://github.com/openai/codex/blob/4c5fc230a9f35c24f863891e718e48377804ac9e/codex-rs/tui/src/bottom_pane/mod.rs#L1630-L1642)

可借鉴：

- 几何位置与本需求完全一致；
- elapsed 和 interrupt affordance 是判断长等待的最低有效信息；
- status 生命周期属于 bottom pane，不污染聊天历史；
- 一行核心信息、额外详情有严格上限。

不应直接照搬：

- 单独的 `Working + Run 总耗时` 仍不足以回答“当前是在等模型还是跑命令”；
- Coda 已有更细的权威事件，应比 Codex 默认 header 提供更真实的阶段；
- Coda footer 已显示 Ctrl-C 语义，窄屏下重复 interrupt hint 可能挤掉更重要的活动内容。

### 2. Gemini CLI：最佳状态优先级

调研 commit：[`188e255bf55ebfb6b4f3a675c5b414eaef646ba2`](https://github.com/google-gemini/gemini-cli/tree/188e255bf55ebfb6b4f3a675c5b414eaef646ba2)

Gemini 的 UI 状态只有 `Idle | Responding | WaitingForConfirmation`，但 `LoadingIndicator` 组合了更多 presentation 输入：current loading phrase、thought summary、elapsed time、cancel/timer 开关、inline 模式、spinner icon 和 hook-active 状态。[`types.ts:49-54`](https://github.com/google-gemini/gemini-cli/blob/188e255bf55ebfb6b4f3a675c5b414eaef646ba2/packages/cli/src/ui/types.ts#L49-L54) [`LoadingIndicator.tsx:16-52`](https://github.com/google-gemini/gemini-cli/blob/188e255bf55ebfb6b4f3a675c5b414eaef646ba2/packages/cli/src/ui/components/LoadingIndicator.tsx#L16-L52)

它在 idle 且没有 phrase/thought 时不渲染。最重要的是，源码明确规定 interactive shell 的“等待用户输入”优先于 thought subject，因为这是可操作状态；其后才是 thought、current phrase 和兜底 `Thinking...`。Responding 时显示 `esc to cancel` 与 elapsed time。[`LoadingIndicator.tsx:54-88`](https://github.com/google-gemini/gemini-cli/blob/188e255bf55ebfb6b4f3a675c5b414eaef646ba2/packages/cli/src/ui/components/LoadingIndicator.tsx#L54-L88)

它同时支持 inline 与普通布局，并在窄终端把 timer/right content 降到后续行，而不是让主状态无限挤压。[`LoadingIndicator.tsx:90-178`](https://github.com/google-gemini/gemini-cli/blob/188e255bf55ebfb6b4f3a675c5b414eaef646ba2/packages/cli/src/ui/components/LoadingIndicator.tsx#L90-L178)

可借鉴：

- “等待用户动作”必须压过泛化 `Thinking`；否则 UI 会把人为阻塞误呈现成 Agent 卡住；
- 主状态、timer、辅助内容要有明确响应式优先级；
- thought summary 可以改善可读性，但它是说明文字，不是运行时真相。

### 3. Pi：最接近 Coda 的 TypeScript/TUI seam

原 `badlogic/pi-mono` 在调研时已重定向到 `earendil-works/pi`。调研 commit：[`2a9b4ebc680053c64e31f635b0b22d5e22564001`](https://github.com/earendil-works/pi/tree/2a9b4ebc680053c64e31f635b0b22d5e22564001)

Pi 定义了四种 status indicator：`working | retry | compaction | branchSummary`。Working 是通用 Loader；Retry 显示 attempt/max、倒计时和取消键；Compaction 与 branch summary 使用专用文案。所有 indicator 在 dispose 时停止 timer/spinner。[`status-indicator.ts:7-103`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/src/modes/interactive/components/status-indicator.ts#L7-L103)

Pi 的 fullscreen dock 顺序是 pending messages、status container、above-editor widgets、editor、below-editor widgets、footer，说明状态本身是独立于 Editor 的应用层组件。[`interactive-mode.ts:874-900`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L874-L900)

Agent start 时创建 Working indicator，Agent end 时清除；auto retry 切换为有倒计时的 Retry indicator；compaction/summary 也替换同一个 slot。[`interactive-mode.ts:3076-3100`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3076-L3100) [`interactive-mode.ts:3280-3385`](https://github.com/earendil-works/pi/blob/2a9b4ebc680053c64e31f635b0b22d5e22564001/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3280-L3385)

可借鉴：

- 对 Coda 现有 TypeScript 组件体系来说，独立 status slot 是低摩擦方案；
- retry/compaction 不能继续显示泛化 `Working`；
- timer、countdown、spinner 必须显式 dispose，防止空闲后继续 render。

不足：

- 默认 `Working...` 没有 elapsed，也不从 message/tool lifecycle 更新具体活动；
- 它更像“系统忙碌指示器”，还不是完整的“现在正在做什么”。

### 4. OpenCode：粗状态和独立状态副本的边界

调研 commit：[`0d927ba03f36d7f87e3cdb2b6c1f34c44913a099`](https://github.com/anomalyco/opencode/tree/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099)

OpenCode 的公开 Session status 是 `idle | busy | retry`。Retry 携带 attempt、message、next timestamp；busy 没有阶段或活动详情。[`session-status-event.ts:9-40`](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/schema/src/session-status-event.ts#L9-L40)

服务端另有一张 process-local `Map<SessionID, Info>`：idle 时从 map 删除，busy/retry 时写入，并单独发布 status 事件。[`session/status.ts:26-48`](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/opencode/src/session/status.ts#L26-L48)

TUI 在非 idle 时显示 spinner；retry 时额外显示截断后的错误、倒计时、attempt 和 interrupt 提示。普通 busy 状态基本只有 spinner，没有“正在做什么”。[`prompt/index.tsx:1513-1593`](https://github.com/anomalyco/opencode/blob/0d927ba03f36d7f87e3cdb2b6c1f34c44913a099/packages/tui/src/component/prompt/index.tsx#L1513-L1593)

可借鉴：

- retry 是一等状态，需要倒计时与错误摘要；
- reduced-animation 分支仍要留下静态活动符号。

不应照搬：

- `busy` 无法支持本需求；
- 单独维护 status map 需要额外证明它与真正 Run lifecycle 始终同步。对 Coda 而言这是没有必要的同步风险，因为权威 Agent 事件和 reducer state 已存在。这一点是从两套源码结构得到的架构推论，而不是 OpenCode 源码声称的 bug。

## 比较

| 项目 | Composer 邻近位置 | 活动粒度 | 时间信息 | 等待用户/重试 | 对 Coda 的主要价值 |
|---|---|---|---|---|---|
| Codex | Composer 上方独立 live row | 默认 Working，可更新 header/details | Run elapsed，可 pause/resume | interrupt hint；modal 时暂停 timer | 几何和核心信息密度最接近需求 |
| Gemini CLI | Loading indicator，可 inline/响应式换行 | thought/phrase/Thinking，明确优先级 | elapsed | 等待 shell 输入优先；cancel hint | 如何把“可操作状态”置顶 |
| Pi | Editor 上方独立 status container | working/retry/compaction/summary | retry countdown，无通用 elapsed | 专门 retry/compaction 状态 | 与 Coda 技术栈和组件 seam 最接近 |
| OpenCode | Prompt 下方状态区域 | idle/busy/retry | retry countdown | retry + interrupt | 说明 `busy` 太粗，独立状态副本有同步成本 |

## 推荐的 Coda 方案

### 第一版产品语义

状态行只陈述可验证事实，不宣判“卡住”。建议内容模型为：

```text
<activity glyph> <current phase/action> · <phase elapsed> [· no event <age>]
```

示例：

```text
● Waiting for model · 12s
● Thinking · 28s
● Running pnpm test · 1m 14s
● Calling mcp__server__tool · 18s · 40% (2/5)
◌ Waiting for approval — bash · 34s
↻ Retrying in 6s · attempt 2
```

`no event` 必须被描述为“没有新的 Agent 语义事件”，而不是“Agent 已卡住”。一个静默的模型请求或长时间无输出的子进程仍可能正常运行；spinner 也只证明 TUI animation scheduler 在刷新，不证明远端模型或子进程有进展。

### 状态投影

建议在 `@coda/coding-agent` 新建 presentation-owned、纯状态机式的 `ActivityProjection`（最终名称待设计），消费：

- `AgentEvent`
- Approval/MCP Elicitation 的 composition 状态
- `UserShellSnapshot`
- 必要时由 Input Queue Controller 提供的 pre-Run `Preparing` 和 post-Run `Settling` 信号

推荐优先级：

1. 等待用户操作：Approval、MCP Elicitation、interactive process input
2. retry/backoff
3. active Tool Invocation；并发时聚合数量并选一个主动作
4. message delta：Thinking、Responding、Preparing tool call
5. Attempt 已开始但尚无 delta：Waiting for model
6. Run 已接受但 Turn/Attempt 未开始：Preparing Run
7. Run 正在 settle：Finishing
8. idle：无活动状态

不要把模型生成的 commentary 当作主状态。它可能过时、缺失或不真实，尤其正是在模型卡住时。若以后要支持自然语言 goal/status，应作为经过截断的次要说明，并始终与确定性的 runtime phase 同屏。

### 模块边界

- `@coda/tui` 继续只提供通用布局、动画和清洗 primitive；它不应知道 Run、Turn 或 Tool Invocation。
- `@coda/coding-agent` 拥有活动状态语义，与 ADR-0033 的 Composer/application policy seam 一致。
- `ChatComponent` 负责把投影渲染在 Composer 邻近位置，并纳入 dock/cursor/viewport 几何。
- Tool action 摘要应从现有 `tool-presentation.ts` 抽取共享，避免 Timeline 与 status 文案漂移。
- 第一版不新增 Session Record；状态可以从已有事实恢复/投影，且恢复只发生在 idle Agent Seed 上。

### 响应式与无障碍

- 默认严格一行；活动、阶段时间的优先级高于 interrupt hint 和附加 subject。
- 对过长路径、命令和 MCP arguments 做 terminal sanitization、宽度截断；未知/敏感 Tool 默认只显示 Tool 名。
- reduced motion 使用静态 glyph，但仍每秒刷新 elapsed/countdown。
- NO_COLOR 下 glyph 和文字仍表达状态，不依赖颜色。
- `<40x10` 继续使用现有 too-small view，不启动活动动画。
- modal/Approval 展示时，不应同时显示误导性的 `Thinking`；应切换为 `Waiting for ...` 或让 modal 成为唯一活动表面。

### 验证重点

1. 纯 reducer 测试覆盖完整事件序列、retry、abort、failure、并发 Tool 和 out-of-order completion。
2. Chat 渲染测试覆盖 40 列、窄高终端、NO_COLOR、reduced motion、drawer/Attachment 与 cursor row。
3. fake clock 测试区分 phase elapsed、last semantic event age 和 retry countdown。
4. 确认 `run_end`、listener failure、User Shell completion 后 timer/animation 被清理。
5. PTY 测试确认状态出现/消失不会破坏 alternate buffer、输入焦点和 Ctrl-C。

## 需要产品决策的设计树根节点

以下问题不能仅靠源码事实决定，适合进入 grilling：

1. 产品承诺是“提供判断证据”，还是还要自动标记“疑似卡住”？
2. 主状态只来自 runtime 事实，还是允许 Assistant 自行描述当前目标？
3. 覆盖 Agent Run，还是覆盖所有会让用户等待的 Coda 操作？
4. 多 Session 下显示当前 Session，还是整个 Coda 进程的聚合活动？
5. 使用独立一行、Composer top border，还是可展开的多行详情？
6. Tool subject 显示到什么粒度，尤其是完整 command/path/MCP arguments？
7. 时间显示 Run elapsed、phase elapsed、last-event age 中的哪几个？
8. idle 时隐藏、保留空行、显示 Ready，还是短暂显示 Done？
9. 状态文案继续使用 Coda 当前英文 UI，还是开始支持中文/本地化？
