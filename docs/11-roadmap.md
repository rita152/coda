[← 返回地图](./README.md)

# 11 实施路线图:里程碑 M0–M7、验收标准与风险清单

本文把 [01-overview](./01-overview.md) 的目标与 [02-architecture](./02-architecture.md) 的分层拆成 8 个可独立验收的里程碑。每个里程碑给出:目标、交付物、前置依赖、**可执行的验收步骤**、预估规模、以及结束时的 demo 剧本(一句话说清「这周能演示什么」)。规模估算含测试代码,量级仅用于排期感知,不作为 KPI。

## 0. 总览

```mermaid
graph LR
  M0[M0 脚手架] --> M1[M1 protocol + faux]
  M1 --> M2[M2 CC adapter]
  M1 --> M3[M3 loop + tools]
  M2 -.真实模型联调.-> M3
  M3 --> M4[M4 steering/abort/transform]
  M4 --> M5[M5 CLI + session]
  M5 --> M6[M6 plan + approval]
  M5 --> M7[M7 compaction/retry/第二 provider]
  M6 --> M7
```

| 里程碑 | 一句话 | 规模量级 |
|---|---|---|
| M0 | 仓库能 build/lint/test 空跑,import 边界已被 lint 武装 | ~10 文件 / 数百行 |
| M1 | 内部协议类型 + EventStream + faux provider,全离线 | ~8 文件 / 1000 行 |
| M2 | Chat Completions adapter,SSE fixture 回放全绿 | ~10 文件 / 1500 行 |
| M3 | agent loop + 工具框架 + 7 个工具,真实模型能改文件 | ~25 文件 / 3500 行 |
| M4 | steering / follow-up / abort / transform 层 | ~8 文件 / 1200 行 |
| M5 | 可日用的 REPL + headless `--json` + JSONL 会话 | ~15 文件 / 2500 行 |
| M6 | plan 工具 + 权限/approval + 截断落盘完善 | ~10 文件 / 1500 行 |
| M7 | compaction + auto-retry + 成本统计 + Anthropic adapter | ~12 文件 / 2000 行 |

节奏感知:M3 是体量高峰(工具集是纯粹的体力活,但每个工具彼此独立,易并行);M4 是**难度**高峰(代码量小、语义密度最高);M5 之后项目自举,迭代速度会明显加快。若按单人全职估算,M0–M5 约 4–6 周,M6–M7 约 2–3 周;数字仅供节奏参考,验收标准才是完成的唯一定义。

## 1. 实施顺序的理由

### 1.1 为什么 protocol 先行(M1)

`src/protocol/` 是所有其他目录的唯一公共依赖(见 02 文档依赖图),它冻结得越早,后续里程碑越能并行:M2(adapter)与 M3(loop)都只依赖 M1,理论上可以两个人同时开工。更深一层的理由来自参考项目的共同经验:

- agent 系统的质量上限由事件协议决定——pi 的 13 种流事件、codex 的 `submit(Op)/next_event()` 都是先有协议、后有实现;协议是这类系统里最难事后更换的部件。
- 协议层零运行时依赖(纯类型 + 一个 EventStream 类),写它的成本极低,但它固化了「AssistantMessage 携带 stopReason/usage/ModelRef、错误也是一条合法消息、每个事件带 partial 快照」这些关键决策——决策在此刻翻案的成本最低,越晚越贵。
- faux provider 与协议同期交付,意味着「测试基建先于被测系统」:M3 起的每一条 loop 测试都不碰网络。

### 1.2 为什么 adapter 在 loop 之前(M2 → M3)

表面看反直觉——loop 用 faux provider 就能开发,似乎该先写 loop。排序的真正依据有两条:

- **协议要先被现实砸实。** 内部协议在接触真实 wire 格式之前只是一个假设:`ProviderEvent` 能否无损表达 Chat Completions 的流(tool_calls 按 index 分片、usage 尾 chunk、in-band error、`finish_reason: 'length'` 的截断参数)?openai-node 的 `ChatCompletionStream.ts` 累积算法、id 缺失兜底这些细节,任何一个塞不进 `ProviderEvent` 都意味着协议要改——协议返工的代价随其上层建筑数量线性增长,所以要赶在 loop 建起来之前用最难缠的真实方言验证它。
- **风险对冲。** adapter 是全项目风险密度最高的模块(第 3 节 R1/R2 全部落在这里),把最不确定的部分前置,暴雷早、返工面小。faux provider 保证这个顺序不阻塞任何人:M3 的全部单测跑 faux,adapter 只在联调时介入。

### 1.3 为什么 steering 单独一个里程碑(M4)

steering 不是 loop 的一个 feature flag,而是一组跨层的精密约定:注入点只在 turn 边界、abort 的孤儿 toolCall 要在下次请求前补合成结果、aborted 消息重放时过滤。这三件事分别落在 agent、transform、adapter 三层,错任何一处的表现都是「偶发 400」——Chat Completions 对 tool_calls/tool 配对缺一条即 400(openai-node 调研确认),而偶发意味着难排查。

- pi 把 transform-messages 做成独立垫层、codex 把 pending_input 的 drain 时机写进核心状态机,都证明这块值得一等公民待遇。
- 单独里程碑意味着单独的测试矩阵(见 M4 详表),而不是揉在 M3 里「顺便测测」。
- M3 因此先交付一个**只会一路跑到完成**的 loop:语义简单、测试面小;M4 在其上叠加中断与注入,每条测试都有明确的前置状态。

### 1.4 为什么 CLI 在 loop 与 steering 之后(M5)

CLI 是 `AgentEvent` 的纯消费者([09-cli](./09-cli.md)),事件集不稳定时写 UI 就是在流沙上盖楼——opencode V1 的教训正是 UI 与核心互相渗透后无法拆分,最终付出整体重写的代价。`queue_update`、abort 收尾语义都在 M4 才定形,M5 开工时渲染对应表(09 文档第 4 节)已经是一张不会再变的表。headless `--json` 与交互 REPL 同期交付,互为验证:headless 是 e2e 测试面,REPL 是体验面。

### 1.5 为什么 approval 与 compaction 垫后(M6/M7)

两者都是在稳定内核上的纯增量:approval 只是 `beforeToolCall` 钩子的一种实现 + 一个事件/命令对;compaction 只是 `transformContext` 钩子的一种实现。钩子在 M3 就已存在,后置不产生返工;反而能在日用(M5 起自举开发)中积累真实需求——哪些 bash 命令该免审、compaction 该保留多长的尾部,这些参数靠拍脑袋不如靠两周的真实使用。

## 2. 里程碑详表

### M0 脚手架

- **目标**:空仓库变成有纪律的仓库——所有后续 PR 的机械检查就位。
- **交付物**:`package.json`(Bun 1.3.14、ESM、bin 占位 `coda`)、`bun.lock`、`tsconfig.json`(strict、Bundler resolution)、`Bun.build` 构建脚本、`bun:test` 配置、ESLint(含 `import/no-restricted-paths`:`openai` 包仅允许 `src/providers/openai-chat/`;`agent`/`tools`/`protocol` 禁止 import `providers/*`、`cli/*`)、`.gitattributes`(强制 LF,风险 R3 的第一道防线)、CI(lint + build + test 三件套)、`src/` 空目录骨架。
- **实现要点**:统一入口脚本 `bun run check` = lint + typecheck + build + test,后续所有里程碑的验收第一条都是它;ESLint 边界规则本身要配一个「故意违例」的注释样例文件放在 `eslint` 测试里,防止规则被后人静默删除后无人察觉。项目工具链与运行时统一固定 Bun 1.3.14；`node:fs` 的目录操作及 append/fsync/truncate、`node:path`、readline/raw TTY、`process` signal/PGID 是 Bun 暂无等价语义时的受控 compatibility 边界,不宣称零 Node API。
- **前置**:无。
- **验收**(可执行):
  1. `bun run build && bun run lint && bun test` 全绿(允许 0 test)。
  2. 边界规则自证:临时在 `src/agent/x.ts` 写 `import 'openai'`,`bun run lint` 必须报错;删除后恢复绿。对 `src/protocol/` import `openai` 同理。
  3. CI 在干净 clone 上跑通同样三件套。
- **规模**:~10 个配置文件,数百行。
- **Demo 剧本**:「克隆仓库,一条 `bun install --frozen-lockfile && bun run check` 全绿;故意越界 import,lint 当场拦下。」

### M1 内部协议 + EventStream + faux provider

- **目标**:冻结 [03-internal-protocol](./03-internal-protocol.md) 的全部类型;交付可脚本化的测试 provider,让此后一切开发离线。
- **交付物**:`src/protocol/messages.ts`(AgentMessage 族、Usage、Context)、`provider.ts`(ProviderEvent、StreamFn、ModelConfig、EventStream/ProviderEventStream)、`agent-events.ts`(AgentEvent、QueuedMessage、PlanStep);`src/providers/faux/`(接受事件脚本,按序回放为 ProviderEventStream,支持 gate 受控暂停与中途 error/abort 剧本);EventStream 单测。
- **实现要点**:faux provider 的脚本格式设计值得多花半天——它是此后每个里程碑测试的通用语言,应支持:`gate` 受控暂停(不用计时器,与 [10-testing](./10-testing.md) §3.2 的零时间依赖原则一致)、按调用次数切换剧本(第 1 次调用回 tool_calls、第 2 次回 stop,模拟多 turn)、abort 感知(每个发射间隙与 gate 等待中检查 signal,以 aborted 消息收尾)、以及记录每次收到的 `Context` 供断言(M4 验证出站转录、M7 验证 compaction 都靠它)。EventStream 注意 push 在无消费者时的缓冲语义与 end 后迭代器的收尾,这两处 bug 会以「测试偶发挂起」的形态折磨所有后续里程碑。
- **前置**:M0。
- **验收**:
  1. EventStream 语义测试全绿:异步迭代收到 push 的全部事件;`end()` 后迭代终止且 `result()` resolve;先迭代后 push、先 push 后迭代两种时序都正确;end 后再 push 被忽略并产生开发警告。
  2. faux provider 回放剧本:`text_start/delta/end + done` 剧本产出的最终 AssistantMessage 与逐事件 partial 快照一致(最后一个 partial 深等于 done.message)。
  3. faux 的 error 剧本验证 StreamFn 铁律:调用方零 try/catch 收到 `error` 事件,stopReason 为 `error`。
- **规模**:~8 文件 / 约 1000 行(含测试)。
- **Demo 剧本**:「一个 20 行脚本用 faux provider 在终端逐字打印一条流式 assistant 消息,全程无网络。」

### M2 Chat Completions adapter

- **目标**:[04-provider-adapter](./04-provider-adapter.md) 全量落地;用录制 fixture 把方言差异钉死在测试里。
- **交付物**:`src/providers/openai-chat/`——出站转换(Context → ChatCompletionMessageParam[],含 system/developer 切换、toolResult 图片拆 user 消息、空 assistant 跳过)、流消费器(手写 `for await`,tool_calls 按 index 累积、容错 JSON 持续刷新 arguments、id 缺失补 `call_<uuid>`、finish_reason 映射、usage 尾 chunk、in-band error)、`CompatFlags` 推断与覆盖、错误映射(APIUserAbortError → aborted,其余 → error + status/requestID);SSE fixture 录制脚本 + fixture 集(纯文本流、tool_calls 分片、并行多 toolcall、length 截断、content_filter、in-band error、无 usage chunk、`reasoning_content` 方言)。
- **实现要点**:先写录制脚本(`bun scripts/record-fixture.ts`,把真实 endpoint 的原始 chunk 存为 JSONL fixture),再写消费器——测试驱动的顺序在这里是字面意义的:每个 fixture 就是一条真实世界的方言证词。内部结构照 Vercel AI SDK `openai-compatible` 的两段式:纯函数消息转换 + 带块状态机(isActiveText/当前 toolCall 槽位)的流转换,两段各自可测。
- **前置**:M1。
- **验收**:
  1. `bun test providers/openai-chat` 全绿,覆盖上述全部 fixture;每个 fixture 断言完整 ProviderEvent 序列 + 最终 AssistantMessage(含 usage、stopReason)。
  2. length fixture:产出的 ToolCallPart 带 `rawArguments` 原文,stopReason 为 `length`(不执行的决策在 loop 层,adapter 不隐藏)。
  3. 配对回归:出站转换对「assistant(tool_calls) 后每个 id 都有 role:'tool'」做断言工具函数,供 M4 复用。
  4. 手动 smoke(不进 CI):`bun run smoke` 对真实 endpoint(OpenAI + 至少一个第三方兼容端点)跑一轮带工具调用的流式请求。
- **规模**:~10 文件 / 约 1500 行(fixture 文本另计)。
- **Demo 剧本**:「一条命令向真实 endpoint 发起带工具 schema 的流式请求,终端逐字打印 delta,结尾打印 stopReason 与 usage;换 baseURL 指向第三方端点同样工作。」

### M3 agent loop + 工具框架 + 7 工具

- **目标**:双层循环(先只做「一路到完成」路径)+ 工具执行三阶段 + read/ls/glob/grep/bash/edit/write 全部可用;真实模型第一次改动真实文件。
- **交付物**:`src/agent/`(Agent 类外壳、runLoop 内层循环、streamAssistantResponse、工具调度 prepare/execute/finalize、zod 校验失败与未知工具的 isError 合成回喂、`length` 全批不执行、parallel/sequential 调度)、`src/tools/`(ToolDefinition 框架、`z.toJSONSchema()` 渲染、2000 行/50KB 框架级截断 post-hook、7 个工具)、`src/shared/`(truncate、killProcessTree、FileTracker)。本里程碑 runLoop 骨架照 05 文档 §2.2 伪码完整实现(含 [A]/[I]/[J] 注入点与 abort 检查的结构性接线——伪码是 canonical,骨架不做阉割版),但 steering/follow-up 的语义验收矩阵、`queue_update` 事件与 abort 全链路测试都在 M4;M3 只交付注入点的最小冒烟。
- **里程碑内顺序**:框架 + read/ls/glob 先行(无副作用、最快让 loop 转起来)→ grep(引入 ripgrep 二进制依赖)→ bash(进程管理)→ write/edit 最后(edit 的 fuzzy 匹配是工具集中最精细的算法,且依赖 FileTracker 的 read-before-edit 约束已被 read 落地)。7 个工具彼此独立,是全路线图最适合并行分工的一段。
- **前置**:M1(全部单测跑 faux);M2 仅联调需要。
- **验收**:
  1. loop 单测(faux):`tool_calls → 执行 → 回喂 → stop` 两 turn 剧本事件序列正确;toolResult 按 assistant 源顺序回填;`length`+toolCalls 剧本全批合成错误不执行;未知工具名/参数校验失败合成 isError 且任务继续。
  2. 每个工具独立单测:edit 的精确/fuzzy/唯一性/CRLF-BOM 用例;bash 的超时 kill 进程树用例(spawn `sleep 999` 子孙进程,断言全灭);read 的 offset/行号/二进制检测/截断提示;grep 达 limit 时 rg 被 kill。
  3. 集成脚本(真实模型):`bun scripts/dev-run.ts "把 fixtures/a.txt 里的 foo 改成 bar"`,结束后文件内容变更、终端可见 diff。
- **规模**:最大的里程碑,~25 文件 / 约 3500 行。
- **Demo 剧本**:「对真实模型说一句话,看它 read → edit 完成一次真实文件修改,diff 打在终端上。」

### M4 steering / follow-up + abort + transform 层

- **目标**:[06-steering-following](./06-steering-following.md) 的七条 canonical 语义全部成立;转录在任何中断路径下重放合法。
- **交付物**:双队列 drain 接线(turn 边界 poll steering、收尾 poll follow-up、启动前 poll 一次、one-at-a-time/all 两模式)、`abort()`(AbortSignal 贯穿 provider 流与工具执行、`continue()` 续跑)、transform 层(aborted/error assistant 重放过滤、孤儿 toolCall 补 `"[Tool execution was interrupted]"` isError 结果、跨模型 reasoning 降级/toolCallId 归一化、非视觉模型图片降占位)、`queue_update` 事件接线、`prompt()` 运行中 throw。
- **测试矩阵**(faux 定时剧本逐格覆盖,这张表就是本里程碑的工作清单):

  | 事件时机 \ 队列状态 | 两队列空 | 仅 steering | 仅 follow-up | 两者都有 |
  |---|---|---|---|---|
  | assistant 无 toolCall 收尾 | agent_end | 内层续命注入 | 外层再开 turn | steering 先,follow-up 留待收尾 |
  | 工具执行中 steer() | — | turn 边界注入,不打断工具 | — | 同左 |
  | 流式中 abort() | aborted 收尾 | 队列保留,continue() 时 drain | 同左 | 同左 |
  | 工具执行中 abort() | 孤儿 toolCall 补合成结果 | 同左 + 队列保留 | 同左 | 同左 |

  abort 后转录修复的关键路径(M4 验收第 3、4 条对应的时序):

  ```mermaid
  sequenceDiagram
    participant U as 用户
    participant A as Agent(loop)
    participant T as transform 层
    participant P as provider(faux/真实)
    U->>A: abort()
    A->>P: AbortSignal 触发
    P-->>A: error 事件(stopReason: aborted)
    A-->>A: aborted assistant + 未执行 toolCall 留在转录
    U->>A: continue()
    A->>T: 出站前清洗 messages
    T-->>T: 过滤 aborted assistant;孤儿 toolCall 补 isError 结果
    T->>P: 配对合法的 messages(每个 tool_call 都有 tool 结果)
  ```
- **前置**:M3。
- **验收**:
  1. steering 时机测试(faux 定时剧本):工具执行中注入 steer,断言注入发生在该批工具全部完成之后的 turn 边界,且以 `source:'steering'` user 消息形态落转录。
  2. 续命/收尾矩阵:无 toolCall + steering 非空 → 内层继续;无 toolCall + 仅 follow-up → 再开 turn;两队列皆空 → `agent_end`。
  3. abort 矩阵:流式中 / 工具执行中 abort,断言 assistant stopReason 为 `aborted`、未执行 toolCall 在下次出站请求中均有合成结果——复用 M2 的配对断言函数直接验 wire 消息数组,**这是本里程碑的核心验收**。
  4. `continue()` 后转录追加合法,faux 端收到的 messages 不含 aborted assistant 原文。
- **规模**:~8 文件 / 约 1200 行(新增代码少,测试占大头——这正是单独成里程碑的意义)。
- **Demo 剧本**:「脚本运行中注入一条 steering,模型下个 turn 改变方向;Esc 等价的 abort() 之后 continue(),对话无缝续上且不炸 400。」

### M5 CLI REPL + headless + session 持久化

- **目标**:[09-cli](./09-cli.md) 与 [08-session-persistence](./08-session-persistence.md) 的 v1 范围全部交付;从这里开始项目自举(用 coda 开发 coda)。
- **交付物**:`src/cli/`(Bun 1.3.14 + readline/raw TTY compatibility REPL、Renderer 与 AgentEvent 对应表全量实现、键位表含 Esc 消歧与 Alt+Enter、队列徽标、`--json` headless、`-p` 一次性模式、配置解析 flags>env>config.json)、`src/session/`(JSONL 追加、meta 头行、`--continue`/`--resume` 恢复重放)。
- **里程碑内顺序**:headless 先于交互 REPL——headless 只有百来行且立即可被 CI e2e 覆盖,交互 REPL 的 Renderer 随后按同一张事件对应表实现,等于「先写协议消费的裁判,再写花哨的选手」。session 层与 CLI 并行不冲突(靠 `subscribe` 各自挂监听)。
- **前置**:M4(需要 `queue_update` 与 abort 语义定形)。
- **验收**:
  1. headless e2e(CI,faux provider):spawn `coda --json --provider faux`,stdin 写入 prompt/steer/abort/shutdown 剧本,断言 stdout NDJSON 事件序列与 exit code;每行可被 JSON.parse。
  2. session 往返测试:跑一段对话 → 进程退出 → `--continue` 启动 → 断言重放消息与原转录深等;JSONL 尾行截断(模拟 crash)时恢复能跳过坏行并告警。
  3. 交互冒烟清单(人工,含 09 文档验收清单前四条):流式中打字不花屏、Enter=steer 徽标、Esc abort、`--resume` 列表选择。
  4. 配置优先级自动化测试:flag/env/file 三处冲突时按序生效。
- **规模**:~15 文件 / 约 2500 行。
- **Demo 剧本**:「打开 coda 流式对话,运行中 Enter 注入 steering,退出后 --continue 原地恢复;同一套动作用 echo | coda --json 全部重演一遍。」

### M6 plan 工具 + 权限/approval + 截断落盘完善

- **目标**:第 8 个工具与安全层;工具输出超限落盘全面接通。
- **交付物**:plan 工具(整表替换、`plan_update` 旁路事件、promptSnippet 行为规范)+ CLI plan 渲染;approval 层(`beforeToolCall` 实现、`approval_request` 事件 + `Map<approvalId, resolver>`、决策 `allow_once | allow_always | deny | abort`、deny 理由合成 isError 回喂任务继续、bash 保守前缀解析 + `$()`/反引号强制升级、doom-loop 同参数三连强制审批)、headless 增补 `{type:'approval'}` 命令、CLI 审批键位模式;截断落盘(超限全文写 temp + 结果尾部附路径与 `offset=N` 提示)统一验收。
- **实现要点**:approval 完整实现在权限层与 CLI,agent 核心只认识 `beforeToolCall` 的返回值——这是 gemini-cli 工具状态机(pending → awaiting_approval → executing → …)在我们分层下的落位;deny 与 abort 必须是两种类型(codex ReviewDecision 的区分):deny 合成拒绝理由回喂、任务继续,abort 停任务。`allow_always` 的记忆持久化到 `~/.coda/`(按命令前缀),v1 不做项目级配置。
- **前置**:M5(approval 需要 UI 面呈现)。
- **验收**:
  1. approval 单测:deny → 合成拒绝结果回喂、任务继续产出替代方案;abort 决策 → 任务停止;审批等待中 `abort()` → 先观察 cancellation 再清 resolver,不以「拒绝」形态漏给模型(codex 的时序教训)。
  2. doom-loop 测试:faux 剧本让同工具同参数连发 3 次,第 3 次必弹审批。
  3. plan 测试:两个 in_progress 不被拒绝,工具输出含提醒文案;`plan_update` 快照为整表替换。
  4. 交互验收:bash 危险命令弹审批,`a`(always)后同前缀命令不再弹。
- **规模**:~10 文件 / 约 1500 行。
- **Demo 剧本**:「让模型执行 rm -rf,CLI 弹出审批;拒绝后模型收到理由改走安全路径,plan 面板同步勾进度。」

### M7 compaction + auto-retry + 成本统计 + 第二 provider

- **目标**:长会话可持续;用 Anthropic adapter 实证「新增 provider = 新增 adapter,核心零改动」。
- **交付物**:compaction(`transformContext` 钩子实现:接近 `limits.context` 时 LLM 摘要 + 保留尾部,摘要落 JSONL 可恢复)、auto-retry(可重试错误指数退避,尊重 retry-after,整轮重发在 session 层)、成本统计(Usage 累计 × 模型价格表 → `/status` 与 `agent_end` 小结)、`src/providers/anthropic/`(Messages API adapter,复用 M2 的测试形态)。
- **实现要点**:重试判据以 stopReason + errorMessage 中的结构化信息(status)为准,网络层单请求重试仍留给 SDK 默认 `maxRetries`,session 层只做**整轮**重发(openai-node 的分工结论:流一旦开始 SDK 不续传);compaction 的截断点必须落在 turn 边界(不能把 assistant(tool_calls) 与其 tool_result 切开,否则重放即 400,与 M4 同一条配对铁律)。Anthropic adapter 是文化验收:开发过程中每一次想改 `src/agent` 的冲动,都是协议设计缺陷的信号,记录下来比改掉更有价值。
- **前置**:M5(compaction/retry 挂 session 层);M6 非硬依赖。
- **验收**:
  1. compaction 测试:faux 剧本把上下文推过阈值,断言下次出站 messages 为「摘要 + 尾部」且总 token 低于阈值;压缩后继续对话工具调用配对仍合法。
  2. retry 测试:faux 脚本先回放 429 类错误再成功,断言退避序列与最终成功;不可重试错误(4xx 参数错)不重试直接 `agent_end`。
  3. **边界实证(本里程碑的灵魂)**:接入 Anthropic 后,`git diff --stat M5..HEAD -- src/agent src/protocol src/tools` 除新增可选字段外为空;M3–M5 的全部测试在 faux 与两个真实 provider 配置下语义一致。
  4. `/status` 显示累计 input/output/cacheRead/cost。
- **规模**:~12 文件 / 约 2000 行。
- **Demo 剧本**:「一个超长会话触发自动压缩后继续正常干活;`--model` 切到 Claude,全部功能(steering、工具、审批)原样工作,agent 目录零改动。」

## 3. 风险清单与缓解

| # | 风险 | 表现 | 缓解 |
|---|---|---|---|
| R1 | **第三方兼容 endpoint 方言**:max_tokens 字段名、developer role、streaming usage、strict tools、`reasoning_content`、tool 结果后必须跟 assistant 等差异,任何一个都可能 400 或静默降质 | 换 baseURL 后偶发报错或行为异常 | `CompatFlags` 声明化(pi `OpenAICompletionsCompat` 十余项开关即现成 checklist)+ baseURL 自动推断 + 显式覆盖;每种方言录 fixture 进 M2 回归;新端点问题的修复动作固定为「加一个 flag + 一个 fixture」,不改核心 |
| R2 | **流式 JSON 解析**:tool_calls 按 index 分片、arguments 逐片拼接、id 可能缺失、`length` 时 arguments 是非法/截断 JSON、usage chunk 可能缺失、错误 in-band 出现 | 参数错乱、盲 parse 抛异常、悬空 toolCall | 累积算法照抄 openai-node `ChatCompletionStream.ts`(index 定位、id 兜底 `call_<uuid>`);容错 JSON 解析仅用于流式期间刷新展示,**执行只信 `tool_call_end` 的完整 parse**;`length` 全批不执行是硬规则(pi 同款);全部路径有 fixture |
| R3 | **Windows CRLF**:模型输出 LF、文件是 CRLF 时 edit 匹配失败;JSONL/fixture 被 git 转换;compatibility readline 收 `\r\n` | edit 大面积「oldText not found」、fixture 平台间不一致 | edit 工具「剥离-匹配-还原」策略(M3 单测强制覆盖 CRLF+BOM 用例);`.gitattributes` 强制 LF(M0 落地);会话 JSONL 显式 `\n`;CI 加 Windows job 后置到 M5 |
| R4 | **readline/raw TTY compatibility 流式期间输入处理**:delta 写 stdout 与用户键入竞争同一屏幕;Esc 是转义序列前缀;Alt+Enter 编码因终端而异;粘贴多行误触发 | 输入行被冲花、方向键误触 abort、粘贴即发送 | Bun 1.3.14 下保留受控 compatibility 边界；单写入者纪律(Renderer 独占 stdout,先清动态区再追加再重绘);`escapeCodeTimeout` 消歧;斜杠命令 `/f` 作为全终端兜底;bracketed paste;非 TTY 降级 plain 模式(详见 [09-cli](./09-cli.md) 第 3、8 节) |
| R5 | **单体膨胀**:session/压缩/重试/队列全揉进一个类 | 后期不可测、不可拆(pi `AgentSession` 3300 行返工的直接教训) | 目录边界 + ESLint 规则(M0)机械阻止;compaction/retry 一律以 `transformContext`/session 钩子形态存在;M5 起每个里程碑验收含「新能力不得修改 `src/agent` 既有语义」的 diff 审查 |
| R6 | **zod v4 `z.toJSONSchema()` 与 strict 模式的兼容**:strict:true 要求根 object、全层 `additionalProperties:false`、可选字段进 required + null | OpenAI 端 400 或 schema 静默不生效 | 工具 schema 保持扁平简单(v1 工具全部满足子集);`supportsStrictTools` compat 开关按端点关闭;M2 fixture 含 strict 与非 strict 两种出站快照 |
| R7 | **审批与中断的时序竞争**:abort 时 pending approval 以「拒绝」形态漏给模型 | 转录中出现幽灵拒绝,模型行为异常 | 照 codex:interrupt 先让任务观察到 cancellation,再清 approvals(M6 验收第 1 条显式覆盖) |
| R8 | **事件监听 await 串行拖慢热路径**:`subscribe` 监听器逐个 await(pi 为落盘确定性的取舍),慢监听器直接卡住 text_delta | 流式输出肉眼卡顿 | 普通监听器必须快;session 落盘用同步 append,Renderer 状态变换只排队。唯一有意的 IO 等待是每个输出事件后的 stdout `drain`,用背压换取不丢输出与可观察错误;CI 吞吐基准使用无阻塞 sink。 |
| R9 | **ripgrep 二进制分发**:`@vscode/ripgrep` 通过平台 optional dependency 提供二进制,不同 `os` / `cpu` 的解析与路径可能不同 | grep 工具在部分环境不可用 | 由 Bun 1.3.14 安装并按平台过滤 optional dependency；启动时探测二进制存在,缺失时 grep 工具降级为明确报错(附安装提示)而非静默失效；CI 在 macOS 与 Linux 验证路径解析与实际执行 |

## 4. 机动指南:可并行、可裁剪、不可动摇

进度不可能完全按表走,提前约定三类机动空间,避免临场决策破坏架构:

- **可并行**:M2 与 M3 只共享 M1(loop 全程跑 faux);M3 内 7 个工具彼此独立;M5 内 headless / 交互 Renderer / session 三线可并行。多人协作时这是天然的分工线。
- **可裁剪**(排期告急时的降级顺序,从后往前砍):M7 的第二 provider → M7 的 compaction(先用「上下文将满」的硬报错顶住)→ M6 的 doom-loop 检测与 `allow_always` 持久化 → M5 的 `--resume` 列表交互(保留 `--continue`)。被裁项全部是钩子/客户端形态,后补零返工。
- **不可动摇**(任何压力下不得简化,否则是在给未来埋返工):StreamFn 不 throw 铁律、`length` 全批不执行、abort 后的转录修复(R2 的教训:悬空 toolCall 是必炸的 400)、stdout NDJSON 纪律、import 边界。这五条被砍任何一条,后续里程碑的验收都会连锁失效。

## 5. 非目标与刻意后置

以下明确不在 M0–M7 范围,且每一项都已在架构上留好增量入口:

- **server/daemon 模式**——headless NDJSON 协议已为其铺路,届时只需把 stdin/stdout 换成传输层。
- **持久 shell**——bash v1 每次新 spawn;持久 shell 是新的 `ToolDefinition` 实现,不动框架。
- **plan mode(写工具 gate)**——权限层已留模式标志位,是 `beforeToolCall` 的一种策略。
- **子 agent / MCP**——分别是新工具与新工具来源,挂在工具框架之下。
- **富 TUI 框架化**——`Renderer` 接口之后的替换,或 headless 之上的独立客户端(09 文档升级路径)。

判据统一:如果某项将来加不进来、非要动 `src/agent` 或 `src/protocol` 不可,说明分层出了问题,应先修架构再加功能。

## 6. 里程碑通用完成定义(Definition of Done)

- `bun run check`(lint + typecheck + 自包含 test；test 内依次跑 unit、build、e2e)全绿;新增代码有对应测试,faux 可测的不上真网。
- import 边界零违例(lint 强制,M0 起持续生效);新目录出现时同步补边界规则。
- 对应设计文档若与实现有出入,同 PR 内更新文档(文档是 canonical,改动需先在文档层想清楚)。
- 每个里程碑收尾录一次 demo 剧本的实际操作记录(命令 + 输出片段),贴进 PR 描述——demo 跑不通就不算完成。
- 涉及 wire 出站的改动(adapter、transform、compaction)必须通过 M2 引入的配对断言(每个 tool_call 有 tool 结果),该断言从 M2 起挂在共享测试工具里,是贯穿全路线图的不变量。

## 相关文档

- [01-overview.md](./01-overview.md) —— 目标、需求与关键决策摘要
- [02-architecture.md](./02-architecture.md) —— 本路线图各里程碑落位的目录与依赖规则
- [10-testing.md](./10-testing.md) —— 各里程碑验收所依赖的测试基建(faux provider、SSE fixture、e2e)
- [04-provider-adapter.md](./04-provider-adapter.md) —— M2 与 M7 第二 provider 的契约细节
