[← 返回地图](./README.md)

# 09 CLI / TUI:交互模式、流式渲染、键位与 headless JSON 模式

CLI 是整个系统里**最薄**的一层:运行期把用户输入翻译成 `Session` 门面调用(`prompt` / `steer` / `followUp` / `abort`),把 `SessionEvent` 流翻译成终端像素；交互配置期则用同一个 provider 命令状态机驱动 TUI/classic。所有智能都在 agent/session 核心；provider registry 只持久化认证配置、模型发现缓存和最近一次显式选择，不进入会话事实流，也不理解 provider wire。headless JSON 模式(见第 6 节)继续机械验证运行期纪律——**已有 `Session` 的交互都由同一组方法或一行 JSON 命令表达**。

## 1. 交互形态:Bun + `@opentui/core`

### 1.1 模式分派与依赖边界

双 TTY 的默认交互面是 `@opentui/core` 0.4.x 全屏 TUI。OpenTUI 只在确认进入该分支后动态导入,所以脚本路径不加载 native 包:

| 条件 | 前端 |
|---|---|
| `--json` | `startHeadless()`;stdin/stdout NDJSON |
| `-p`、裸 prompt、非 TTY stdin | plain `Renderer`;跑完退出 |
| stdin/stdout 都是 TTY 且 `TERM != dumb` | `startTui()`;alternate screen |
| 双 TTY + `TERM=dumb` | classic readline/raw TTY + ANSI `Renderer` |
| OpenTUI 初始化失败 | 清理 OpenTUI 后降级 classic；provider 命令仍完整可用 |
| stdin 是 TTY、stdout 非 TTY | classic 输入 + plain 追加输出 |

OpenTUI 与 classic REPL 不能同时存在:二者都会接管 raw stdin/stdout。`main.ts` 因此必须在创建 stdout FileSink/legacy renderer **之前**选择 TUI。没有额外的 `--classic` 开关；初始化失败时先完整销毁 OpenTUI，再自动进入 classic。二者共用 `ProviderCommandController`，所以没有 API key 或模型也能在任一交互面完成 `/login` → `/model`。生产构建保持 `Bun.build({ packages: 'external' })`;运行时安装当前平台的 OpenTUI optional native package。`--json`、`-p` 和管道协议不因 TUI 发生任何变化。

### 1.2 全屏布局与顶部起排不变量

TUI 进入 alternate screen，组件树固定为:

```text
root column (100% × 100%)
├── header:版本 + Unicode 像素 Logo + tips
├── transcript:ScrollBox(flexGrow:1)
└── composer
    ├── candidate menu:slash/provider 候选(从 prompt 向上展开)
    ├── prompt:top rule + auto-growing transparent Textarea + bottom rule
    ├── workspace
    └── context usage                         provider/model
```

- **header**:从 `package.json.version` 取当前版本;Logo 是 ImageGen 参考图
  `assets/branding/coda-pixel-logo-reference.png` 的 6 行 Unicode block 复刻,运行时不读 PNG、不依赖终端图片协议。header、brand、Logo 与 tips 都不绘制背景色,直接透出终端背景。
- **transcript**:assistant Markdown、user/steering/follow-up、工具进度、diff、plan 与告警按事件顺序向下排列。关键配置是 `contentOptions.flexDirection:'column'`、`justifyContent:'flex-start'`、`minHeight:'auto'`;禁止 `column-reverse` / `flex-end`。短内容从中区第一行向下增长,不是 pi 风格从 prompt 上方向上堆。`stickyScroll:true, stickyStart:'bottom'` 只在内容溢出后跟随尾部;用户手动上滚时暂停跟尾。
- **composer**:固定在屏幕底部。输入区是透明 Textarea,只绘制洋红色 single top/bottom rule,没有左右边、角、title、bottomTitle 或 idle placeholder；Textarea 聚焦、可见且不在审批状态时,使用 OpenTUI 原生硬件光标显示固定高对比品牌红色、持续闪烁的竖线。renderer 的全局鼠标自动聚焦保持关闭,将组件焦点策略明确收敛在输入框；Textarea 自己响应鼠标按下,组件失焦时原生光标隐藏,点击输入区可重新聚焦。终端窗口失焦不改变 Textarea 的逻辑焦点,由终端模拟器把仍可见的原生竖线显示成 inactive/hollow rectangle；切回终端后自然恢复竖线并可直接继续输入。空输入默认只显示 1 行,显式换行或按当前宽度产生软换行时自动增高,内容缩短或终端变宽时自动缩回；空间允许时最多显示 8 行并把超出内容交给 Textarea 内部滚动。布局优先为 transcript 保留至少 1 行真实内容；有空间时连同上下 padding 共保留 3 行,不能让长 draft 吞掉全部模型输出。working/retrying/compacting 与双击退出提示只在输入为空时借单行 placeholder 显示。审批是例外：prompt 横线变黄,第一条 footer 暂时从 workspace 切成始终可见的 `Approval … y/a/n/Esc`,即使已有 draft 也不能隐藏键位；draft 冻结且编辑光标隐藏,决议后原样恢复 workspace、draft 与光标。正常状态下 prompt 下方严格两行:第一行 workspace(可带 Git branch),第二行左侧当前 `usage.contextTokens`、右侧当前 `ModelRef`；冷启动没有模型时右侧明确显示 `no model selected`。只有 `ModelConfig.limits.context` 明确存在时才显示百分比;缺上限显示 `limit unknown`,不得按模型名猜窗口大小。
- **candidate menu**:slash 命令和 provider 枚举步骤复用 prompt 正上方的同一个透明候选层，视觉对齐 pi 的 SelectList：`→ ` 标出当前项，名称占左列，说明占右侧 muted 列；窄屏隐藏说明但保留完整键盘能力。输入内容严格处于 `/prefix`(首字符是 `/`、命令名内尚无空白/换行)时，候选按大小写无关的命令名/别名前缀匹配；空闲/compacting 显示 canonical `/help`、`/queue`、`/status`、`/login`、`/model`、`/logout`、`/followup`、`/quit`，running/retrying 只显示 `/followup`。运行中手工提交三条 provider 管理命令仍会进入控制器并给出“先完成或 abort”的提示，不会作为 steering 发给模型；其他空闲命令仍按普通 steering 处理。兼容别名 `/f`、`/q` 继续可输入，但不重复占候选行；对别名按 `Tab` 会展开成 `/followup `、`/quit `。slash 候选中 `↑`/`↓` 循环选项，`Tab` 采用当前项并补一个空格但不发送，`Enter` 采用当前项后在同一次按键中继续正常提交，`Esc` 仅收起候选且保留 draft。
- **provider 候选**:`/login` 的登录方式和 provider、Custom 协议、`/model` 模型、`/logout` provider 都由共用状态机把结构化 `value/label/description` 交给同一 candidate menu；空输入显示候选，输入文本可按 label/value/description 大小写无关过滤，`↑`/`↓` 循环选择，`Enter` 直接确认当前项，不要求输入数字。`Tab` 不确认 provider 选项；`Esc` 静默回到上一步，例如 provider 列表回到 OAuth/API key，Custom 协议回到 API key。离开秘密步骤时必须先清空 UI 秘密缓冲；协议步骤中已经暂存在 controller 的 key 也要在回退时清空。到达 `/login`、`/model` 或 `/logout` 的根步骤后再按 `Esc` 才静默退出流程，不打印“已取消”。秘密输入和 name/base URL 等自由文本步骤不显示候选。审批期间所有候选隐藏。
- **候选布局**:候选占用 composer 上方空间，一次最多显示 8 项；项目更多或空间不足时围绕当前项裁切，同时仍优先保留 1 行输入与可用时 1 行 transcript。
- **响应式**:窄屏先隐藏 tips,再隐藏 Logo和右侧 model；状态 placeholder 与审批 footer 切换为紧凑文案。resize 必须按新宽度重新测量软换行并同步 prompt/composer 高度。低于 10 行进入 ultra-compact:隐藏 header,随后按可用高度依次移除 transcript padding、transcript、runtime、workspace 与一条/两条 prompt rule；普通输入的光标始终留在 viewport 内,审批时则优先保留审批 footer,必要时隐藏输入和光标。
- **主题**:整个 TUI 的 native framebuffer 与视图树背景都固定为 `RGBA(0,0,0,0)`。页面、header、ScrollBox 的 root/wrapper/viewport/content、动态转录、Markdown、composer、Textarea 普通/聚焦态和两行 footer 都必须显式保持 alpha 0,不能由任何子层重新画出实色块。OpenTUI 0.4.5 的运行时构造器尚不读取 `backgroundColor` 配置,所以生产初始化除传入透明配置外,还必须无条件调用 `renderer.setBackgroundColor(...)` 同步 native framebuffer；该行为不受 `NO_COLOR` / `--no-color` 控制。ANSI 终端没有逐单元格 alpha 协议,这里的“透明”表示输出 SGR 49、使用终端 profile 的默认背景；若终端窗口本身启用了透明效果即可透出桌面,否则仍显示该 profile 的背景色,alternate screen 也不会透出先前 shell 的字符。正文与输入文字使用终端默认前景色以适配明暗主题；硬件光标固定使用 `#c94740`,因为 OpenTUI 0.4.5 的 native cursor 路径忽略 default intent,否则会在白色背景上退化成不可见的 `#ffffff`。accent/muted/success/warning/danger/cyan 仍是 coda 语义色；`NO_COLOR` / `--no-color` 移除文本和边框的自定义前景色,但保留这一个用于焦点可见性的光标色,背景始终保持透明。

OpenTUI 是这一分支的唯一终端写入者和键盘焦点管理者。`exitOnCtrlC:false`、`exitSignals:[]` 让 CLI 在销毁 alternate screen 前先执行 `abort → approval.onAbort → Session.close()`;`destroy()` 恢复 raw mode、鼠标与主屏。`NO_COLOR` / `--no-color` 禁用 coda 的内容与边框语义色,但保留用于焦点可见性的硬件光标色,且不改变布局和键位。

所有来自模型、工具、仓库、配置与持久化会话的文本都按不可信终端输入处理。进入 Text/Markdown、状态栏、工具摘要或 diff 前统一经过 `sanitizeTerminalText`:剥离 ANSI CSI/OSC/DCS/APC/PM/SOS 序列,移除除 `\t` / `\n` 外的 C0 与全部 C1 控制字符。终端标题再经过 `sanitizeTerminalTitle` 把 tab/newline 折成单行；不得依赖组件转义来阻止 OSC 52、标题注入或隐藏控制字符。

### 1.3 classic / plain 保底

`renderer.ts` 与 `repl.ts` 仍是受支持的降级面:classic 用 readline/raw TTY compatibility + ANSI 动态区;plain 是纯追加输出。它们同时服务 `TERM=dumb`、非 TTY 与一次性路径,不能删除。classic 与 TUI 共用 provider 命令状态机；controller 提供同一份结构化候选，TUI 渲染 candidate menu，classic 则把它们打印成编号列表并接受编号或名称。秘密步骤只把等长 `•` 掩码交给 renderer，真实 key 不进入输入历史、transcript、`SessionEvent` 或日志。classic 的单写入者、stdout 有序 FileSink、动态区宽度清洗与写失败收尾契约保持不变;TUI 则由 OpenTUI 自己调度帧,不经过这个 FileSink。

## 2. 启动流程与会话选择

```
coda                    # 新会话
coda -p "..."           # 一次性:发送 prompt,跑完以 plain 输出退出
coda --continue         # 恢复最近一个会话
coda --resume [id]      # 无 id 时列出 ~/.coda/sessions/ 供选择(编号 + 首条 prompt 摘要 + 时间)
coda --json             # headless JSON 模式(第 6 节)
coda --provider openai-responses  # 使用 OpenAI Responses adapter
```

`--provider` 的内置值为 `openai-chat | openai-responses | anthropic-messages | faux`。两个 OpenAI
值都读取 OpenAI key，但产生不同的 `ModelRef.api` 并分发到不同 `StreamFn`；CLI 不读取或转换
任何 Responses wire 事件。

旧式 flags/env/config 仍作为显式非交互配置入口；交互主路径另读 provider registry。启动组装顺序(伪码):

```ts
const interactive = stdin.isTTY && !flags.json && flags.prompt === undefined;
const legacy = resolveConfig(flags, env, readConfigFile(), {
  allowMissingApiKey: interactive,
});
const registry =
  interactive || legacy.modelConfig === undefined
    ? new ProviderRegistry()                            // providers.json + credentials.json
    : undefined;                                       // 完整旧式非交互配置不依赖 registry
const initialModel =
  legacy.modelConfig !== undefined
    ? (hasRequiredKey(legacy) ? legacy.modelConfig : undefined)
    : registry?.resolveSelectedModel();
const streamFn = createProviderStreamFn();              // 按每次调用的 model.ref.api 分发
const projectRules = new ProjectRules({ cwd });
const createSession = (model: ModelConfig) =>
  resuming
    ? Session.resume(sessionId, {
        agentConfig: {
          streamFn, model, tools, systemPrompt,
          transformContext: (ctx) => projectRules.inject(ctx),
          beforeToolCall: composeRuleGateBeforeApproval(projectRules, approval),
        },
      })
    : Session.create(/* 同一份 options */);

if (!interactive) {
  if (!initialModel) exitWithLoginAndModelHint();       // Session 创建前 fail-fast
  const session = await createSession(initialModel);
  if (flags.json) return startHeadless(session, ...);
  return runOneShotWithPlainRenderer(session, ...);
}

const runtime = new InteractiveRuntime({ initialModel, createSession });
await runtime.initialize();                             // 无模型时保持零 Session
if (stdinIsTty && stdoutIsTty && TERM !== 'dumb') {
  try {
    const { startTui } = await import('./tui.js');     // native 依赖只在这里加载
    return await startTui(runtime, approval, {
      cwd, model: runtime.currentModel(), version: packageJson.version,
      providerCommands: { registry, runtime },
    });
  } catch (error) {
    logTuiFallback(error);                             // startTui 已恢复终端
  }
}
return startRepl(runtime, createClassicRenderer(...), approval, {
  providerCommands: { registry, runtime },
});
```

`InteractiveRuntime` 是可空 Session 门面：没有有效选择时 `messages=[]`、usage 为零，prompt 给出 `/login` → `/model` 的可执行提示；只有 `/model` 成功或最近一次**用户显式选择**仍有效时，才调用工厂 create/resume。Agent 仍由 Session 内部组装并持有(见 [08-session-persistence](./08-session-persistence.md) 第 1–2 节),CLI 订阅的是 Runtime/Session 而非 Agent——这样 `retry_scheduled` / `compaction_start` 等 SessionEvent 才能透传到 UI。延迟 attach 时先建立事件转发，再向前端重放恢复转录。落盘监听在 UI 监听之前。TUI 监听器只同步更新组件树,OpenTUI 按 `maxFps:30` 合并绘制;plain/classic 监听器继续在每个事件后等待 stdout `drain` 施加背压。审批事件由 `ApprovalBroker` 的旁路订阅送进同一前端。

并发的首次模型选择复用同一个 Session 创建 Promise；工厂尚未返回时 `close()` 等待并关闭其
结果，Session 一旦提交则直接关闭，不能反向等待可能在 attach callback 内调用 `close()` 的
同一通知链。Session 事件与 attach callback 均逐个隔离失败。Provider command 的 submit
Promise 也必须先发布再进入 view/registry 回调，退出只等待这份已发布任务。

### 2.1 项目规则感知(`AGENTS.md`)

项目规则属于 CLI 组装层的文件系统策略，不新增 `Context` / `AgentMessage` /
`SessionEvent` 字段，也不改变 headless 外协议。`ProjectRules` 从物理 `cwd` 向上查找最近的
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

注入挂在异步 `transformContext`，只改当次出站 `Context.systemPrompt` 的副本；规则正文绝不
变成 user/tool 消息，因此不会进入 transcript、session JSONL、恢复回显或 compaction
摘要。每次模型采样都重新扫描文件，不依赖启动期缓存；文件新增、修改或删除后，下一 turn
看到新结果。

执行前门禁复用既有 `beforeToolCall`，且顺序固定为 **项目规则 gate → approval policy**：

- `edit` / `write` 的目标作用域是 `path` 所在目录；
- `bash` 的基础作用域是最终执行 `workdir`，缺省为启动 `cwd`；CLI cwd 与 workdir 先物理化，
  相对 workdir 在规则分析、approval 与真实 `Bun.spawn` 三处都以同一 cwd 为基准。分析器
  还跟踪 literal `cd`、`git` / `make` / `ninja` / `tar` / `pnpm` 等确有目录语义的 `-C`、
  输入输出重定向、显式路径和现存裸目录参数；失败的 `cd` 后保留旧/新 cwd 并集。动态展开、
  shell group/control flow、脚本、`eval` / `source` / `sh -c`（含 `env` / `sudo` /
  `nohup` / `timeout` 等 runner 包装）、`git apply` 等无法确定目标的命令由规则 gate
  回喂可恢复错误，要求改用明确 workdir/literal path 或拆成 `edit` / `write`；
- 首次触达更深目录，或规则在本次模型请求之后发生变化时，本次调用先返回一条可恢复的
  isError tool result，不执行副作用；紧接的下一 turn 注入完整新规则，模型审阅后重试；
- loop 会先串行 preflight 整批调用，因此三个工具在真正 `execute` 边界再做同一检查；同批
  较早的命令若改写 `AGENTS.md`，后续写操作不会在旧规则上下文中漏执行；
- 若目标没有新增有效规则，调用直接进入原审批/执行路径，不额外消耗 turn。

资源护栏为单文件 **32 KiB**、最终规则区块估算 **16K tokens**；预算包含标题、source /
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
总预算超限经 CLI-local warning 旁路报告；同一 turn 的 preflight / execute 复检去重，
故障恢复后再次出现仍会重新报告：
OpenTUI 走 `TuiScreen.println`，TTY classic 走 renderer，plain / headless / 一次性走清洗后的 stderr。
所有文本先移除 ANSI/OSC/C0/C1，warning 不伪造 `SessionEvent`，因此不进入 stdout
NDJSON、transcript 或 session JSONL，也不会把任务升级为 fatal。

## 3. 键位表

| 状态 | 键 | 行为 |
|---|---|---|
| 空闲 | `Enter` | 发送输入(`session.prompt(text)`) |
| 任意输入 | `Shift+Enter` | 插入换行,不发送 |
| 任意 | `Ctrl+C` | 输入非空:清空输入行;输入为空:提示「再按一次退出」,1.5s 内再按退出 |
| 空闲 | `Ctrl+D` | 输入为空时退出 |
| 任意 | `Meta+↑` / `Meta+↓` | 输入历史(普通方向键留给多行编辑) |
| slash menu | `↑` / `↓` | 循环选择前缀匹配的命令 |
| slash menu | `Tab` | 补全当前命令并追加空格,不发送 |
| slash menu | `Enter` | 采用当前命令并立即按当前 phase 的 Enter 语义发送 |
| slash menu | `Esc` | 关闭候选,保留输入；后续 Esc 才进入 abort/退出语义 |
| provider candidate menu | `↑` / `↓` | 循环选择当前 provider 步骤的候选 |
| provider candidate menu | `Enter` | 确认当前候选；不要求输入编号 |
| provider 子流程 | `Esc` | 静默返回上一步；离开秘密步骤时清空 key |
| provider 根步骤 | `Esc` | 静默退出流程，不打印取消提示 |
| 流式中 | `Enter` | 当前输入入 **steering** 队列(`session.steer(text)`) |
| retry backoff | `Enter` | 当前输入入 **steering** 队列,等待重试 turn 消费 |
| compacting | `Enter` | 按空闲语义调用 `session.prompt(text)`;Session 在 compaction 完成后启动 |
| running / retrying / compacting | `/login`、`/model`、`/logout` + `Enter` | 不进入模型上下文；提示先完成或 abort，保持原状态 |
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
- 其余空闲斜杠命令:`/login`、`/model`、`/logout`、`/quit`(兼容 `/q`)、`/queue`、`/status`、`/help`。TUI 的 canonical 目录与隐藏别名都由 `repl.ts` 中的 `SLASH_COMMAND_SPECS` 驱动；别名参与匹配和补全,但不单独渲染。

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
| `agent_start` | 空输入时 prompt placeholder 进入 working;`reason:'follow_up'` 追加 `↪ follow-up` |
| `agent_end` | 最终边界追加 done/aborted/error;`willRetry:true` 保持 retrying,不误报完成 |
| `turn_start` | 无可见输出(内部计数) |
| `turn_end` | 无额外分隔组件 |
| `message_start` (user) | 追加 user / steering / follow-up / synthetic 块 |
| `message_start` (assistant) | 创建按 message id 索引的流式 Markdown 块 |
| `message_update` | `text_delta` / `reasoning_delta` 分别按 `contentIndex` 累积到有序块,块间保留空行；不能把多个 content part 粘成一个单词或在最终消息到达时跳变；tool-call 参数流只更新 activity |
| `message_end` (assistant) | `stopReason: 'length'` 追加警示行 `[output truncated by model limit]`;`'aborted'` 追加 `[aborted]` |
| `message_end` (tool_result) | 已由 `tool_execution_end` 渲染,此处无输出(去重) |
| `tool_execution_start/update/end` | 原位更新同一工具块:`●` → 尾行 → `✓/✗`;diff 以语义颜色追加(上限 24 行) |
| `queue_update` | 完整替换计数;running/retrying 时附在 prompt placeholder |
| `plan_update` | 原位替换同一 plan 块:`✓` / `▶` / `○`,不重复追加整表 |
| `approval_request` | transcript 留痕,prompt 横线切黄色,第一条 footer 始终显示专用键位；已有 draft 保留但冻结 |
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

→ /status               Show model, usage, and token status
────────────────────────────────────────────────────────────
/st▌
────────────────────────────────────────────────────────────
 ~/Desktop/openai/openai-sdk-ts  (main)
 context 2.4k / 128k · 1.9%                    openai/gpt-5.2
```

中间转录短时锚定顶部;只有填满后才滚动并跟随最新内容。图中用户输入 `/st` 后候选从 prompt 向上展开；按 `Tab` 只补成 `/status `,按 `Enter` 则补全并执行。两行 footer 固定在屏幕底部,多行 prompt 与 slash menu 都从其上方向上扩展。

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
| `prompt` | `session.prompt(text)` | running/retrying 时 **不 throw 到进程**,输出 `{type:'error', fatal:false, message:'agent is running; use steer or follow_up'}`；compacting 时暂存 |
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

交互 TUI/classic 退出时必须先关闭 `ProviderCommandController`：通过外部
`AbortSignal` 取消在途的 `/login` 模型刷新并等待提交收束，再销毁视图。Registry 自身的
15 秒网络超时仅作为兜底。

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

## 7. Provider 认证、模型发现与选择

### 7.1 `/login`:只新增或更新认证

`/login` 在 TUI/classic 中走同一个状态机，第一层固定显示 `OAuth` 与 `API key`。TUI 必须用
§1.2 的 candidate menu 在输入框上方展示两项，以 `↑`/`↓` 选择、`Enter` 确认，不能要求用户
输入数字；随后 provider 与协议等固定选项也复用该层。classic 使用同一份结构化候选打印编号
列表，作为低能力终端的兼容输入面。两种前端的 `Esc` 都由状态机逐级返回；根步骤静默退出，
不得追加取消消息。OAuth 入口只打印 `OAuth 尚未实现` 后回到普通输入，不创建 Session、不写
配置。API key 的首期 provider 固定为:

- **OpenCode Go**:`provider id = opencode-go`，`baseURL =
  https://opencode.ai/zen/go/v1`，用户只秘密输入 key。保存后立即 GET
  `https://opencode.ai/zen/go/v1/models`；实时结果只决定可用 id，实际协议必须再与
  [04 文档](./04-provider-adapter.md)中维护的显式 `model → api + limits` 目录相交。表外模型
  会列入 ignored 提示，绝不能猜测协议或 limits，也不能进入 `/model`；表内模型解析出的
  `ModelConfig.limits` 同时供 footer 百分比与 Session compaction 使用。
- **Custom**:严格按 provider name → base URL → API key → protocol 输入。协议只能从
  `OpenAI Chat Completions`、`OpenAI Responses`、`Anthropic Messages` 三项中选择，不接受自由
  文本。name 经 NFKC、首尾/连续空白归一化后做大小写不敏感 canonical 化，稳定 id 为
  `custom:<percent-encoded-name>`；同名再次登录就是更新，大小写不同不产生第二份 provider。
  不同 name 可并存。OpenAI 两种协议请求 `<baseURL>/models`；Anthropic 在 baseURL 尚未以
  `/v1` 结尾时请求 `<baseURL>/v1/models`，并使用对应认证 header。

非秘密配置、模型缓存和最近显式选择写入 `~/.coda/providers.json`；key 单独写入
`~/.coda/credentials.json`。每次写入先在短跨进程锁内重新读取并合并最新状态，再采用同目录
临时文件 + fsync + 原子 rename，目录权限收紧为
`0700`、文件为 `0600`，凭据目标若是符号链接则拒绝读取。秘密输入只在控制器内短暂存在，
TUI/classic renderer 始终只收到等长掩码；key 不进入输入历史、transcript、Session JSONL、
`SessionEvent` 或日志。

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
2. 创建第一份 Session，或在现有 Session 空闲时调用 `Session.setModel()`；
3. 成功后记住这次用户显式选择并静默更新 footer；当前模型已经由右下角持续显示，不得再向
   transcript/普通输出追加“已选择 …”成功消息。若只持久化最近选择失败，当前切换仍有效并
   明确警告下次启动可能无法恢复。

后续每次 provider 调用都由 CLI composition root **按当次 `model.ref.api`** 分发到现有
`openai-chat`、`openai-responses`、`anthropic-messages` adapter，不能按 provider id 或上次选择
缓存 adapter。切换不改写 `MetaRecord` 或历史消息；每条 assistant 继续记录实际采样所用
`ModelRef`，transform 层据此处理跨模型 reasoning。

`/login` 更新当前 provider 的 key 时，只要当前模型的 endpoint/api 仍相同且刷新后仍可用，就把
新凭据换入活动配置但不改变显式选择；否则清除当前选择并要求重新 `/model`。`/logout` 按名称或
编号删除目标 provider 的 key，保留非秘密配置和模型缓存；若它是当前 provider，同时回到未选择
状态。三条管理命令只允许在 `idle` 执行，running/retrying/compacting 时统一提示先完成或
abort。

启动只恢复 `providers.json` 中最近一次**用户显式选择**，且必须仍能由当前配置、凭据与缓存完整
解析；失效就保持未选择，不回退任何硬编码默认模型。无选择的交互冷启动不创建带占位
`ModelRef` 的 Session，普通 prompt 会提示先 `/login` 再 `/model`。

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
无选择状态；`--json`、`-p`、裸 prompt 与管道模式没有配置对话，必须在 Session 创建前
fail-fast，并提示进入交互终端执行 `/login`、`/model` 或补齐对应环境变量。非交互调用已经由
旧式入口解析出完整 `ModelConfig` 时不读取 provider registry，损坏的交互配置不能阻断脚本。

## 8. 边界情况

- **非 TTY stdin**(`echo "..." | coda`):自动等价 `-p` 模式读完 stdin 作为 prompt;`--json` 显式给出时按 headless 协议解析。
- **粘贴多行文本**:OpenTUI Textarea 与 classic 都启用 bracketed paste,粘贴换行不发送;审批期间整段 paste 被输入边界拦截,不能把首字符误判为 `y` / `a` / `n`;不支持 bracketed paste 时是终端自身的已知限制。
- **窗口 resize**:OpenTUI 重跑 Yoga 布局;宽度不足依次收起 tips、Logo、model。prompt 按新宽度重测软换行并增高或缩回；transcript 内容重排但顺序不变,composer 始终在底部。
- **CJK / emoji 宽字符**:OpenTUI native buffer 负责全屏分支的列宽;程序化设置输入历史后调用 Textarea 的 buffer-end API,不能用 JavaScript UTF-16 `string.length` 猜光标列。classic 动态区继续用仓库的 `displayWidth`/截断实现。
- **过小终端**:低于 10 行进入 ultra-compact,按 §1.2 的优先级逐级隐藏装饰与状态行；高度 1 时普通输入仍保留视口内光标,审批则隐藏输入并只显示决议键位。裁切不能产生屏幕外的 visible cursor,也不能让非空 draft 隐藏审批操作。
- **Windows**:OpenTUI 依赖对应 win32 native optional package;classic/plain 仍是 `TERM=dumb` 或初始化失败时的保底。只承诺现代 Windows Terminal。
- **恢复转录**:`--continue` / `--resume` 可以先记住目标 session id；有有效模型时在显示 UI 前恢复，没有模型时延迟到 `/model` 后 attach，再用最终 `AgentMessage` hydrate，不伪造生命周期事件。assistant 的多 text/reasoning part 按原顺序分块；历史 tool call 必须从参数恢复工具摘要；plan tool result 从 `details.steps` 恢复最新 plan,失败结果仍可见。初始化/重放失败必须 destroy OpenTUI 后才允许降级 classic。

## 9. 验收清单

- [ ] 100×30 下 header 含版本/Logo/tips;首条 user/assistant 紧跟中区顶部,短内容下方留白而不是贴 footer
- [ ] 长输出填满中区后自动跟尾;PageUp 手动上滚后不抢回,PageDown 可回到最新内容
- [ ] native framebuffer 与整个视图树都保持 alpha 0,header、transcript、Markdown、prompt 与 footer 不绘制任何实色背景
- [ ] prompt 为透明双横线,没有左右边/圆角/title；默认 1 行并随显式/软换行增高(空间允许时最多 8 行),内容缩短后缩回；Textarea 聚焦时显示高对比品牌红色闪烁原生竖线,组件失焦时隐藏,终端窗口失焦时允许模拟器显示空心 inactive cursor；点击输入区可恢复组件焦点；正常高度下其后恰有 workspace 与 context/model 两行
- [ ] 输入 `/` 时 slash menu 在 prompt 正上方完整显示命令、参数提示与说明,当前项有 `→` 和 accent；前缀过滤大小写无关,窄屏可隐藏说明但不丢候选
- [ ] slash menu 中 `↑/↓` 循环选择,`Tab` 补全但不发送,`Enter` 补全后发送,`Esc` 只收起列表；running/retrying 不展示会被当作 steering 的空闲命令
- [ ] resize 宽→窄→宽后 prompt 按软换行增高再缩回,Logo/tips 正确隐藏并恢复；非空多行 draft 下审批 footer 与黄色横线仍可见,决议后恢复 workspace/洋红横线
- [ ] 9→7→5→3→2→1 行的 ultra-compact 降级中光标不越界；1 行审批优先显示 y/a/n/Esc 并隐藏输入光标
- [ ] 流式输出期间输入框稳定;Enter 后出现 steering 回显,Shift+Enter 只插入换行
- [ ] retry backoff 期间 Enter 入 steering 队列、Esc 取消重试；compacting 期间 Enter 的 prompt 在压缩完成后启动
- [ ] `Esc` 不与方向键冲突;流式中裸 Esc 一次 abort,assistant 以 `[aborted]` 收尾
- [ ] `Alt+Enter` 与 `/f ` 前缀均能入 follow-up 队列(至少各在一种终端验证)
- [ ] `coda --continue` 重放转录后,tool 摘要、最新 plan 与 plan error 都保留,新输入接在原上下文继续
- [ ] 模型/工具/持久化文本中的 CSI/OSC/DCS 与 C0/C1 控制字符不会进入帧或终端标题
- [ ] 无 `COLORTERM` 的 256 色双 TTY 中首帧使用 SGR 49,且不输出 `48;2` / `48;5` 实色背景
- [ ] TUI 正常退出、fatal、审批中 abort 与初始化失败四条路径都恢复主屏/raw mode；初始化失败后 classic 无双重输入
- [ ] TUI/classic 的 `/login` 都先显示 OAuth/API key；TUI 与 slash command 复用输入框上方的 `→` candidate menu，以 `↑/↓` 选择、`Enter` 确认且不要求数字输入，classic 保留编号/名称兼容；`Esc` 逐级静默返回、根步骤静默退出且秘密回退先清 key；OAuth 占位安全返回，秘密输入只显示掩码且不进输入历史、事件、转录或日志
- [ ] OpenCode Go 的实时 models 与显式协议表取交集；表外 id 不可选；多个 custom provider 可按大小写不敏感名称更新并分别 `/logout`
- [ ] `/login` 不切模型；`/model` 以 provider/model 选择并按 `ModelRef.api` 动态分发；运行中三条管理命令只提示完成或 abort
- [ ] 同一 provider 的旧模型刷新迟到时因 revision CAS 被丢弃，不回滚新 endpoint/key
- [ ] `/login` 模型刷新中退出会取消请求，并等待 controller 收束后再销毁前端
- [ ] 零配置冷启动没有 Session；失效的最近选择保持未选择，不恢复硬编码默认；`/model` 后才 create/resume 并重放历史
- [ ] `coda --json` 下:乱输入一行非 JSON 不退出;`prompt`-running 冲突返回 non-fatal error 事件;`shutdown` 在运行中先 abort 再 flush 退出,exit code 0
- [ ] `--json` 的 stdout 每一行都能被 `jq .` 解析(管道纪律)
- [ ] 旧式配置优先级:同时给 flag/env/config 三处不同 model,生效的是 flag;全部去掉后不产生默认模型
- [ ] 非 TTY 管道输入自动走一次性模式;`NO_COLOR` 下不出现 coda 自定义调色

## 相关文档

- [03-internal-protocol.md](./03-internal-protocol.md) —— `SessionEvent` 所承载的 `AgentEvent` / `ProviderEvent` 定义
- [06-steering-following.md](./06-steering-following.md) —— Enter=steer / Alt+Enter=followUp 背后的队列语义
- [08-session-persistence.md](./08-session-persistence.md) —— `--continue` / `--resume` 依赖的会话存储与恢复
- [10-testing.md](./10-testing.md) —— 基于 `--json` 管道的 e2e 测试方案
