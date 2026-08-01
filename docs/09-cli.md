[← 返回地图](./README.md)

# 09 CLI / TUI:交互模式、流式渲染、键位与 headless JSON 模式

CLI 是整个系统里**最薄**的一层：运行期把用户输入翻译成带
`WorkspaceId/ThreadId/OpId` 的 `RuntimeOp`，只经 `RuntimePort.submit()` 提交；把
`EventEnvelope<RuntimeEvent>` 投影成终端像素。参数、凭据来源、前端模式与显示策略属于 CLI，
active-run/mailbox/retry/compaction/control/policy 状态机都属于 Runtime。

> **阶段 0 基线说明**：本文件以 [12 Supervisor Runtime](./12-supervisor-runtime.md) 为上位契约。
> 阶段 0 保留现有 CLI → `Session` 与裸 `SessionEvent` 行为作为 characterization baseline；阶段 1
> 起 production CLI 只依赖无副作用 public runtime entry。默认 `--json` 保持 legacy 裸事件，显式
> `--event-format=envelope` 使用 canonical identity/envelope 协议。

> **UX4 已完成（2026-08-01，恰好两轮完整 review）**：六条用户旅程、surface parity、presentation state、环境与性能
> 契约以 [13 CLI / TUI 产品体验契约](./13-cli-ux.md) 为准。统一 command catalog、薄
> bootstrap/help/version/completion、产品子命令、`--ui`、最低 accessible/plain 文本面、共享
> terminal sanitizer 与 classic 多行/光标/paste 已落地；UX2 的紧凑任务栏、palette、composer、
> per-thread presentation state 与 transcript 导航已完成恰好两轮 review。UX3 已实现 Runtime-backed
> review/diff、approval card、session switch、manual compact 与 conversation fork/retry，并已完成恰好
> 两轮完整 review；第二轮修复了 allow-always 可用性、seed turn provenance 与 tool update snapshot
> 聚合，随后仅运行定向验证。UX4 已实现 accessible ASCII、四套显式主题、按帧 delta 合并、长历史
> 分段加载、opt-in one-shot automation output 与完整真实 PTY 退出矩阵，并已完成恰好两轮完整 review。
> 第一轮修复终态/timeout 竞态、跨 segment 最新 plan、tool anchor identity 与真实 termios 证据；第二轮
> 修复 broken-pipe run 收束与重复 toolCallId 的确定 occurrence anchor，随后只运行定向验证。

## 0. 产品 surface 与事实来源

CLI 产品化阶段不改变“CLI 是最薄的一层”：会话、run、approval、usage、queue、model 与权限只来自
`RuntimePort` snapshot/query 和 `EventEnvelope`。draft、滚动锚点、未读位置、搜索、主题和打开的 panel
是允许单独持久化的 presentation state，但不得被当作 Runtime 事实。切换 thread 只切换前端 attachment，
不 abort/close 后台 run。滚动锚点必须使用 snapshot 中可恢复的 message/part/tool stable key，不能只存
envelope seq：v1 snapshot-only 历史没有对应历史 envelope；seq 只用于 live unread high-water。
尚无 thread 时，TUI permission mode 来自 `RuntimePort.getWorkspaceSnapshot()` 的冻结 permissions；
CLI `approvalMode` 只进入注入的 permission policy/approval adapter，不直接进入 view options。

UX1 的 help、completion、错误建议和 CLI 子命令与 UX2 的 categorized fuzzy palette、slash/text
commands、参数提示和快捷键都由同一个 command catalog 生成。TUI/classic/accessibility 共享
per-thread presentation state 与 presentation-only actions。UX3 的 diff、session 与 approval UI
只展示 Runtime 提交进 snapshot/envelope 的权威 identity/resource/scope。由同一
`PreparedInvocation`/`PolicyDecision` 生成的 JSON-safe
`ApprovalPresentation` 纳入 canonical event/snapshot；UI 不得直接读取 capability/policy internals，也不得
从命令字符串或自由文本自行推导权限。工作区 diff 同样必须经新增的 RuntimePort read-only query，底层
Git adapter 不能直接暴露给 CLI/UI。

## 1. 交互形态:Bun + `@opentui/core`

### 1.1 模式分派与依赖边界

双 TTY 的默认交互面是 `@opentui/core` 0.4.x 全屏 TUI。OpenTUI 只在确认进入该分支后动态导入,所以脚本路径不加载 native 包:

| 条件 | 前端 |
|---|---|
| `--json` | `startHeadless()`;stdin/stdout NDJSON |
| `--output=text|json|stream-json` 或 `--final-only/--ephemeral/--timeout` | `startOneShotOutput()`；必须有 one-shot prompt，显式 opt in |
| `-p`、裸 prompt、非 TTY stdin | plain `Renderer`;跑完退出 |
| `--ui=auto`，双 TTY 且 `TERM != dumb` | `startTui()`;alternate screen |
| `--ui=auto`，`TERM=dumb` 或 stdout 非 TTY | accessible append-only line REPL |
| `--ui=tui` | 只允许完整双 TTY/非 dumb；初始化失败明确退出，不换面 |
| `--ui=classic` | 显式 readline/raw TTY + ANSI 动态区 |
| `--ui=accessible` / `--ui=plain` | stdin TTY 上的 append-only 文本面，无 raw/alternate screen/鼠标/动画 |
| auto 中 OpenTUI 初始化失败 | 完整清理 OpenTUI 后降级 classic |

OpenTUI 与 classic REPL 不能同时存在:二者都会接管 raw stdin/stdout。`main.ts` 因此必须在创建 stdout FileSink/legacy renderer **之前**选择 TUI。没有遗留布尔 `--classic` 开关；统一使用 `--ui=classic`。auto 初始化失败时先完整销毁 OpenTUI，再自动进入 classic。二者共用 `ProviderCommandController`，所以没有 API key 或模型也能在任一交互面完成 `/login` → `/model`。生产构建保持 `Bun.build({ packages: 'external' })`;运行时安装当前平台的 OpenTUI optional native package。`--json`、`-p` 和管道协议不因 TUI 发生任何变化。

`dist/main.js` 是一个只静态引用 `command-catalog`/终端清洗与 build metadata 的薄 bootstrap。
`-h/--help`、`-V/--version`、completion 和 usage error 在 dynamic import `main` chunk 之前收束，
所以不读配置、不创建目录、不注册 signal、不加载 provider/OpenTUI 且不联网。这个边界由
`e2e/product-cli.test.ts` 对构建产物作进程级验证。

### 1.2 全屏布局与顶部起排不变量

TUI 进入 alternate screen，组件树固定为:

```text
root column (100% × 100%)
├── header:首次显示版本 + Unicode 像素 Logo + tips；交互后收缩为紧凑任务栏
├── transcript / diff viewer / session picker:同一可恢复内容区
└── composer
    ├── approval card:默认摘要，`v` 展开 Runtime-authoritative scope
    ├── candidate menu:categorized fuzzy slash/provider/@path 候选
    ├── prompt:top rule + auto-growing transparent Textarea + bottom rule
    ├── task:phase/thread/permissions/queue/unread/Vim
    ├── workspace
    └── context usage                         provider/model
```

- **header**:从 `package.json.version` 取当前版本；Logo 是 ImageGen 参考图
  `assets/branding/coda-pixel-logo-reference.png` 的 6 行 Unicode block 复刻，运行时不读 PNG、不依赖终端
  图片协议。首次输入非空 draft、提交消息或恢复已有 draft/thread 后，9 行 onboarding header 永久收缩为
  3 行紧凑任务栏；resize 不会把已完成 onboarding 的 Logo/tips 重新弹回。低于 10 行时连紧凑 header
  也隐藏。header、brand、Logo 与 tips 都不绘制背景色，直接透出终端背景。
- **transcript / panels**:assistant Markdown、user/steering/follow-up、工具进度、diff、plan 与告警按事件顺序向下排列。关键配置是 `contentOptions.flexDirection:'column'`、`justifyContent:'flex-start'`、`minHeight:'auto'`;禁止 `column-reverse` / `flex-end`。短内容从中区第一行向下增长,不是 pi 风格从 prompt 上方向上堆。`stickyScroll:true, stickyStart:'bottom'` 只在内容溢出后跟随尾部；PageUp 或鼠标滚轮上滚后暂停跟尾，按 stable message/tool anchor 保存位置并累计 `N new`。PageDown 回到底部、`End` 或 `/latest` 才清 unread。`/search`、`/next`、`/previous` 定位匹配项但不移动 composer 焦点。`/diff` 把同一区域切到完整 Runtime diff viewer，支持 `←/→` 换文件、`↑/↓` 滚动、`Tab` 切 turn/workspace、`Esc` 返回；`/sessions` 打开 searchable picker，搜索始终针对完整 catalog，不在已过滤子集上二次过滤。
- **composer**:固定在屏幕底部。输入区是透明 Textarea,只绘制洋红色 single top/bottom rule,没有左右边、角、title、bottomTitle 或 idle placeholder；Textarea 聚焦、可见且不在审批状态时,使用 OpenTUI 原生硬件光标显示固定高对比品牌红色、持续闪烁的竖线。renderer 的全局鼠标自动聚焦保持关闭,将组件焦点策略明确收敛在输入框；Textarea 自己响应鼠标按下,组件失焦时原生光标隐藏,点击输入区可重新聚焦。终端窗口失焦不改变 Textarea 的逻辑焦点,由终端模拟器把仍可见的原生竖线显示成 inactive/hollow rectangle；切回终端后自然恢复竖线并可直接继续输入。空输入默认只显示 1 行,显式换行或按当前宽度产生软换行时自动增高,内容缩短或终端变宽时自动缩回；空间允许时最多显示 8 行并把超出内容交给 Textarea 内部滚动。布局优先为 transcript 保留至少 1 行真实内容；有空间时连同上下 padding 共保留 3 行,不能让长 draft 吞掉全部模型输出。working/retrying/compacting 与双击退出提示只在输入为空时借单行 placeholder 显示。审批是例外：prompt 横线变黄，composer 上方显示默认折叠卡片，workspace 行始终可见 `Approval … v/y/a/n/Esc`；`v` 只展开 Runtime-authored capability/resource/risk/scope/revision，legacy scope 缺失时明确 unavailable。即使已有 draft 也不能隐藏键位；draft 冻结且编辑光标隐藏,决议后原样恢复 workspace、draft 与光标。正常状态下 prompt 下方严格三行：task 行持续显示 phase、thread、permissions、queue、unread 与可选 Vim mode；workspace 行显示 cwd 与 Git `branch*`；runtime 行左侧显示 `usage.contextTokens`、右侧显示当前 `ModelRef`。这些状态不因 draft 非空而消失。冷启动没有模型时右侧明确显示 `no model selected`。只有 `ModelConfig.limits.context` 明确存在时才显示百分比；缺上限显示 `limit unknown`，不得按模型名猜窗口大小。
- **candidate menu**:slash 命令、provider 枚举和 `@` path completion 复用 prompt 正上方的同一个透明候选层。slash 项显示 `[category] /name <argument>`、首个快捷键、说明和 disabled 原因；name/alias 的 exact/prefix/substring/subsequence 优先于 description/category 的模糊命中。可执行性统一由 phase、approval、provider prompt、provider availability、model、transcript 与 stash 状态计算；不可执行项保留以解释原因，provider 自由/秘密输入与审批状态则隐藏无关命令。`Ctrl+K` 从任意普通 draft 打开 palette，`Esc` 恢复原 draft。兼容别名 `/f`、`/q`、`/prev` 继续可输入但不重复占候选行。`↑`/`↓` 循环，`Tab` 采用但不发送，`Enter` 采用后执行；`@query` 的 Tab 插入当前 workspace 相对路径。运行中 read-only/presentation 命令仍可执行，provider 管理命令明确 disabled，普通文本 Enter 继续是 steering。
- **provider 候选**:`/login` 的 preset、Custom 协议、`/model` 模型、`/logout` provider 都由共用状态机把结构化 `value/label/description` 交给同一 candidate menu；空输入显示候选，输入文本可按 label/value/description 大小写无关过滤，`↑`/`↓` 循环选择，`Enter` 直接确认当前项，不要求输入数字。`Tab` 不确认 provider 选项；`Esc` 静默回到上一步，例如 Custom 协议回到 API key、Custom name 回到 preset。离开秘密步骤时必须先清空 UI 秘密缓冲；协议步骤中已经暂存在 controller 的 key 也要在回退时清空。到达 `/login`、`/model` 或 `/logout` 的根步骤后再按 `Esc` 才静默退出流程，不打印“已取消”。秘密输入和 name/base URL 等自由文本步骤不显示候选。审批期间所有候选隐藏。
- **候选布局**:候选占用 composer 上方空间，一次最多显示 8 项；项目更多或空间不足时围绕当前项裁切，同时仍优先保留 1 行输入与可用时 1 行 transcript。
- **响应式**:窄屏先隐藏 tips,再隐藏 Logo和右侧 model；状态 placeholder 与审批 footer 切换为紧凑文案。resize 必须按新宽度重新测量软换行并同步 prompt/composer 高度。低于 10 行进入 ultra-compact:隐藏 header,随后按可用高度依次移除 transcript padding、transcript、runtime、workspace 与一条/两条 prompt rule；普通输入的光标始终留在 viewport 内,审批时则优先保留审批 footer,必要时隐藏输入和光标。
- **主题**:`--theme=auto|light|dark|high-contrast|mono` 由统一 option catalog 提供；OpenTUI 为前四者选择明确 palette，`mono` 与 `NO_COLOR` / `--no-color` 都移除语义色。状态同时保留 `done`、`aborted`、`fatal`、`warning`、`running` 等文字/符号，不能只靠颜色。整个 TUI 的 native framebuffer 与视图树背景都固定为 `RGBA(0,0,0,0)`。页面、header、ScrollBox 的 root/wrapper/viewport/content、动态转录、Markdown、composer、Textarea 普通/聚焦态和三行 footer 都必须显式保持 alpha 0,不能由任何子层重新画出实色块。OpenTUI 0.4.5 的运行时构造器尚不读取 `backgroundColor` 配置,所以生产初始化除传入透明配置外,还必须无条件调用 `renderer.setBackgroundColor(...)` 同步 native framebuffer；该行为不受主题或 color flag 控制。ANSI 终端没有逐单元格 alpha 协议,这里的“透明”表示输出 SGR 49、使用终端 profile 的默认背景；若终端窗口本身启用了透明效果即可透出桌面,否则仍显示该 profile 的背景色,alternate screen 也不会透出先前 shell 的字符。正文与输入文字使用终端默认前景色；硬件光标固定使用 `#c94740`,因为 OpenTUI 0.4.5 的 native cursor 路径忽略 default intent,否则会在白色背景上退化成不可见的 `#ffffff`。

OpenTUI 是这一分支的唯一终端写入者和键盘焦点管理者。`exitOnCtrlC:false`、`exitSignals:[]` 让 CLI 在销毁 alternate screen 前先提交目标 thread 的 `abort`、等待 control/权威提交收束并调用 `RuntimePort.close()`；阶段 0 legacy 路径等价执行 `approval.onAbort → Session.close()`。`destroy()` 恢复 raw mode、鼠标与主屏。`NO_COLOR` / `--no-color` 禁用 coda 的内容与边框语义色,但保留用于焦点可见性的硬件光标色,且不改变布局和键位。

所有来自模型、工具、仓库、配置与持久化会话的文本都按不可信终端输入处理。OpenTUI、classic、accessible、plain、产品子命令与 human stderr 共用 `terminal-sanitize.ts`：进入 Text/Markdown、状态栏、工具摘要、diff 或 transcript 前剥离 ANSI CSI/OSC/DCS/APC/PM/SOS 序列，移除除 `\t` / `\n` 外的 C0 与全部 C1 控制字符。终端标题再经过 `sanitizeTerminalTitle` 把 tab/newline 折成单行；不得依赖组件转义来阻止 OSC 52、标题注入或隐藏控制字符。headless JSON 为保持 wire 兼容不删改 payload，只依赖 JSON escaping 并确保日志不泄密。

### 1.3 classic / plain 保底

`renderer.ts` 与 `repl.ts` 是受支持的 classic 面：readline/raw TTY compatibility + ANSI 动态区。
composer 使用 grapheme 边界移动/删除 CJK 和 ZWJ emoji，`Shift+Enter` 插入换行，多行上下保持
grapheme 列，最多窗口化显示 8 行；bracketed paste 的整块与分段 marker 都不触发发送。
classic 与 TUI 共用 `ProviderCommandController`、`provider-actions`、presentation actions 和统一 command
catalog；候选以编号/名称接受。classic 支持 Ctrl+R、Ctrl+O、stash/restore、`@` Tab、copy/export 与
可选 Vim，恢复同一 `(workspaceId, threadId)` draft。秘密步骤只把等长 `•` 掩码交给 renderer，且不调用
history/presentation API。

`line-repl.ts` 是 accessible/plain 的最低交互面：只读完整行、append-only，不开 raw mode、
alternate screen、bracketed-paste mode、鼠标或动画。它以文本命令提供 prompt/steer/follow-up/
abort/approval/status/queue/model/logout 以及 `/history`、`/edit`、`/files`、`/stash`、`/restore`、
`/draft`、`/search`、`/next`、`/previous`、`/latest`、`/copy`、`/export`、`/vim`，以及 UX3 的
`/review`、`/diff`、`/permissions`、`/compact`、`/new`、`/sessions`、`/resume`、`/switch`、
`/rename`、`/archive`、`/retry`、`/fork` parity；`/login`
明确引导到受保护的 `coda auth login`。输出
失败会 abort 当前 run、关闭 Runtime 并返回 1。classic 和文本面的真实 key 都不进入历史、
transcript、event、journal 或日志。
`TERM=dumb` 的 accessible 自动启用 ASCII 产品 chrome；其他文本面可显式传 `--ascii`。该转换只替换
coda 自己的 rule/spinner/status/tool/plan glyph，用户、模型和工具 payload 中的 CJK/emoji 原样保留。
append-only renderer 的欢迎/命令输出先完成 stdout drain，再把下一条 `> ` prompt 写到 stderr；不得让
提示符越过它所解释的 onboarding 或多行命令结果。

## 2. 启动流程与会话选择

```
coda                    # 新会话
coda -p "..."           # 一次性:发送 prompt,跑完以 plain 输出退出
coda --continue         # 恢复最近一个会话
coda --resume [legacy-id] # 无 id 时列出全局兼容 catalog；空格形式保留旧 id 形状判定
coda --resume=<thread-id> # 避免 prompt parser 歧义；跨 workspace 重名时仍要求 --workspace
coda --workspace=<workspace-id> --resume=<thread-id> # 全局 catalog 中的无歧义 canonical locator
coda --json             # headless JSON 模式(第 6 节)
coda --provider openai-responses  # 使用 OpenAI Responses adapter
```

产品命令同样来自 `src/cli/command-catalog.ts`：

```text
coda -h | --help
coda -V | --version
coda doctor [--json]
coda completion <bash|zsh|fish|powershell>
coda auth login|logout|status
coda models [--select <provider/model>] [--json]
coda sessions [--cwd <path>] [--workspace <id>] [--json]
coda exec [现有 flags] [prompt]
```

`exec` 只是现有 one-shot 解析和执行路径的显式动作名；去掉首个 `exec` token 后，flags、裸 prompt、
pipe、continue/resume、stdout/stderr、退出码与 legacy wire 不变。`help`、`version`、`doctor`、
`completion`、`auth`、`models`、`sessions` 和 `exec` 位于 argv 首项时是保留动作名；要把这些单词作为
任务正文，使用 `coda exec …` 或 `coda -p …`。

`--provider` 的内置值为 `openai-chat | openai-responses | anthropic-messages | faux`。两个 OpenAI
值都读取 OpenAI key，但产生不同的 `ModelRef.api` 并分发到不同 `StreamFn`；CLI 不读取或转换
任何 Responses wire 事件。

旧式 flags/env/config 仍作为显式非交互配置入口；交互主路径另读认证/模型配置。目标启动组装顺序
如下（public runtime import 本身零副作用，只有显式工厂与 op 才开始 IO）：

```ts
const interactive = stdin.isTTY && !flags.json && flags.prompt === undefined;
const cliConfig = resolveCliConfig(flags, env, readConfigFile(), {
  allowMissingModel: interactive || (flags.json && flags.eventFormat === 'envelope'),
});
const providerRegistry = interactive || cliConfig.model === undefined
  ? new ProviderRegistry()
  : undefined;
const storageRoots = resolveRuntimeStorageRoots({
  homeDir: resolveHomeDirectory(env),           // 只有 CLI composition root 读取 env/home
  legacySessionDir: flags.sessionDir,
});
const storage = createFileRuntimeStorage({
  root: storageRoots.runtimeRoot,
  legacySessionDir: storageRoots.legacySessionDir,
  legacyApprovalFile: defaultRulesFile(),
});
const resumeTarget = isResumeRequest(flags)
  ? await selectCliResumeTarget(await storage.listStoredThreads(), flags)
  : undefined;
if (isResumeRequest(flags) && !resumeTarget) exitNoSessionToResume();
const runtimeCwd = resumeTarget?.ownerRecordedCwd ?? cwd;
if (resumeTarget && runtimeCwd !== cwd) {
  warnCrossCwdResume({ invocationCwd: cwd, executionCwd: runtimeCwd });
}
const legacyTools = createCodingTools();
const approvalAdapterFactory = createStaticLegacyApprovalAdapterFactory({
  mode: approvalMode,
  projectRoot: runtimeCwd,
  tools: legacyTools,
});
const driverFactory = createLegacySessionThreadDriverFactory({
  sessionDir: storageRoots.legacySessionDir,
  approvalAdapterFactory,
  configure: ({ model }) => {
    const projectRules = new ProjectRules({ cwd: runtimeCwd });
    return {
      sessionOptions: {
        agentConfig: {
          streamFn: createProviderStreamFn(fauxScript),
          tools: guardProjectRuleExecutions(createCodingTools(), projectRules),
          systemPrompt: () => buildSystemPrompt(runtimeCwd),
          transformContext: (context) => projectRules.inject(context),
          beforeToolCall: (call) => projectRules.beforeToolCall(call),
          model,
          cwd: runtimeCwd,
        },
      },
      policyRevision: `legacy-cli-${approvalMode}-v2`,
    };
  },
});
const modelResolver = createCliRuntimeModelResolver(providerRegistry);
if (cliConfig.model) modelResolver.register(cliConfig.model);
const runtime = await createRuntime({
  workspace: {
    cwd: runtimeCwd,
    ...(resumeTarget && { workspaceId: resumeTarget.ownerWorkspaceId }),
  },                                          // 可列索引，但尚未创建/attach thread
  storage,                                    // 显式 port；runtime core 不自行找目录
  modelResolver,
  permissionPolicy: createLegacyPermissionPolicy(),
  threadDriverFactory: driverFactory,
});                                             // 未选模型时仍是零 thread/零 journal

if (flags.json && flags.eventFormat === 'envelope') {
  return startEnvelopeHeadless(runtime);        // 不隐式 create/resume 默认 thread
}

const frontend = new RuntimeFrontendSession({
  runtime,
  attachment: resumeTarget ? 'resume' : 'create',
  ...(resumeTarget && { threadId: resumeTarget.threadId }),
  ...(cliConfig.model && { initialModel: cliConfig.model }),
  registerModel: (model) => modelResolver.register(model),
});
await frontend.initialize();
const approval = approvalMode === 'interactive'
  ? {
      broker: { resolve: (requestId, decision) => frontend.resolveApproval(requestId, decision) },
      onAbort: () => {},
      subscribe: () => () => {},
    }
  : undefined;                                 // 只翻译成 control_response/abort op，不持 waiter
if (stdinIsTty && stdoutIsTty && TERM !== 'dumb') {
  try {
    const { startTui } = await import('./tui.js');     // native 依赖只在这里加载
    return await startTui(frontend, approval);
  } catch (error) {
    logTuiFallback(error);                             // startTui 已恢复终端
  }
}
if (flags.json) return startHeadless(frontend, { approval });
if (flags.prompt) return runOneShotWithPlainRenderer(frontend, flags.prompt);
return startRepl(frontend, createClassicRenderer(...), approval);
```

`resolveRuntimeStorageRoots()` 把所有目录选择收口在 CLI：未传覆盖时，legacy session root 是
`<home>/.coda/sessions`，canonical runtime root 是 `<home>/.coda/runtime-v2`；传
`--session-dir <dir>` 时，legacy root 精确为 `<dir>`，runtime root 精确为 `<dir>/.runtime-v2`。
两个 root 一起注入同一个 `RuntimeStoragePort`，因此 catalog、v1 import、canonical create/resume
使用同一 adapter 视图。runtime core/public module 不读取 `HOME`、env 或默认路径，也不能绕过 port
直开 SessionStore；嵌入方和测试可注入完全自定义的临时/内存 storage。

legacy `--continue` 仍按整个 session root 的 `createdAt` 选择最新项，无 id `--resume` 仍展示整个
root，显式旧 id 仍可命中跨 cwd v1；阶段 1+ canonical thread 也进入同一全局
`storage.listStoredThreads()` 视图，因此没有 v1 backend 的阶段 2 thread 仍可 continue。选中后 CLI
按 locator 中记录的 ownerWorkspaceId 打开 owner workspace。这个 bootstrap 在 Runtime 打开前存在的唯一
原因是保留全局 picker 语义。为恢复“workspace 是资源/权限
边界”的新基线，跨 cwd resume 的执行 cwd 固定为 v1 `MetaRecord.cwd` 并明确告警，不再沿用阶段 0
“在本次 invocation cwd 执行”的隐式行为；这是阶段 1 列明的 legacy CLI 安全性 breaking change之一，
不改变 Session API 或默认 headless event/frame 投影。已被 canonical `driverRef/creationKey` claim 的
v1 mirror 在 global catalog 中映射回原 canonical ThreadId，不显示第二项。

CLI 在调用 `createRuntime()` 前把本次 invocation cwd 解析为 current-host absolute path并原样传入；
Runtime 自身绝不 fallback ambient `process.cwd()`。global picker 仍可列出 raw cwd 不可执行的历史 v1，
但选中 empty/relative/NUL/当前 host 非 absolute 的项时只显示 `invalid_legacy_workspace_cwd` diagnostic，
不尝试 normalize、跨平台转换或 mutable resume。有效跨 cwd 项才按其 raw absolute MetaRecord.cwd 打开。

第二项列明的收紧是 mutable ownership：阶段 1+ production CLI 对同一 owner workspace 获取排他
SupervisorLease；已有 CLI/Runtime 存活时，第二个同 cwd mutable CLI 在 recovery/attach 前报
`workspace_in_use`。direct exported `Session` 不取得这把 workspace lease：不同 session id 仍可并行，
但同一 backend/session id 的双 `resume` 自阶段 2 起稳定报 `session_in_use`；并发 picker/审计只走
`listStoredThreads()` 等只读入口。

flag parser 只保留空格形式 `--resume <legacy-id>` 的既有日期形状启发式，避免把
`coda --resume "prompt"` 的 prompt 误吞；任意 opaque ThreadId 必须使用无歧义的
equals 文法 `--resume=<thread-id>`（空值非法）。这里“无歧义”只指 flag/prompt parser：ThreadId 仅在
workspace 内唯一，global catalog 若匹配 0 项则 not found、1 项才直开、N 项必须报
`ambiguous_thread_id` 并展示带 workspace/cwd 的 picker；调用方可用
`--workspace=<workspace-id> --resume=<thread-id>` 指定唯一 pair。裸 `--resume` 仍打开 picker。阶段 1
后不得通过解析 ThreadId 前缀来决定它属于哪个 workspace，catalog locator 才是权威。

完整 envelope headless 是多 thread transport：它在读取第一条 stdin op 前建立 workspace-wide hot
subscription，不生成默认 ThreadId、不隐式提交 lifecycle op；每个 create/resume 的 ModelRef 来自调用方
RuntimeOp。legacy `--json` 与 one-shot/plain 才使用伪码中的单 thread attachment。

`RuntimeFrontendSession` 是 CLI 的 legacy `CliSession` adapter；它始终持有 catalog-capable
RuntimePort，但可以没有 attached thread：没有有效
模型选择时 `messages=[]`、usage 为零，prompt
给出 `/login` → `/model` 的可执行提示；只有 `/model` 成功或最近一次**用户显式选择**仍有效时，
才显式提交携带 ModelRef 的 create/resume 并 attach 默认 thread。CLI 不持有 Agent，也不直接调用
`Session`、retry、compaction 或 control waiter；审批按键只由 adapter 翻译为 `control_response`/`abort`
op。它先调用 `runtime.events({ threadIds: [threadId] })` 建立 hot subscription，再
提交 create/resume op；receipt 后调用 `runtime.getThreadSnapshot(threadId)`，用 transcript/usage 及
queue/plan/control/in-flight projection hydrate renderer，并丢弃订阅队列中
`seq <= snapshot.highWaterSeq` 的 envelope，之后只增量应用更大 seq。CLI 不直接读 repository；
`retry_scheduled`、`compaction_start` 与 `control_request` 都从同一 envelope 流到达。旧 v1 历史只在
snapshot 中出现，不伪造过去的 envelope。

`createLegacySessionThreadDriverFactory.configure` 每次 attachment 调用一次，必须构造全新的
project-rule/doom-loop state，并让该 attachment 的新 Agent 自建 FileTracker；不能浅拷贝捕获同一对象的
hook，也不能让 ToolDefinition 捕获 tracker。CLI 同时注入 immutable
`createStaticLegacyApprovalAdapterFactory`；每个 adapter 只做 frozen preflight/applyResponse，durable
pattern repository 与 pending control waiter 都由 Runtime 在 Supervisor lease 下拥有。provider
dispatcher 与不可变 tool 定义可共享。稳定 `policyRevision` 与当前 run command/reservation 的
`permissionCeiling.revision` 组成 control request/resolution 的冻结 `policyRevision`；相同 thread 的
不同 run 不能沿用 attachment 初始 revision。Supervisor 通过独立 PermissionPolicyPort 派生并持久化
run permissionCeiling，driver 在任何 sampling/tool/approval 前把该同一对象绑定到 attachment 的
permission state；adapter 不能按 thread id 重算或在 resume/retry 时放宽。显式 registry composition
已由 turn 捕获的 EffectivePolicySnapshot 统一解释；production static 默认仍由 legacy adapter 保持原
行为。正常 workspace picker 的候选只来自 `runtime.listThreadDetails()` 的
持久索引；CLI `--continue/--resume` 则只经上面的 storage global catalog bootstrap，CLI 本身仍不
扫描或直读 repository。两者选中后都严格执行 events → resume → snapshot 顺序。

以上是阶段 2 compatibility composition：`LegacySessionThreadDriverFactory` 是隔离的过渡 adapter，不属于
Supervisor core。阶段 3 已另外提供显式 `createCliRegistryCapabilityServices()`，用
`ProviderAdapterRegistry` 与 `CapabilityRegistry` 组装同一批工具/provider；production `main.ts` 仍有意
保留 static 默认，没有因新增 factory 静默切换。两条路径中 CLI 都只负责选择并注入实现，不在 adapter
外持有 run/mailbox 状态机。

阶段 2 已把临时 per-thread writer 提取为 `TranscriptRepository` + `EventCommitter`，并由
workspace-owned `EventHub` 提供 runtime subscription。TUI 消费自己的队列并按
`maxFps:30` 合并绘制；assistant Markdown、累计 tool output 与 stream status 在同一 native frame 前
只保留最后一次 visual task，canonical `message_end`/`tool_execution_end` 会取消待处理 task 并同步最终
内容。恢复 transcript 首帧以最后 120 条 message 为目标；为避免从 turn 中间切开，可向前扩至最多
240 条，并附一条分段提示。PageUp 每次向前装载一段；搜索
先装载剩余段再定位。完整 review/tool output 与大型 diff 仍只在用户打开 `/review`、`/diff` panel 时
构造，旧历史代码高亮也只作用于当前已装载 segment。classic/plain/headless 的 stdout `drain` 只背压各自输出泵，不反向阻塞
Runtime，退出则必须等待输出泵 drain。direct `Agent.subscribe` 仍保留阶段 0 awaited Emitter 语义；
exported `Session.subscribe` 已经由 standalone private durable cursor pump 异步投递，慢 listener 或
reject 不会反向延迟 run/`waitForIdle()`。

### 2.1 交互 session 与审阅工作流

UX3 交互命令全部经 `RuntimeWorkspaceActions` 翻译为 RuntimePort query/op：

```text
/new                         创建并切换到新 thread
/sessions [query]            搜索完整 workspace catalog
/resume [thread-id]          恢复并切换；无 id 时打开 picker
/switch <thread-id>          切换可见 attachment，不停止源 run
/rename <title>              写入 canonical thread metadata
/archive [on|off]            archive/restore 当前 thread
/compact                     显式 manual compaction，不隐式继续
/retry [turn-id]             在安全 fork 中重试 user turn
/fork [turn-id]              复制截至 turn 的 committed conversation
/review                      展示完整 reasoning/tool review snapshot
/diff [turn|workspace]       打开完整分组 diff
/permissions                 展示 Runtime permission revision/ceiling
```

picker 对 title、ThreadId、state/archived、ISO time、workspace、cwd 与 preview 统一搜索，并按 updatedAt
倒序。switch 前同步保存源 draft/scroll/unread/panel；目标 snapshot splice 完成后恢复目标 state，并只从
目标 pending controls 重建审批卡。workspace-wide event pump 继续消费后台 thread，只有当前目标投影到
transcript；后台 run 的 completion 仍能结案对应 op waiter。`Esc` abort 与 y/a/n approval 严格绑定当前
目标及 control 冻结的 owning RunId，页面切换不会让旧卡片误作用于新 thread。

reasoning 默认只显示状态和耗时；`/review` 才输出完整 content。工具默认显示名称、目标、状态、耗时与
结果摘要，完整 args/output 也只来自 Runtime review snapshot。diff viewer 不截断 patch，分组为 staged、
unstaged、untracked 或 turn；Git 采集在 RuntimePort 后的 composition adapter 中完成，TUI 不导入 Git/
repository。fork/retry 只复制已提交 conversation checkpoint，源 busy/pending approval 时拒绝；它们不
回滚 workspace 文件、shell 或外部副作用。

### 2.2 项目规则感知(`AGENTS.md`)

项目规则的路径来源与固定预算由 CLI composition 注入 `RuleSnapshotProvider/RuleSnapshotBudget`，base
system prompt 由 `BasePromptProvider` 注入；每 turn 的读取/发现属于前两者，纯拼装属于
`PromptAssembler`，执行门禁属于 `PolicyEngine`。CLI 不运行这些业务规则。阶段 0 的 `ProjectRules` + `transformContext` +
`beforeToolCall` 是 legacy adapter；阶段 3 registry path 已把同一对象作为结构化
`RuleSnapshotProvider/RuleFreshnessPort` 注入，同时保持下列文件语义。
规则正文不新增 `AgentMessage` 字段，诊断通过 RuntimeEvent/envelope 到达前端；legacy 投影仍走
stderr，不污染裸 `SessionEvent`/NDJSON。规则读取器从物理 `cwd` 向上查找最近的
`.git` 文件或目录作为仓库根；不在 Git 仓库时以 `cwd` 自身为根。首次出站自动发现
`仓库根 → cwd` 每一级的 `AGENTS.md`，之后把本轮实际触达的目标目录带到下一次出站；
未继续使用的历史 sibling 不永久占据 prompt 或预算。每个有效文件以
下列区块追加到 **system prompt**，按 root → target 排列；后出现的窄作用域规则在冲突时
优先：

```text
<project_rule source="/repo/packages/app/AGENTS.md" scope="/repo/packages/app/**">
...规则正文...
</project_rule>
```

`PromptAssembler` 只用该 turn 的不可变 capability snapshot 与
`EffectivePolicySnapshot.rules` 修改当次出站
`Context.systemPrompt` 副本；规则正文绝不变成 user/tool 消息，因此不会进入 transcript、thread
journal、恢复回显或 compaction
摘要。每次模型采样都重新扫描文件，不依赖启动期缓存；文件新增、修改或删除后，下一 turn
看到新结果。

执行前门禁由只读 `RuleFreshnessPort` 与纯 `PolicyEngine` 对同一 `PreparedInvocation` 处理，顺序固定为
**规则 freshness gate → approval policy**；legacy adapter 继续复用既有 `beforeToolCall`：

`createCliRegistryCapabilityServices()` 只接受显式绝对 `cwd`、host ports 与 budget；composition 构造时只
物理化一次 project root，并把精确配置
`{kind:'cli_legacy_policy_v1',approvalMode,projectRoot,projectRootReal,bashAnalysisVersion}` strict-copy/
deep-freeze 后纳入 `policyBasisRevision`。因此 approval mode、词法/物理 root 或 analyzer version 任一变化
都会撤销旧 basis；`evaluate()` 不再读取 live config、调用 `realpath` 或重新分析 command。

- `edit` / `write` 的目标作用域是 `path` 所在目录；
- `bash` 的基础作用域是最终执行 `workdir`，缺省为启动 `cwd`；CLI cwd 与 workdir 先物理化，
  相对 workdir 在规则分析、approval 与真实 `Bun.spawn` 三处都以同一 cwd 为基准。registry path 的
  authoritative capability resolver 在 `prepare()` 中只分析一次，跟踪 literal `cd`、`git` / `make` /
  `ninja` / `tar` / `pnpm` 等确有目录语义的 `-C`、输入输出重定向、显式路径和裸相对文件/目录；
  可见 filesystem target 保守绑定 read + write，失败的 `cd` 后保留旧/新 cwd 并集。动态展开、
  shell group/control flow、脚本、解释器 inline/module/preload/REPL、`eval` / `source` / `sh -c`
  （含 `env` / `sudo` / `nohup` / `timeout` / BusyBox / Toybox 等 runner 包装）、`git apply` 等无法确定
  目标的命令由规则 gate
  回喂可恢复错误，要求改用明确 workdir/literal path 或拆成 `edit` / `write`；
- 首次触达更深目录，或规则在本次模型请求之后发生变化时，本次调用先返回一条可恢复的
  isError tool result，不执行副作用；紧接的下一 turn 注入完整新规则，模型审阅后重试；
- loop 会先串行 preflight 整批调用，因此三个工具在真正 `execute` 边界再做同一检查；同批
  较早的命令若改写 `AGENTS.md`，后续写操作不会在旧规则上下文中漏执行；
- 若目标没有新增有效规则，调用直接进入原审批/执行路径，不额外消耗 turn。

resolver 把 legacy Bash 投影冻结为 exact-shape attributes
`{kind:'legacy_bash_analysis_v2',command,patterns,forceConfirm,reasons,accessesExternalProject,filesystemTargets,modelDescription?}`，
并同时冻结 `CapabilityInvocationAnalysis`。完整的项目内 literal pattern 保持旧审批匹配；opaque、分析不全、
canonicalization 不全或项目外访问都标记 `once_only`，本次可 ask，但不得生成或命中 remembered grant；
危险命令的 `safety:deny` 直接收窄为 recoverable deny。八个内置 binding 全部是 version 2；普通 path
resolver 用 `legacy_filesystem_analysis_v1` 冻结同形 `filesystemTargets`（file/directory/unknown），Bash
将其嵌入上面的 v2 attributes。同 target 的冲突 kind 收敛为 unknown。

`RuleFreshnessPort` 只比较 PreparedInvocation 中冻结的 RuleSnapshot/resources/analysis 与当前规则文件指纹；
它不检查 command resource、不重新解析 args/shell，也不解释权限或返回 allow/ask。freshness 为回答“规则从
snapshot 后是否变化”可以读取当前 `AGENTS.md`/filesystem fingerprints，但不能据此重建 capability resource
语义，也不能对 frozen target 做 `stat`/realpath 来重判 file/directory。file scope 固定取父目录，
directory/unknown 固定取 target 自身的保守链；prepare 后创建、删除或替换 target 不改变这份 scope。
缺 scope 或指纹变化时只产生 recoverable deny/tool result，下一 turn 才由 PromptAssembler 读取并
注入新 snapshot。`PolicyEngine.evaluate()` 则完全不读 live filesystem。这样 execute 前复检不会违反
PolicyEngine 只读 frozen policy 的契约，也不会在同一 PreparedInvocation 中偷换策略。

默认 `RuleSnapshotBudget` 冻结为单文件 **32 KiB** (`maxFileBytes`)、最终规则区块估算
**16K tokens** (`maxPromptTokens`)；`maxFiles/maxBytes` 也由 composition 显式给出并进入 snapshot
discovery/revision，不能由 provider 暗读环境。registry `createRuntime()` 必须在任何 workspace/storage I/O
前对四字段 budget 做 strict-JSON、exact-own-data-property snapshot；symbol、accessor、non-enumerable、
额外字段或非 plain object 直接拒绝，后续只使用这份冻结副本。预算包含标题、source /
scope 与标签，不只计算正文。ASCII 按 `length / 4`，CJK/emoji 按 UTF-16 code unit
保守计数。总预算不足时先保留窄作用域规则，再按 root → target 渲染；某个 sibling 因预算
未进入最近 prompt 时，其工具调用仍会被 gate，不能因全局 section 未变化而放行。

`AGENTS.md` 与目标路径共用 dangling-aware canonicalizer。文件 leaf 或父目录软链越界时，
规则扫描停在链接前的最深安全祖先并 warning；仓库外规则正文绝不读取。规则文件按
`O_NOFOLLOW` fd 打开，以 `fstat` / inode 复核绑定解析结果，只读取 `maxBytes + 1` 后再次
核对纳秒级 metadata，关闭“先 stat 小文件、再整文件读入”的资源竞态。Node/Bun 没有
`openat2`，中间目录的对抗性纳秒级替换仍是 OS 能力边界；execute 前的第二次复检把普通
同批竞态窗口压到工具调用边界。

读取/元数据失败（含指向仓库内缺失目标的 dangling 规则链接）、越界符号链接、单文件或
总预算超限经 runtime diagnostic event 报告；同一 turn 的 preflight / execute 复检去重，
故障恢复后再次出现仍会重新报告：
OpenTUI 走 `TuiScreen.println`，TTY classic 走 renderer；legacy plain/headless/一次性仍走清洗后的
stderr。所有文本先移除 ANSI/OSC/C0/C1。warning 不进入 transcript；canonical envelope 模式可见
诊断事件，legacy 裸 NDJSON 为兼容继续不混入该分支，也不会把任务升级为 fatal。

## 3. 键位表

| 状态 | 键 | 行为（canonical；括号内为阶段 0 legacy） |
|---|---|---|
| 空闲 | `Enter` | 提交 `prompt` op（`session.prompt(text)`） |
| TUI / classic 输入 | `Shift+Enter` | 插入换行,不发送 |
| 任意 | `Ctrl+C` | 输入非空:清空输入行;输入为空:提示「再按一次退出」,1.5s 内再按退出 |
| 空闲 | `Ctrl+D` | 输入为空时退出 |
| TUI | `Alt+↑` / `Alt+↓` | 顺序浏览输入历史 |
| classic | `↑` / `↓` | 多行内上下移动；单行边界处浏览历史 |
| TUI / classic | `Ctrl+R` | 以当前 draft 为 query 反向搜索当前 thread 的 prompt 历史；恢复会话时从 canonical transcript 重建 |
| TUI / classic | `Ctrl+O` | 暂停终端控制，用 `$VISUAL`/`$EDITOR` 编辑当前 draft，返回后恢复原 surface |
| TUI / classic | `Ctrl+K` | 打开统一 command palette；`Esc` 返回打开前的 draft |
| TUI / classic | `Ctrl+F` | 进入 `/search `；classic 以文本结果显示匹配 |
| TUI / classic | `Meta+S` | 为当前 thread 同步 durable stash 并清空 composer |
| TUI / classic | `Tab`（cursor 位于 `@query` 后） | 补全 workspace 内文件/目录，不跟随符号链接且有界扫描 |
| TUI | `End` | 跳到最新输出并清 unread；文本等价命令是 `/latest` |
| slash menu | `↑` / `↓` | 循环选择分类、模糊匹配的命令 |
| slash menu | `Tab` | 补全当前命令并追加空格,不发送 |
| slash menu | `Enter` | 采用当前命令并立即按当前 phase 的 Enter 语义发送 |
| slash menu | `Esc` | 关闭候选,保留输入；后续 Esc 才进入 abort/退出语义 |
| provider candidate menu | `↑` / `↓` | 循环选择当前 provider 步骤的候选 |
| provider candidate menu | `Enter` | 确认当前候选；不要求输入编号 |
| provider 子流程 | `Esc` | 静默返回上一步；离开秘密步骤时清空 key |
| provider 根步骤 | `Esc` | 静默退出流程，不打印取消提示 |
| 流式中 | `Enter` | 提交 `steer` op，进入目标 thread 的 **steering** 队列（`session.steer(text)`） |
| retry backoff | `Enter` | 当前输入入 **steering** 队列,等待重试 turn 消费 |
| compacting | `Enter` | 提交 `prompt` op；目标 ThreadRuntime 在 compaction commit 后启动（Session 兼容暂存） |
| running / retrying / compacting | `/login`、`/model`、`/logout` + `Enter` | 不进入模型上下文；提示先完成或 abort，保持原状态 |
| 任意 | `Alt+Enter` | 提交 `follow_up` op，进入目标 thread 队列（`session.followUp(text)`） |
| 流式中 | `Esc` | 提交带目标 `ThreadId/expectedRunId` 的 `abort` op（`session.abort()`） |
| retry backoff / compacting | `Esc` | 提交目标 thread 的 `abort` op，取消待重试或压缩 |
| TUI | `PageUp` / `PageDown` | 滚动中间 transcript,输入框保持焦点；classic/accessibility 使用终端 scrollback |
| 任意 | `Esc Esc`(500ms 内)或 `Ctrl+C Ctrl+C` | 退出（流式中先 abort，等待权威提交与输出泵后 `RuntimePort.close()`） |
| 审批中 | 无修饰的 `v` / `y` / `a` / `n` / `Esc` | 展开权威详情，或提交 `control_response`（本次允许 / 始终允许 / 拒绝）/目标 run `abort`；其余输入冻结。现代 card 仅在有 frozen allow-always scope 时提示 `a`；legacy compatibility prompt 仍接受既有 `a`，但明确 scope unavailable |

### 3.1 为什么与 pi 完全一致

键位延续原 classic REPL 与 pi 的交互语义:

- **流式期间打字的默认去向应当是风险最低的动作。** 用户在模型工作时输入,绝大多数意图是「补充/纠偏」,而 steering 恰好是不打断执行中工具、在 turn 边界温和注入的语义(见 [06-steering-following](./06-steering-following.md))——把它放在无修饰的 `Enter` 上,让最自然的动作对应最安全的语义。
- **升级动作配升级键。** follow-up(等整个任务结束)是更「延后」的意图,配组合键 `Alt+Enter`;abort 是破坏性动作,配独立键 `Esc`,与输入内容无关(Esc 不消费输入框文本)。
- **运行中的第二个 prompt 在输入映射层被吸收**：CLI 在 running/retrying 状态不提交 prompt，
  即使迟到提交也会得到确定的拒绝 receipt；compacting 由 ThreadRuntime 按兼容语义暂存。用户无需
  理解这些约束，键位已经替他选好了。

### 3.2 终端编码现实

- OpenTUI 默认启用 Kitty keyboard disambiguation;支持该协议的终端能可靠区分 `Esc`、`Alt+Enter` 与 `Shift+Enter`。不支持时由解析器降级;classic 仍用 readline `escapeCodeTimeout=50ms`。
- `Alt+Enter` 以 `key.meta && return` 为主。始终保留 `/f ` / `/followup ` 兜底,保证不能发送 Meta+Enter 的终端仍有完整功能。
- Shift+Enter 在不报告修饰键的旧终端可能退化成普通 Enter;可用 bracketed paste 输入多行。
- 斜杠命令除 `/login`、`/model`、`/logout`、`/auth`（兼容 `/auth-status`）、`/doctor`、
  `/quit`（兼容 `/q`）、`/queue`、`/status`、`/help`
  外，还包括 `/abort`、`/history`、`/edit`、`/files`、`/stash`、`/restore`、`/draft`、`/vim`、
  `/search`、`/next`、`/previous`（兼容 `/prev`）、`/latest`、`/copy`、`/export` 与 `/followup`
  （兼容 `/f`），以及 `/review`、`/diff`、`/permissions`、`/compact`、`/retry`、`/fork`、`/new`、
  `/sessions`、`/resume`、`/switch`、`/rename`、`/archive`。运行中 read-only/presentation/session switch
  命令继续执行；compact/retry/fork/archive-on 与 provider/quit 按状态显示 disabled 原因。
  CLI help/completion、TUI/classic slash 候选和三种 surface 的 `/help` 都由
  `command-catalog.ts` 的 `COMMAND_SPECS` 派生；别名参与匹配和补全但不单独渲染。帮助按 surface
  过滤键位，不把 TUI 的 PageUp/history 或 classic 的多行键位冒充 accessible/plain 能力。

## 4. 渲染器与 RuntimeEvent 对应表

交互 TUI/classic/plain 都消费目标 thread 的 `EventEnvelope`，只把 `event` payload 交给视图 reducer，
同时保留 identity/seq 做去重、缺口检测与 stale run 防护：

```ts
// src/cli/renderer.ts
export interface Renderer {
  render(envelope: EventEnvelope): void;
  replayTranscript(threadId: ThreadId, messages: readonly AgentMessage[]): void;
  drain(): Promise<void>; // 只等待此前排进该前端队列的输出
}
```

阶段 0 的 Renderer/SessionEvent 接口由 legacy projector 继续适配；阶段 1 起 CLI 不直接订阅
Session。`RuntimeEvent` 包含排除 legacy `approval_request` 的 AgentEvent、op/thread lifecycle、
retry/compaction/usage、thread result 与统一 control 事件。各内层事件的
TUI 渲染行为：

| RuntimeEvent（legacy 名称相同） | TUI 渲染行为 |
|---|---|
| `agent_start` | 空输入时 prompt placeholder 进入 working;`reason:'follow_up'` 追加 `↪ follow-up` |
| `agent_end` | 最终边界追加 done/aborted/error;`willRetry:true` 保持 retrying,不误报完成 |
| `turn_start` | 无可见输出(内部计数) |
| `turn_end` | 无额外分隔组件 |
| `message_start` (user) | 追加 user / steering / follow-up / synthetic 块 |
| `message_start` (assistant) | 创建按 message id 索引的流式 Markdown 块 |
| `message_update` | `text_delta` 按 `contentIndex` 累积到有序块；reasoning 默认折叠为状态/耗时，不把完整内容直接铺入 transcript，`/review` 从 Runtime snapshot 展开；不能把多个 content part 粘成一个单词或在最终消息到达时跳变；tool-call 参数流只更新 activity |
| `message_end` (assistant) | `stopReason: 'length'` 追加警示行 `[output truncated by model limit]`;`'aborted'` 追加 `[aborted]` |
| `message_end` (tool_result) | 已由 `tool_execution_end` 渲染,此处无输出(去重) |
| `tool_execution_start/update/end` | 原位更新同一工具摘要块：名称/目标/耗时/状态/结果摘要；`update.output` 是累计快照，view/review reducer 都整块替换而不拼接；`/review` 展开完整 args/output；完整 diff 只进入 Runtime diff viewer，普通 transcript 可保留兼容摘要 |
| `queue_update` | 完整替换计数;running/retrying 时附在 prompt placeholder |
| `plan_update` | 原位替换同一 plan 块:`✓` / `▶` / `○`,不重复追加整表 |
| `control_request(kind:'approval')` | 权威提交后 prompt 横线切黄色并显示折叠卡片；`v` 只展开 `ApprovalPresentation` 的 capability/resource/risk/scope/revision；已有 draft 保留但冻结；legacy scope 缺省时明确 unavailable；legacy 投影名为 `approval_request` |
| `thread_updated` | 刷新 session catalog/title/archive 状态；不直接改 transcript 或当前 run phase |
| `usage_update` | 用 `contextTokens` 刷新 footer;不使用 cumulative 伪装当前上下文 |
| `retry_scheduled` / `compaction_*` | 追加 notice 并更新 activity；controller 与 view 共享同一个 envelope reducer 状态投影,不得分别读取瞬时的 runtime/agent state；取消重试后的 error 与 compaction_end 都回到 idle |
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

[task] /status          Show model, usage, and token status
────────────────────────────────────────────────────────────
/st▌
────────────────────────────────────────────────────────────
 idle · thread …0123456789 · permissions interactive · queue 0/0
 ~/Desktop/openai/openai-sdk-ts  (main*)
 context 2.4k / 128k · 1.9%                    openai/gpt-5.2
```

中间转录短时锚定顶部；只有填满后才滚动并跟随最新内容。图中已完成首次交互，真实 header 收缩为
3 行紧凑任务栏；为节省示意篇幅未重复画出。用户输入 `/st` 后 fuzzy 候选从 prompt 向上展开；按 `Tab`
只补成 `/status `，按 `Enter` 则补全并执行。三行 footer 固定在屏幕底部，多行 prompt 与 palette 都从
其上方向上扩展。

## 6. Headless JSON 模式(`--json`)

### 6.1 两种兼容输出面

`coda --json` 把交互前端换成纯 JSON 管道，stdin/stdout 都是一行一条 JSON（NDJSON）：

- 默认 `--event-format=legacy`：保留既有简写命令与裸 `SessionEvent`，用于旧脚本；
- 显式 `--event-format=envelope`：stdin 是完整 `RuntimeOp`，stdout 使用包含
  `EventEnvelope<RuntimeEvent>`、`OpReceipt` 与 transport error 的 tagged frame 联合，可同时驱动
  多个 thread。

两种模式都只经同一个 RuntimePort；legacy 是 identity/envelope 的投影，不是第二套业务实现：

- **它证明 CLI 没有私藏语义。** 键位表的每个动作(第 3 节)在这里都有同构命令;若某能力只能在交互模式做到,说明该逻辑放错了层。
- **它是 codex 外协议的最小同构。** codex 的边界只有 `submit(Op)` 与 `next_event()`,一切 UI 交互(含审批应答)都是可序列化的 Op;我们的命令流/事件流与之同形,天然可保序、可跨进程。
- **它是未来 server 化 / IDE 集成的基础。** 把 stdin/stdout 换成 WebSocket 或 HTTP+SSE,协议一字不改——opencode V2 的 client/server 重写之所以痛苦,正因为 V1 没有先留下这个面。
- **它是 e2e 测试的执行面。** [10-testing](./10-testing.md) 的 CLI e2e 用 faux provider + `--json` 管道断言事件序列,完全离线、无 PTY 依赖。

### 6.2 命令规格（stdin，一行一条 JSON）

```ts
// src/cli/headless.ts
export type CliCommand =
  | { type: 'prompt';    text: string }   // 空闲时开新任务;运行中返回 error 事件(non-fatal)
  | { type: 'steer';     text: string }   // 入 steering 队列(随时)
  | { type: 'follow_up'; text: string }   // 入 follow-up 队列(随时)
  | { type: 'abort' }                     // 投影成默认 thread 的 abort op
  | { type: 'approval'; approvalId: string;
      decision: 'allow_once' | 'allow_always' | 'deny' | 'abort' }
  | { type: 'shutdown' };                 // 见 6.4
```

以上是 legacy 简写。CLI 为其生成 `OpId` 并补默认 `WorkspaceId/ThreadId` 后提交对应 RuntimeOp；
`follow_up` 与 `UserMessage.source`、`QueuedMessage.kind` 的字面量一致。envelope 模式直接接受
[12](./12-supervisor-runtime.md) §3.2 的完整 RuntimeOp，调用方必须提供 identity，重复 OpId 返回原
receipt 且不得重复副作用；唯一额外输入是无 identity 的 transport frame
`{type:'transport_shutdown'}`（EOF 等价）。frame 自身不产生 OpReceipt/lifecycle envelope，但
RuntimePort.close 为每个 attachment 只派生 [12](./12-supervisor-runtime.md) 定义的幂等
thread_close op；close 内部传播 cancellation 并结案已有 control/run 所产生的 terminal envelopes 仍须
完整输出，不能把这些后果描述成未定义的新 abort/control-resolution RuntimeOp。

映射规则:

| legacy 命令 | canonical op | 运行中语义 |
|---|---|---|
| `prompt` | `prompt` | running/retrying 时返回拒绝 receipt/non-fatal error 投影；compacting 时按兼容语义暂存 |
| `steer` | `steer` | 随时合法，只进入目标 thread mailbox/steering 队列 |
| `follow_up` | `follow_up` | 随时合法，只进入目标 thread mailbox/follow-up 队列 |
| `abort` | `abort` | idle 时为 no-op；可用 `expectedRunId` 防止迟到取消 |
| `approval` | `control_response` 或 `abort` | 前三种 decision 响应同 thread request；`abort` 只中止该 request 冻结的 owning run |
| `shutdown` | 见 6.4 | — |

### 6.3 输出规格（stdout，NDJSON）

- legacy 启动 hello 保持阶段 0 的精确形态
  `{"type":"protocol","protocolVersion":"<semver>"}`，不得偷偷增加字段；envelope 模式的 hello
  是 workspace 级传输握手，增加 `"eventFormat":"envelope"` 与 `"workspaceId"`。只有启用了单默认
  thread 简写的 adapter 才额外给出 `"defaultThreadId"`；完整 RuntimeOp 模式不得伪造默认 thread。
  tolerant reader 可忽略未知事件类型。
- legacy 模式其后每行一个裸 `SessionEvent`，保持阶段 0 的逐事件形态与顺序；projector 剥离
  identity/seq，并把 `control_request(kind:'approval')` 映射为 `approval_request`。无法无损表达的
  多 thread 事件不得混进默认流，订阅时固定一个 thread。
- envelope 模式的事件行是原样 `EventEnvelope`。同 thread `seq` 严格递增且恢复后续接；不同 thread
  不声明全局顺序。消费者用 `(workspaceId, threadId, seq)` 去重/发现缺口，用 `runId` 忽略迟到 UI。
- envelope transport 还必须承载非事件结果，完整 stdout 联合为：

  ```ts
  type EnvelopeHeadlessOutput =
    | EventEnvelope
    | { type: 'op_receipt'; receipt: OpReceipt }
    | { type: 'transport_error'; fatal: boolean; message: string;
        code?: 'invalid_input' | 'scope_dispatch_failed' |
          'event_subscription_gap' | 'runtime_event_stream_fatal';
        opId?: ExternalOpId; failedThreadIds?: readonly ThreadId[];
        threadId?: ThreadId; lastDeliveredSeq?: number; nextAvailableSeq?: number;
        causeCode?: string };
  ```

  通过 pre-ledger validation 且没有 scope dispatch port failure 的 RuntimeOp 恰好输出一个匹配 OpId 的
  `op_receipt`（包括 duplicate/rejected 与 `targetThreadIds`）；重复 OpId 不要求产生第二个 lifecycle
  envelope。`cancel_scope` 在部分 target acceptance writer fault 时改输出一条 nonfatal
  `transport_error{code:'scope_dispatch_failed',opId,failedThreadIds}`，不同时伪造 receipt；客户用同 OpId
  重试只补未完成 targets，最终成功才输出 receipt。RuntimeOpValidationError/语法/transport 错误没有合法
  ThreadId/seq，使用 `transport_error`，不得伪造 EventEnvelope。由于 `op_accepted/op_rejected` 必须先
  权威提交，相关 envelope 可能先于 receipt 到达，客户端按 OpId 关联，不依赖二者的 stdout 先后。
  legacy 模式不增加 receipt frame，仍按阶段 0 的裸事件/error 形态投影。
- legacy receipt/error 兼容是 CLI-private 纯映射，只读取“原简写 command + 本次 OpReceipt”，不读取
  Session/ThreadRuntime interaction state。至少冻结两条阶段 0 wire golden：`prompt` 的 rejected reason
  `thread_busy_use_steer_or_follow_up` 精确输出
  `{type:'error',fatal:false,message:'agent is running; use steer or follow_up'}`；未知/已决议 approval 的
  `control_request_not_found` rejected receipt 保持旧 Broker 的 silent no-op，不输出任何行。canonical
  `op_rejected`/receipt 本身仍被 public SessionEvent projector 丢弃，不能为了生成这两条兼容行为把状态机
  塞回 projector。
- **stdout 纪律:除 NDJSON 外零输出。** 日志、警告一律走 stderr。这条不守住,下游 `| jq` 直接坏。
- headless 从 runtime EventHub subscription 异步消费并写入自己的有序输出队列；stdout `drain` 只背压该输出泵，不反向
  背压 Agent 或其他 observer。shutdown 必须等输出泵完整 drain。默认 legacy 格式保留 payload、顺序
  与退出纪律；阶段 0 CLI 通过 Session listener await drain 的内部 timing 不属于 wire 格式，CLI 在
  阶段 1 切 RuntimePort 时由输出泵接管；阶段 2 的 exported Session listener 也已改为异步投递。
- 无法解析的 stdin 行:legacy 输出 `{type:'error', fatal:false, message:'invalid command: …'}`；envelope
  transport 输出 `{type:'transport_error', fatal:false, message:'invalid command: …'}`，均继续读下一行。
- runtime iterator 的 `EventSubscriptionGapError` / `RuntimeEventStreamError` 只在已排队 envelope 输出并
  drain 后映射成带 code/identity/cursor 或 causeCode 的 fatal `transport_error`，随后退出 1；它不是
  EventEnvelope，不分配 seq。`RuntimePort.close()` 的正常 iterator done 不输出错误 frame。
- `partial` 快照会让 `message_update` 事件体较大;v1 照发(简单正确优先),`--json-compact`(剥离 partial 只留 delta)留作后续 flag,不进 v1。

### 6.4 生命周期与退出

```
普通 headless stdin EOF
                 → 视同对应模式的 shutdown
legacy `--json -p` stdin EOF
                 → 只关闭 steer/follow-up 控制输入；继续等最终 agent_end，再自动 close/drain/exit
legacy shutdown(空闲)  → default thread_close/runtime.close → drain stdout → exit 0
legacy shutdown(运行中)→ submit default-thread abort → 等权威结案 → close → drain stdout → exit 0
full envelope transport_shutdown
                 → workspace close barrier → 并行结案全部 attached thread → drain envelopes/stdout → exit
SIGINT / SIGTERM → 同对应模式 shutdown
已提交 runtime error{fatal:true}
                 → envelope 模式保留原 EventEnvelope；legacy 投影裸 error → drain stdout → exit 1
无 thread/seq 的 transport/config/framing 致命错误
                 → envelope 模式输出 transport_error；legacy 输出裸 error → drain stdout → exit 1
stdout 输出泵失败→ stderr 报告，abort/close runtime → exit 1（损坏通道上不承诺再写错误帧）
```

full-envelope 模式没有默认 thread。`RuntimePort.close()` 第一次调用立即冻结 workspace admission，并先
等待 close barrier 前已登记的 submit/create/resume/scope in-flight token 确定性 terminal；随后从 ledger/
catalog 重算最终 lifecycle/attachment 集，再从每个 attachment 的稳定 lifecycle identity 派生幂等
thread_close 并行收束。它不另造 public/root close OpId，也不能只快照调用瞬间已经 attached 的 map。
thread_close 对 active run 的 cancellation 与 pending control resolution 是确定性状态机后果；它不另造
public RuntimeOp/root close op，但 pending control resolution 必须按 [12 §4.1](./12-supervisor-runtime.md)
使用稳定 `deriveOpId(purpose:'control_recovery')`，并沿既有 run/request identity 提交。这些事件仍由各
thread 自己编号。
它等待所有权威资源收束但不等待普通
subscription consumer；重复 close 复用同一 promise/result。所有目标尝试后若有失败，以聚合错误终止
event stream，headless drain 已有 envelopes 后输出 fatal transport_error 并 exit 1。成功则给每个
iterator 排在 buffer 后的正常 end marker，输出泵自行 drain 后 exit 0。

交互 TUI/classic 退出时必须先关闭 `ProviderCommandController`：通过外部
`AbortSignal` 取消在途的 `/login` 模型刷新并等待提交收束，再销毁视图。Registry 自身的
15 秒网络超时仅作为兜底。

`-p "..."` 一次性模式与 headless 共用同一套 one-shot 生命周期语义：提交一条 `prompt` op，等待
该 thread 的最终 run 边界后自动 shutdown，默认用 plain 人类可读输出（加 `--json` 时按所选
event format 输出）。accepted receipt 只代表进入 mailbox，不能据此提前关闭 runtime；自动 retry/
compaction successor 必须一并等待。legacy projector 继续用 `willRetry:true` 区分中间
`agent_end`。若等待期间收到已提交的 `fatal:true` runtime error，必须先保留其 envelope/legacy 投影，
再按致命路径收尾并以 1 退出；不能降格成无 identity/seq 的 `transport_error`。

### 6.5 headless legacy 会话示例

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

legacy 协议保留 `{ type: 'approval'; approvalId: string; decision: 'allow_once' |
'allow_always' | 'deny' | 'abort' }` 命令；CLI 把前三种映射成同 thread 的 `control_response` op，
`abort` 仅在 approvalId 仍 pending 时从 runtime pending-control view 读取请求创建时冻结的
`owningRunId`，映射为 `abort { expectedRunId: owningRunId }`；未知或已结案 approvalId 稳定拒绝，
绝不读取 current activity 后改杀 successor。envelope 模式直接提交 identity-bearing
`control_response`，runtime 仍必须按 pending request kind 拒绝不兼容 decision。
审批策略由 `--approval-mode <interactive|allow|deny>` 控制：交互 TUI/classic 默认 `interactive`；
headless 与 `-p` 默认 `allow`；需要审批流的客户端显式开 `interactive` 并应答 control request。

### 6.6 UX4 显式 one-shot output

下列 flags 只扩展一次性路径，不改变 §6.1–6.5 的默认 `--json` wire：

```text
coda exec --output=text "task"
coda exec --output=json --final-only "task"
coda exec --output=stream-json --ephemeral --timeout=10m "task"
```

- `--output=text`：最终 assistant text 写 stdout；`running`、tool、approval、retry、compaction 与 timeout
  progress 写 stderr。`--final-only` 抑制这些 progress。
- `--output=json`：stdout 恰好一行 terminal `result`。
- `--output=stream-json`：默认先写 `stream_start{version:1,protocolVersion}`，再写零到多条
  `{type:'event',event:SessionEvent}`，最后恰好一条 terminal `result`；`--final-only` 只保留 terminal
  `result`。
- terminal result 固定为
  `{type:'result',version:1,status:'completed'|'aborted'|'error'|'timeout',exitCode,text,usage,error?}`。
  completed 为 0、timeout 为 124，其余失败为 1；机器格式不混入 human stderr。
- `--timeout=<positive ms|s|m>` 到期只经当前 `CliSession`/RuntimePort abort；若 attachment 尚在建立，随后
  到达的 `agent_start` 仍立即 abort。`--ephemeral` 使用 memory Runtime storage 与 invocation-private legacy
  mirror，finally 删除 mirror；它不能与 continue/resume 组合，也不创建用户指定 session/runtime journal。
- `--json` 与 `--output`、`--final-only`、`--ephemeral`、`--timeout` 互斥；这是保护 legacy 逐字节 wire 的
  明确边界。未显式使用 UX4 flags 的裸 prompt、pipe、`-p` 和 `exec` 继续走原 renderer/legacy lifecycle。
- modern one-shot 与 legacy headless 共用 stdout 首次失败纪律：ordered output 的 `failureSignal` 一旦触发，
  立即对当前 Runtime attachment abort/close 并以 1 退出；损坏通道上不再承诺 terminal record，只在 stderr
  输出一次诊断。`stream-json` 的 `stream_start` 必须先 drain，已关闭的 pipe 不能启动可能产生工具副作用的 run。

## 7. Provider 认证、模型发现与选择

### 7.1 `/login`:只新增或更新认证

`coda auth login`、TUI `/login` 与 classic `/login` 共用同一组 preset 和
`provider-actions.ts` 的写入/刷新语义。一级入口固定为 OpenCode Go、OpenAI、Anthropic、Custom 和
OAuth；OAuth 显示 `coming soon · disabled`，选择它只返回明确错误，不创建 Runtime/thread、不写配置，
不得伪装成可用流程。TUI 使用 §1.2 的 candidate menu，以 `↑`/`↓` 选择、`Enter` 确认；classic 使用
同一份结构化候选打印编号/名称；CLI 子命令使用 `--preset` 或带当前步骤的交互 prompt。TUI/classic 的
`Esc` 逐级静默返回，根步骤静默退出；CLI 的 `Ctrl+C`/`Ctrl+D` 以 130 退出。TUI/classic 的整个
provider 表单使用独立临时输入缓冲；name/base URL 等非秘密字段也不得覆盖、提交或持久化 composer
中的任务 draft，流程结束或从根步骤返回时恢复原 draft。所有秘密输入只进入临时 secret buffer，CLI
走 raw、无 history 的输入，不把 key 回显到 stdout/stderr。窄屏 prompt 把 `[步骤 n]`、当前字段名与
`Esc 返回 …` 放在已确认值之前，保证当前步骤和返回方式不会被右侧截断。

API-key preset 固定为:

- **OpenCode Go**:`provider id = opencode-go`，`baseURL =
  https://opencode.ai/zen/go/v1`，用户只秘密输入 key。保存后立即 GET
  `https://opencode.ai/zen/go/v1/models`；实时结果只决定可用 id，实际协议必须再与
  [04 文档](./04-provider-adapter.md)中维护的显式 `model → api + limits` 目录相交。表外模型
  会列入 ignored 提示，绝不能猜测协议或 limits，也不能进入 `/model`；表内模型解析出的
  `ModelConfig.limits` 同时供 footer 百分比与 `CompactionCoordinator` 使用。
- **OpenAI**：preset 预填名称 OpenAI、`https://api.openai.com/v1` 与
  `openai-responses`，用户只秘密输入 key；不让普通 onboarding 表单重复询问 endpoint/protocol。
- **Anthropic**：preset 预填名称 Anthropic、`https://api.anthropic.com` 与
  `anthropic-messages`，用户只秘密输入 key。这两个固定 preset 仍复用 Custom 的稳定 canonical id
  规则（分别为 `custom:openai` / `custom:anthropic`），不新增 provider wire 协议。
- **Custom**:字段固定为 provider name、base URL、API key 与 protocol。TUI/classic 为了支持现有逐级
  `Esc` 回退按 name → base URL → API key → protocol 输入；`coda auth login` 为缩短秘密驻留时间按
  name → base URL → protocol → API key 输入，并持续显示 `[field n/4]`、已确认的非秘密字段和
  `Ctrl+C/Ctrl+D cancels`。协议只能从
  `OpenAI Chat Completions`、`OpenAI Responses`、`Anthropic Messages` 三项中选择，不接受自由
  文本。name 经 NFKC、首尾/连续空白归一化后做大小写不敏感 canonical 化，稳定 id 为
  `custom:<percent-encoded-name>`；同名再次登录就是更新，大小写不同不产生第二份 provider。
  不同 name 可并存。OpenAI 两种协议请求 `<baseURL>/models`；Anthropic 在 baseURL 尚未以
  `/v1` 结尾时请求 `<baseURL>/v1/models`，并使用对应认证 header。

非秘密配置、模型缓存和最近显式选择写入 `~/.coda/providers.json`；key 单独写入
`~/.coda/credentials.json`。每次写入先在短跨进程锁内重新读取并合并最新状态，再采用同目录
临时文件 + fsync + 原子 rename，目录权限收紧为
`0700`、文件为 `0600`，凭据目标若是符号链接则拒绝读取。秘密输入只在控制器内短暂存在，
TUI/classic renderer 始终只收到等长掩码；key 不进入输入历史、transcript、thread journal、
`RuntimeEvent`、legacy `SessionEvent` 或日志。

每次 `/login` / `/logout` 还会更新该 provider 的非秘密 revision。远端模型请求完成后只能在
短锁内以 revision、endpoint 与协议做 CAS；若期间已有更新，迟到结果必须丢弃，不能把旧
endpoint/models 与新 key 拼成撕裂状态。

配置和 key 必须先落盘再刷新模型。网络、HTTP 或 payload 失败时保留它们并显示包含 endpoint、
HTTP status 和重试动作的错误，但不得回显响应正文或底层异常文本。相同 endpoint/protocol 的更新
失败保留旧缓存；endpoint/protocol 改变时先清空不再可信的缓存。`/login` 本身从不选择新模型。

### 7.2 `/model`、动态分发与 `/logout`

`/model` 只在 candidate menu 列出“存在凭据且模型发现缓存有效”的 provider 模型，每项以
`provider-id/model-id` 唯一标识，同时显示其 `ModelRef.api`。选择后才按顺序完成:

1. 从 registry 解析完整 `ModelConfig`，包含真实 `ModelRef.api`、baseURL、key，以及目录中
   明确存在的 limits；Custom 的标准 `/models` 没有可信 limits 时继续显示 `limit unknown`；
2. `coda models --select` 只把已验证的 provider/model 写为 CLI-edge 的最近显式选择，不构造
   Runtime、不 attach/create/resume thread，也不写 journal；下一次真正启动任务时由 composition root
   把完整 `ModelConfig` 交给 Runtime。交互 TUI/classic/accessible/plain 的 `/model` 只在 idle 时经
   `InteractiveRuntime`/RuntimePort 的模型配置适配更新下一次采样；若尚未 attach，该动作会按既有
   runtime 语义立即 create/attach thread。只有 CLI-edge `coda models --select` 保证零 thread、零 journal；
3. 成功后记住这次用户显式选择并静默更新 footer；当前模型已经由右下角持续显示，不得再向
   transcript/普通输出追加“已选择 …”成功消息。若只持久化最近选择失败，当前切换仍有效并
   明确警告下次启动可能无法恢复。

阶段 3 后每次 provider 调用都由 `ProviderAdapterRegistry` 的 turn snapshot **按当次
`model.ref.api`** 解析到版本化 adapter；CLI 只在 runtime 创建/配置时注册已有
`openai-chat`、`openai-responses`、`anthropic-messages` adapter，不执行静态 switch，也不能按
provider id 或上次选择猜协议。一个 turn 捕获 adapter 后，注册表热更新只影响下一 turn；未知 api
按 StreamFn 铁律产生流内 error。切换不改写 thread meta 或历史消息；每条 assistant 继续记录实际
采样所用 `ModelRef`，transform 层据此处理跨模型 reasoning。

`/login` 更新当前 provider 的 key 时，只要当前模型的 endpoint/api 仍相同且刷新后仍可用，就把
新凭据换入活动配置但不改变显式选择；否则清除当前选择并要求重新 `/model`。`/logout` 按名称或
编号删除目标 provider 的 key，保留非秘密配置和模型缓存；若它是当前 provider，同时回到未选择
状态。三条管理命令只允许在 `idle` 执行，running/retrying/compacting 时统一提示先完成或
abort。

启动只恢复 `providers.json` 中最近一次**用户显式选择**，且必须仍能由当前配置、凭据与缓存完整
解析；失效就保持未选择，不回退任何硬编码默认模型。无选择的交互冷启动不创建带占位
`ModelRef` 的 Runtime/thread，普通 prompt 会提示先 `/login` 再 `/model`。

### 7.3 旧式 flags / env / config 兼容入口

脚本和已有配置仍支持逐字段优先级
**flags > 环境变量 > `~/.coda/config.json`**，但末尾不再有内置默认模型:

| 配置项 | flag | 环境变量 | config.json 字段 |
|---|---|---|---|
| 模型 | `--model` | `CODA_MODEL` | `model` |
| baseURL | `--base-url` | `CODA_BASE_URL` | `baseURL` |
| apiKey | `--api-key`(不推荐,进程列表可见) | `CODA_API_KEY`;OpenAI 回退 `OPENAI_API_KEY`;Anthropic 回退 `ANTHROPIC_API_KEY` | `apiKeyEnv`(推荐)/ `apiKey`(明文,警告) |

只有显式 model 才产生旧式 `ModelConfig`；只写 `--provider` 不会生成占位 model。`faux` 是测试
例外，显式 `--provider faux` 可使用其确定性 `faux` model。key 在来源边界去除首尾空白；
`apiKeyEnv` 一旦非空，就是 config 层唯一 key 来源。交互 TTY 可以在旧式配置缺 key/模型时进入
无选择状态；`--json`、`-p`、裸 prompt 与管道模式没有配置对话，必须在 Runtime/thread 创建前
fail-fast，并提示进入交互终端执行 `/login`、`/model` 或补齐对应环境变量。非交互调用已经由
旧式入口解析出完整 `ModelConfig` 时不读取 provider registry，损坏的交互配置不能阻断脚本。

## 8. 边界情况

- **非 TTY stdin**(`echo "..." | coda`):自动等价 `-p` 模式读完 stdin 作为 prompt;`--json` 显式给出时按 headless 协议解析。
- **粘贴多行文本**:OpenTUI Textarea 与 classic 都启用 bracketed paste,粘贴换行不发送;审批期间整段 paste 被输入边界拦截,不能把首字符误判为 `y` / `a` / `n`;不支持 bracketed paste 时是终端自身的已知限制。
- **窗口 resize**:OpenTUI 重跑 Yoga 布局；首次交互前宽度不足依次收起 tips、Logo、model，首次交互后
  始终使用紧凑 header，resize 不恢复 onboarding 装饰。prompt 按新宽度重测软换行并增高或缩回；
  transcript 用 stable block anchor 恢复相同逻辑位置，内容顺序不变，composer 始终在底部。
- **CJK / emoji 宽字符**:OpenTUI native buffer 负责全屏分支的列宽;程序化设置输入历史后调用 Textarea 的 buffer-end API,不能用 JavaScript UTF-16 `string.length` 猜光标列。classic 动态区继续用仓库的 `displayWidth`/截断实现。
- **过小终端**:低于 10 行进入 ultra-compact,按 §1.2 的优先级逐级隐藏装饰与状态行；高度 1 时普通输入仍保留视口内光标,审批则隐藏输入并只显示决议键位。裁切不能产生屏幕外的 visible cursor,也不能让非空 draft 隐藏审批操作。
- **Windows**:OpenTUI 依赖对应 win32 native optional package；`TERM=dumb`/非 TTY auto 路由到
  append-only accessible，只有双 TTY 的 OpenTUI 初始化失败才降级 classic；显式 `--ui=plain` 也可
  避开 raw/alternate screen。只承诺现代 Windows Terminal。
- **恢复转录**:`--continue` / `--resume` 可以先记住目标 `ThreadId`（旧 session id 确定性映射）；有
  有效模型时在显示 UI 前提交 resume，没有模型时延迟到 `/model` 后 attach，再用
  `runtime.getThreadSnapshot()` 返回的 committed `AgentMessage` view hydrate，不直读 repository、
  不伪造生命周期事件且不自动启动 run。assistant 的多 text/reasoning
  part 按原顺序分块；历史 tool call 必须从参数恢复工具摘要；plan tool result 从 `details.steps`
  恢复最新 plan,失败结果仍可见。初始化/重放失败必须 destroy OpenTUI 后才允许降级 classic。
- **终态兜底**：`prompt` / `continue` 的 canonical `op_completed` 是 root activity 已收束的权威边界。
  若 abort、provider 异常或 legacy adapter 竞态导致其前面没有可投影的最终 `agent_end`，
  `RuntimeFrontendSession` 必须由该 envelope 清除 active phase，并仅为旧 TUI/classic/plain surface 投影
  一次 terminal fallback；不得继续显示 running。已带 `expectedRunId` 的 abort 若恰好在此边界后返回
  `stale_run`，按幂等成功静默收束，不能显示误导性的 warning。
- **presentation state**：create 交互路径在 attachment 前打开稳定 frontend-only pending key，显式
  resume 则直接打开目标 `ThreadId` 的
  `<runtimeRoot>/presentation-v1/<sha256(workspaceId)>/<sha256(threadId)>.json`。ordinary draft 最多
  200ms 合并写；stash/restore、Vim preference 与正常退出同步 flush；同目录 0600 临时文件经 fsync、rename
  和目录 fsync 提交。身份只作 hash，不成为路径段；损坏/错配文件 quarantine 后以空状态恢复。该文件只含
  draft/stash/scroll/unread/search/expanded/panel/Vim，不含 thread/run/approval/usage/permission 或任何
  provider 表单字段。durability barrier 失败时不得先改内存状态或清 composer；必须显示清洗后的错误，
  保留可重试 draft/stash，并让退出返回非零。pending key 绝不提交给 Runtime，因而未选模型仍为零
  thread/journal；attachment listener 将它先写入真实 thread 文件、清空源后再切换 owner。Ctrl+O 与
  palette/slash `/edit` 在外部编辑器返回前都保留原 composer/store draft，只有成功结果才能替换。
- **thread switch 与后台 run**：frontend 初始化时建立 workspace-wide subscription，并为 catalog 中每个
  thread 以 high-water cursor 接续。switch/new/fork/retry 必须先对源 presentation 做严格同步 flush；失败时
  不得调用 Runtime action，当前 thread、画面和审批队列保持不变。action 成功后再切换 presentation owner、
  splice 目标 snapshot/live buffer，并重新以目标 canonical user transcript 替换 Ctrl+R history，最后恢复
  目标 draft/scroll/unread/panel 与 pending approval；源 run 不 abort/close。目标 presentation 投影失败或
  resume/new 失败时回滚到原 attachment 并重新 hydrate/恢复源 presentation，而不是留下半切换 view。
  classic 的 attachment listener 是 transcript replay 的唯一来源，switch handler 不再重复打印 raw transcript。
  隐藏 thread 的 envelope 只更新 per-thread
  cursor 和对应 op waiter，不污染当前 transcript/phase；再次切回时以 snapshot 补全。
- **运行中的 archive**：`/archive off` 是可逆 metadata 恢复，可在 run 中执行，不能被 Enter 路由成 steer；
  `/archive` 或 `/archive on` 仍交给 Runtime 对 active run/control 返回精确 `thread_busy`，UI 不自行改写事实。
- **diff/review**：workspace Git port 缺失或失败时明确显示 unavailable/error，不由 UI 回退到 `git`
  子进程。viewer 保存完整 patch；普通 transcript 的兼容截断摘要不等于 canonical diff。所有路径、patch、
  tool output、session title/preview 和审批字段进入 frame/文本前仍经过共享 sanitizer。
- **审批决议可用性**：现代 `ApprovalPresentation.allowAlways` 缺失时，TUI footer、classic 动态提示和
  accessible 文本提示都不展示 `a`；即使用户手工输入 `a`/`/allow-always`，也只显示 unavailable，pending
  card/queue 保持不变且不提交无效 response。没有 presentation 的 legacy request 保留既有 `a` 兼容输入。

## 9. 验收清单

- [ ] 构建产物 `-h/--help/-V/--version` 在损坏配置与不可写 HOME 下仍 stdout-only、exit 0，且不读写
  配置/目录、不注册 signal、不加载 provider/OpenTUI、不联网；usage error stderr-only、exit 2，并提供
  typo suggestion 或一条可复制的互斥修复命令
- [ ] help、completion、CLI/slash 候选和 TUI/classic/accessibility `/help` 只来自统一 command catalog，
  且 surface-specific 帮助不声称不存在的键位
- [ ] `doctor/auth/models/sessions/exec` 的人类与 JSON 输出、退出码、零 thread/journal 边界有进程级门禁；
  `sessions` 只调用 RuntimePort catalog query，`exec` 与旧 one-shot/legacy NDJSON 等价
- [ ] `--ui=auto|tui|classic|accessible|plain` 路由可机械验证；accessible/plain append-only 且不开
  raw/alternate screen/mouse/animation，显式 tui 不静默降级
- [ ] 导入 public runtime entry 不读 env/config、不创建文件、不注册 signal、不加载 provider/OpenTUI；CLI 只在显式工厂后产生副作用
- [ ] TUI/classic/plain/headless 的 prompt/steer/follow-up/abort/control 都只提交 RuntimeOp，不直接调用 Agent/Session
- [ ] 默认 `--json` 的 protocol hello 与裸 SessionEvent 逐行兼容阶段 0；`--event-format=envelope`
  输出完整 identity/per-thread seq 的事件以及每个可解析 op 的唯一 receipt frame
- [ ] envelope 模式可交错驱动两个 thread，renderer 用 `(threadId, seq)` 保序去重，任一 thread abort 不改变另一个 thread
- [ ] headless stdout gate 只阻塞自身输出泵，不拖慢 Runtime；shutdown 仍等待队列 drain 后退出
- [ ] 100×30 下 header 含版本/Logo/tips;首条 user/assistant 紧跟中区顶部,短内容下方留白而不是贴 footer
- [ ] 长输出填满中区后自动跟尾；PageUp 或鼠标滚轮上滚后不抢回并累积 unread，PageDown 到底、End 或
  `/latest` 可回到最新内容并清 unread
- [ ] native framebuffer 与整个视图树都保持 alpha 0,header、transcript、Markdown、prompt 与 footer 不绘制任何实色背景
- [ ] prompt 为透明双横线,没有左右边/圆角/title；默认 1 行并随显式/软换行增高(空间允许时最多 8 行),内容缩短后缩回；Textarea 聚焦时显示高对比品牌红色闪烁原生竖线,组件失焦时隐藏,终端窗口失焦时允许模拟器显示空心 inactive cursor；点击输入区可恢复组件焦点；正常高度下其后恰有 task、workspace 与 context/model 三行
- [ ] 输入 `/` 或 Ctrl+K 时 palette 在 prompt 正上方显示 category、命令、参数、快捷键、说明/disabled 原因；name/alias/description/category 模糊搜索大小写无关，窄屏可隐藏说明但不丢候选
- [ ] palette 中 `↑/↓` 循环选择,`Tab` 补全但不发送,`Enter` 补全后执行,`Esc` 返回原 draft；running/retrying 的 read-only/presentation 命令可执行，provider/quit 保留 disabled 解释且不作为 steering
- [ ] 首次输入/提交后 9 行 onboarding header 收缩为 3 行 taskbar；resize 宽→窄→宽后 prompt 按软换行增高再缩回，Logo/tips 不重新弹回；非空多行 draft 下审批 footer 与黄色横线仍可见,决议后恢复 workspace/洋红横线
- [ ] 9→7→5→3→2→1 行的 ultra-compact 降级中光标不越界；1 行审批优先显示 y/a/n/Esc 并隐藏输入光标
- [ ] 流式输出期间输入框稳定;Enter 后出现 steering 回显,Shift+Enter 只插入换行
- [ ] retry backoff 期间 Enter 入 steering 队列、Esc 取消重试；compacting 期间 Enter 的 prompt 在压缩完成后启动
- [ ] `Esc` 不与方向键冲突;流式中裸 Esc 一次 abort,assistant 以 `[aborted]` 收尾
- [ ] `Alt+Enter` 与 `/f ` 前缀均能入 follow-up 队列(至少各在一种终端验证)
- [x] Ctrl+R 从恢复 transcript 搜索当前 thread 历史；Ctrl+O 外部编辑、Meta+S stash、`@` Tab、
  `/draft`、`/vim` 在 TUI/classic 可用，accessible/plain 有同语义文本命令
- [x] presentation v1 按 workspace/thread 隔离并使用 0600 atomic file；draft/scroll/search/Vim 跨
  resize/reopen 恢复，显式 stash durable；故障注入下 stash/restore/flush/dispose 不清输入、不伪报成功；
  provider 的普通字段与 secret 对 task draft/store/history/frame/transcript/log 都保持隔离
- [x] `/search`/next/previous/latest、`/copy latest|raw` 与 exclusive `/export` 在 TUI/classic/text 共享
  parser/actions；导出不覆盖已有文件，终端控制序列不能借 copy 状态或错误回到 human surface
- [x] UX3 command catalog 与 TUI/classic/accessible parser 提供 review/diff/permissions/compact、session
  管理及 fork/retry；所有业务动作只经 RuntimePort，Git/repository 不被 UI 直读
- [x] reasoning 默认折叠；工具显示目标/状态/耗时/摘要，Runtime review 可展开完整 args/output；diff
  viewer 保留 staged/unstaged/untracked/turn 完整 patch，并支持文件、滚动和 scope 切换
- [x] session picker 搜索完整 catalog 的状态/时间/workspace/cwd/preview；跨 thread 切换保留独立
  draft/scroll/unread，后台 run 继续，new/switch 失败回滚，approval/abort 只作用于当前目标
- [x] approval card 默认折叠，展开值只来自 identity-bound `ApprovalPresentation`；legacy scope 缺失时
  明确 unavailable，不从工具参数/命令推导；manual compact 与 fork/retry 有 journal/recovery 门禁且不
  声称回滚文件或 shell 副作用
- [ ] `coda --continue` 重放转录后,tool 摘要、最新 plan 与 plan error 都保留,新输入接在原上下文继续
- [ ] 模型/工具/持久化文本中的 CSI/OSC/DCS 与 C0/C1 控制字符不会进入帧或终端标题
- [ ] 无 `COLORTERM` 的 256 色双 TTY 中首帧使用 SGR 49,且不输出 `48;2` / `48;5` 实色背景
- [ ] TUI 正常退出、fatal、审批中 abort 与初始化失败四条路径都恢复主屏/raw mode；初始化失败后 classic 无双重输入
- [ ] CLI/TUI/classic 的登录入口都显示 OpenCode Go、OpenAI、Anthropic、Custom 与 disabled OAuth；
  TUI 与 slash command 复用输入框上方的 `→` candidate menu，以 `↑/↓` 选择、`Enter` 确认且不要求
  数字输入，classic 保留编号/名称兼容；`Esc` 逐级静默返回、根步骤静默退出且秘密回退先清 key；
  CLI/TUI/classic 表单持续显示字段/步骤/返回方式；普通 provider 字段不覆盖任务 draft，秘密输入只显示
  掩码且不进 history、draft、frame、事件、转录或日志
- [ ] OpenCode Go 的实时 models 与显式协议表取交集；表外 id 不可选；多个 custom provider 可按大小写不敏感名称更新并分别 `/logout`
- [ ] `/login` 不切模型；`/model` 以 provider/model 选择并由 `ProviderAdapterRegistry` snapshot 按 `ModelRef.api` 动态分发；运行中三条管理命令只提示完成或 abort
- [ ] 同一 provider 的旧模型刷新迟到时因 revision CAS 被丢弃，不回滚新 endpoint/key
- [ ] `/login` 模型刷新中退出会取消请求，并等待 controller 收束后再销毁前端
- [ ] 零配置冷启动没有 Runtime/thread；失效的最近选择保持未选择，不恢复硬编码默认；`/model` 后才 create/resume 并重放历史
- [ ] `coda --json` 下:乱输入一行非 JSON 不退出;`prompt`-running 冲突返回 non-fatal error 事件;`shutdown` 在运行中先 abort 再 flush 退出,exit code 0
- [ ] `--json` 的 stdout 每一行都能被 `jq .` 解析(管道纪律)
- [ ] 旧式配置优先级:同时给 flag/env/config 三处不同 model,生效的是 flag;全部去掉后不产生默认模型
- [ ] 非 TTY 管道输入自动走一次性模式;`NO_COLOR` 下不出现 coda 自定义调色

## 相关文档

- [03-internal-protocol.md](./03-internal-protocol.md) —— RuntimeOp、EventEnvelope 与 legacy SessionEvent 投影
- [06-steering-following.md](./06-steering-following.md) —— Enter=steer / Alt+Enter=followUp 背后的队列语义
- [08-session-persistence.md](./08-session-persistence.md) —— `--continue` / `--resume` 依赖的会话存储与恢复
- [10-testing.md](./10-testing.md) —— 基于 `--json` 管道的 e2e 测试方案
- [12 Supervisor Runtime](./12-supervisor-runtime.md) —— RuntimePort、identity、per-thread seq 与兼容矩阵
