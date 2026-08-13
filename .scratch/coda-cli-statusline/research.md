# Coda CLI Composer 下方 Statusline 调研

调研日期：2026-08-12

## 调研问题与边界

目标是在 Coda CLI 的 Composer 输入框下方增加一条会话 statusline，候选信息包括当前 Model、Reasoning effort、剩余 Context、Workspace/工作目录、Provider 等。

本调研只使用 Coda 仓库源码、ADR、已实现规格，以及同类项目的官方文档或固定 commit 源码。文中把“已确认事实”和“设计推论”分开。产品访谈只保留“显示什么”和“如何显示”；数据流、状态所有权、刷新、配置与测试等实现细节由 Coda 自行决定。

## 执行摘要

1. Coda 已经拥有全部核心数据，但它们目前分散在两个 UI 位置：顶部 Header 常驻显示 Workspace basename、`provider/model` 和 Reasoning；Composer 下方 Footer 显示动态操作提示。新增 statusline 的首要视觉问题因此是信息迁移与底部提示的优先级，而不是能否取得数据。
2. Coda 的完整 Session 历史和模型可见 Context Window 明确分离。Context 经过 compaction 后必须按当前投影计算，不能用整段 Session token 累计量代替；切换 Model 后分母也必须随新的 `contextWindow` 改变。
3. OpenAI Codex 最接近目标几何：默认 statusline 仅有 `model-with-reasoning` 与 `current-dir`，使用紧凑单行、` · ` 分隔，并在退出提示、搜索、快捷键等行动信息出现时让位。
4. Gemini CLI 最值得借鉴响应式策略：路径先语义缩短，再按配置顺序丢弃放不下的整段，末尾用 `…` 表示省略；它同时提供两行带标签与单行无标签两种密度。
5. Claude Code 证明 Context、Model、目录、Git、成本等都适合 statusline，但它允许脚本任意输出多行/ANSI；这种开放性不是第一版必需条件。单行内建字段更可预测、更易测试。
6. 在核对的 Claude Code、Codex CLI、Gemini CLI 中，Provider 都不是内建 statusline 字段。Coda 如果常驻展示 Provider，是一项有意的产品差异；最紧凑的表达是与 Model 合为 `provider/model`，避免重复标签。
7. 推荐的默认视觉基线是单行 ambient status：`provider/model effort · Context N% left · ~/workspace`。Git branch 等是否加入默认集合属于产品内容决策；总 token、成本、版本、Session ID、API protocol 不宜默认堆入。

## Coda 当前实现

### 布局事实

`ChatComponent.render()` 当前按以下顺序组合全屏内容：

1. 一行 Header；
2. Timeline viewport；
3. command drawer；
4. Attachment rows；
5. Run active 时出现的一行 Activity status；
6. Composer Editor；
7. 一行 Footer。

证据：`packages/coding-agent/src/interactive/chat-component.ts:458-547`。

因此目标位置已经被现有 Footer 占用。这个 Footer 不是静态会话信息，而是上下文操作提示，例如：

- idle：`Enter sends • Ctrl-T transcript • Ctrl-C twice exits`
- Run active：`Enter steers • Alt+Enter queues Follow-up • ...`
- User Shell、paused queue、Transcript、Attachment、unread update 等状态各有专用提示

证据：`packages/coding-agent/src/interactive/chat-component.ts:1407-1458`。

顶部 Header 当前已经显示：

- `Coda`；
- Workspace label；
- `provider/model`；
- `reasoning <level>`；
- Transcript mode 时额外显示 `Transcript`。

它按尾部逐项删除的方式适配窄屏。证据：`packages/coding-agent/src/interactive/chat-component.ts:1727-1756`；窄屏测试：`packages/coding-agent/test/chat-component.test.ts:330-339`。

Run Activity status 是另一种信息：它只在工作时出现在 Composer 上方，显示 Provider summary、`Working...`、等待批准、retry、elapsed 等，idle 时消失。它不应和 ambient statusline 合并为一个含混的状态概念。证据：`packages/coding-agent/src/interactive/chat-component.ts:295-316,491-544`；规格：`.scratch/cli-activity-status/spec.md`。

### Model、Provider 与 Reasoning

`Model` 本身包含稳定的 `id`、`name`、`provider`、`api`、`reasoning`、`contextWindow` 与 `maxTokens`。证据：`packages/ai/src/types.ts:512-535`。

每个 interactive Session 已把 `modelLabel` 和 `reasoning` 传给 `ChatComponent`；`modelLabel` 的实际格式是 `${provider}/${id}`。`/model` 切换后，组件会在不重建 Composer 的情况下更新这两个值。证据：

- `packages/coding-agent/src/interactive/chat-component.ts:69-73,222-275`
- `packages/coding-agent/src/application.ts:2107-2153`
- `packages/coding-agent/test/chat-component.test.ts:127-135`

Provider 因而不需要从显示字符串反向解析；运行时已经保有结构化 Model。Reasoning 显示的是经过 Model capability 映射后的有效值，而不是用户请求但 Model 不支持的原始值。证据：`packages/coding-agent/src/application.ts:561-574`。

### Workspace 与“工作目录”

Coda 的领域术语是 **Workspace**：它是 Session、项目上下文和默认 Tool authority 的 canonical filesystem root，不等同于任意进程当前目录。见 `CONTEXT.md` 的 Workspace 定义。

交互式 Agent、User Shell 和内建 Tools 当前都以 Workspace root 作为工作目录。现有 Header 只接收 `basename(workspace.root)`，但 composition root 同时持有完整 canonical path。证据：

- `packages/coding-agent/src/application.ts:2094-2111`
- `packages/coding-agent/src/interactive/run-interactive.ts:105-125,215-224`

所以 statusline 若显示“cwd”，第一版的真实语义应是 Workspace path；显示全路径、`~` 缩写路径还是 basename 是视觉样式决策。

### Context remaining 的权威语义

Assistant Message 已保存 Provider-normalized Usage：input、output、cache read/write、reasoning 和 total tokens。证据：`packages/ai/src/types.ts:287-295`。

`@coda/ai` 已有 Context estimate：优先采用最近一次成功 Assistant Usage 作为权威前缀，再估算其后的 trailing Messages 与新增 Tool schema；没有 Usage 时才对完整 Context 做估算。证据：`packages/ai/src/utils/estimate.ts:82-150`。

但 Coda 的模型可见 Context Window 由 `ContextWindowController` 投影：

- 没有 checkpoint 时使用完整 Agent Messages；
- compaction 后使用 checkpoint replacement history 加 checkpoint 后的新 Messages；
- Auto-Compaction 也是对这个投影估算，而不是对完整 Session 历史估算。

证据：`packages/coding-agent/src/context-window/context-window.ts:76-120,170-241`；ADR：`docs/adr/0038-compact-context-windows-with-durable-checkpoints.md`。

因此 statusline 的“Context remaining”必须满足：

- 分子来自当前模型可见投影，包含 System Prompt、Tools、Messages 与必要的 reserved output 语义；
- 分母来自当前选中 Model 的 `contextWindow`；
- compaction 成功后立即切到新投影；
- Model 切换后立即换分母并重新估算；
- 若某个 Provider 的精确 Usage 尚不可用，UI 必须保留“估算/未知”的诚实语义，不能把累计 Session tokens 冒充当前 Context。

这是由现有领域边界导出的实现约束，不需要用户决定。

### 已有主题与可访问性

Coda Theme 已提供 muted、accent、warning、error 等语义 tone；Reasoning 还映射到 Editor border 色。NO_COLOR/ColorLevel 0 会完全移除 SGR，现有 too-small view 在 `<40x10` 时替代复杂布局。证据：

- `packages/coding-agent/src/interactive/theme.ts:1-14,63-82,103-139`
- `packages/coding-agent/src/interactive/chat-component.ts:458-460,1759-1767`

因此颜色只能增强含义，不能成为唯一编码；窄屏、CJK grapheme、NO_COLOR 都必须保留可读文本。

## 同类产品一手调研

### OpenAI Codex CLI

调研 commit：[`2230d64464488d8847197722fdca09d90095c705`](https://github.com/openai/codex/tree/2230d64464488d8847197722fdca09d90095c705)

已确认事实：

- 默认 statusline 只有 `model-with-reasoning` 与 `current-dir`。[源码](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/chatwidget.rs#L486-L493)
- `/statusline` picker 可选择、排序和预览 Model、Reasoning、cwd/project、Git、run state、Permissions、Approval、Context used/remaining/window、rate limits、tokens、Session、version、thread/task 等字段。[官方文档](https://developers.openai.com/codex/cli/slash-commands/#configure-footer-items-with-statusline)；[字段枚举](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/bottom_pane/status_line_setup.rs#L43-L197)
- 字段按配置顺序用 dimmed ` · ` 分隔；可使用主题语义色，也可统一退为 dim 文本。[样式源码](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/bottom_pane/status_line_style.rs#L12-L123)
- 不可用的段直接省略。Context 文案为 `Context N% left` 或 `Context N% used`。[取值源码](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/chatwidget/status_surfaces.rs#L646-L752)
- statusline 是 ambient 信息：Composer idle 或有非运行中草稿时可显示；历史搜索、退出提醒、快捷键 overlay、Esc hint 等行动提示覆盖它。[Footer 优先级](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/bottom_pane/footer.rs#L766-L816)
- 窄屏做 display-width/grapheme-safe 尾部截断；字段顺序也决定保留优先级。[截断源码](https://github.com/openai/codex/blob/2230d64464488d8847197722fdca09d90095c705/codex-rs/tui/src/line_truncation.rs#L13-L101)

设计启示：几何、默认密度和行动提示优先级最贴近 Coda；但整行尾截断不如 Gemini 的逐段降级清楚。

### Claude Code

官方文档：[`Customize your status line`](https://code.claude.com/docs/en/statusline)

已确认事实：

- statusline 是 command hook：Session JSON 经 stdin 传入，本地脚本 stdout 被渲染；支持单行、多行、ANSI 与 OSC 8。
- 官方数据包括 Model、Reasoning effort、cwd/project/repo、Context used/remaining/size、rate limits、cost/duration、Session、version、Vim/agent/PR 等；schema 没有独立 Provider 字段。
- 典型更新由 Assistant message、`/compact`、Permission/Vim 变化等事件触发，300ms debounce；可选定时刷新。
- autocomplete、help、permission prompt 等交互会暂时隐藏 statusline；窄终端下系统通知可能挤压它，官方建议保持短小。
- 官方 Troubleshooting 明确提示复杂 ANSI 和多行输出更容易产生渲染问题，单行纯文本最稳健。

设计启示：丰富字段与扩展性很有价值，但第一版不需要以任意脚本输出来承担安全、延迟、缓存和布局复杂度。

### Gemini CLI

调研 commit：[`5024443c7217464a66e98f80d73172a26440bd8f`](https://github.com/google-gemini/gemini-cli/tree/5024443c7217464a66e98f80d73172a26440bd8f)

已确认事实：

- 可选字段为 workspace、Git branch、sandbox、Model、Context used、quota、memory、Session ID、hostname、auth、diff、token count；没有 Reasoning 或 Provider。[字段源码](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/config/footerItems.ts#L9-L87)
- 默认兼容集合是 workspace、Git branch、sandbox、Model、quota。[默认解析](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/config/footerItems.ts#L89-L124)
- 默认样式是两行栏目：上行 label，下行 value；`showLabels=false` 后变为以 ` · ` 分隔的紧凑单行。[FooterRow](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/ui/components/Footer.tsx#L103-L165)
- 宽度算法先为 Workspace 提供可缩短空间，其他字段按顺序尝试；放不下的字段被跳过，后面的短字段仍可能保留；一旦丢项，末尾显示 `…`。[宽度策略](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/ui/components/Footer.tsx#L476-L542)
- Context 在窄屏从 `N% used` 缩成 `N%`，接近压缩/满载阈值时才切 warning/error 色；Sandbox 同时使用明确文字与颜色。[Context component](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/ui/components/ContextUsageDisplay.tsx#L16-L48)；[Sandbox](https://github.com/google-gemini/gemini-cli/blob/5024443c7217464a66e98f80d73172a26440bd8f/packages/cli/src/ui/components/Footer.tsx#L68-L91)

设计启示：逐字段缩写/省略和明确的 `…` 比无差别切断整行更可解释；两行标签风格可读但持续占用更多 Timeline 高度。

### Pi Coding Agent

调研 commit：[`534bcbffb7e1e7551d9ee3572dfeb278e203e493`](https://github.com/earendil-works/pi/tree/534bcbffb7e1e7551d9ee3572dfeb278e203e493)

已确认事实：

- Footer 默认两行：第一行是 `~` 缩写 cwd，加 Git branch 与可选 Session name；第二行左侧为 input/output/cache/cost/context，右侧为 Model + thinking level。
- Provider 只在可用 Provider 数量大于 1 且宽度足够时加在 Model 前；不足时先删 Provider，再截断 Model。
- Context 显示 used percent / total window，70% 以上 warning、90% 以上 error；compaction 后如果没有新的可信 Assistant Usage，会显示未知而不是继续展示旧百分比。
- 所有行使用 display-width-aware 截断并保持在 terminal width 内。

证据：[Footer 源码](https://github.com/earendil-works/pi/blob/534bcbffb7e1e7551d9ee3572dfeb278e203e493/packages/coding-agent/src/modes/interactive/components/footer.ts#L84-L243)；[宽度测试](https://github.com/earendil-works/pi/blob/534bcbffb7e1e7551d9ee3572dfeb278e203e493/packages/coding-agent/test/footer-width.test.ts#L115-L153)。

设计启示：Provider 条件显示与 Context unknown 语义值得借鉴；两行高信息密度适合 diagnostics，但不符合 Coda 当前尽量把 Timeline 高度留给对话的方向。

### Zellij 与 tmux：通用终端响应式参考

- Zellij status bar 依据高度选择一行/两行，内容降级链是 full → short → key-only → empty；瞬态提示优先于 ambient 提示。[Zellij status bar](https://github.com/zellij-org/zellij/blob/c428ae93b9f21fc79f89b4377b3f561ec66cda7d/default-plugins/status-bar/src/main.rs#L334-L410)
- tmux 把 status line 明确分成 left / window list / right，并给各区独立宽度预算；字段支持从头或尾语义裁切。[tmux options](https://github.com/tmux/tmux/blob/851c5a933d4838c32ad06c248b2ba975d106149c/options-table.c#L1016-L1122)；[format clipping](https://github.com/tmux/tmux/blob/851c5a933d4838c32ad06c248b2ba975d106149c/tmux.1#L6930-L6955)

设计启示：若选择左右分区，必须把它视为真正的两区布局；不能只靠插入大量空格模拟。无论哪种布局，都应为每个字段定义完整、短、最短、隐藏的降级表示。

## 交叉比较

| 项目 | 默认密度 | Model / Reasoning | Context | cwd / Git | Provider | 窄屏策略 |
|---|---|---|---|---|---|---|
| Coda 当前 Header | 单行 | `provider/model` + reasoning | 无 | Workspace basename | 与 Model 合并 | 从尾部删字段 |
| OpenAI Codex | 单行 | 合并 | used/remaining 可选 | cwd 默认，Git 可选 | 无 | 整行尾截断 |
| Claude Code | 用户决定 | 都可 | used/remaining/tokens | 都可 | schema 无 | 脚本负责，UI 可能截断 |
| Gemini CLI | 默认两行，可单行 | Model，无 reasoning | used | workspace/Git | 无 | 内部缩短 + 跳过整段 + `…` |
| Pi | 两行 | Model + thinking | used% / window | cwd + Git | 多 Provider 且够宽时 | 左右分区逐级降级 |

## 已收敛的实现原则

以下不是需要用户回答的问题：

1. Statusline 是 application-owned ambient presentation；`@coda/tui` 继续只提供通用宽度、布局和 ANSI primitive。
2. 数据来自每个 focused Session 的结构化 runtime，不从 Header 文本或 Session JSONL 反向解析。
3. Context 使用当前 Model-visible projection，兼容 compaction 和 Model switch，并对估算/未知保持诚实。
4. 行动信息（错误、搜索、退出确认、queue 操作等）高于 ambient statusline。
5. 所有字段必须 terminal-sanitize、grapheme/display-width safe；NO_COLOR 与 reduced/too-small 分支继续有效。
6. 不把任意外部 command hook 作为第一版前提；配置入口和持久化形式由实现设计决定。

## 进入 grilling 的展示决策树

第一轮根节点：

1. 默认显示字段集合：最小、平衡或 diagnostics；Git 是否默认加入。
2. 单行无标签还是两行带标签。
3. Model、Provider、Reasoning 是合并为一个 identity segment，还是拆成多个字段；用稳定 ID 还是 display name。
4. Context 显示 remaining / used / 两者，以及 percent / tokens / bar。
5. Workspace path 显示完整路径、`~` 缩写、语义缩短路径或 basename。
6. UI 语言、分隔符与符号密度。

这些节点确定后才可继续询问：左右对齐、Header 是否去重、行动提示覆盖方式、颜色/阈值、字段顺序、窄屏保留优先级、未知值样式。它们全部属于“显示内容或内容样式”，不涉及实现授权。
