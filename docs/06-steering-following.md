[← 返回地图](./README.md)

# 06 · Steering 与 Follow-up:双队列完整规格

本篇是核心需求 2(steering / following 双队列)的唯一规格文档,本篇给出七条精确语义的权威定义,逐条展开并给出"为什么这样设计"的论证;实现落点在 `src/agent/`(队列与注入点)与 `src/protocol/`(事件类型);转录修复与 transform 层的分工:规格在 [04-provider-adapter.md](./04-provider-adapter.md),实现落点在 `src/agent/`;键位与 UI 反馈在 [CLI 文档](./09-cli.md)。

## 1. 动机与用户场景

一个正在跑长任务的 coding agent,用户随时会产生两类完全不同的输入意图:

**场景 A:任务跑偏了,温和引导。** 用户让 agent "重构 auth 模块",跑到第三个 turn 发现它开始改 `tests/` 下的快照文件。用户想说"别动 tests/,先只改 src/"——但**不想**把已经跑到一半的 edit 撤销、不想丢掉模型已经建立的上下文,更不想让一个执行中的 bash 命令被腰斩在中间状态。这是 **steering**:消息在当前 turn 的工具全部执行完之后、下一次模型调用之前注入,模型带着新指令继续当前任务。

**场景 B:排队下一个任务。** 当前任务跑得好好的,用户想到"做完之后顺便把 README 里的安装说明更新一下"。这条消息**不应该**污染当前任务的上下文——现在注入只会分散模型注意力,甚至让它中途切去改 README。这是 **follow-up**:消息排队,等 agent 本来要结束时才作为新任务的起点消费。

**场景 C:真的要停。** agent 在做完全错误的事,引导已经来不及。这是 `abort()`——硬中断,AbortSignal 贯穿 provider 流与工具执行,与前两者是不同档位(见第 6 节)。

三个场景对应三个入口,互不混淆。参考项目的收敛路径证明这个三分法是终点形态:

- **pi-mono** 从一开始就是显式双队列(`steer()` / `followUp()`)+ `abort()`,agent-core 里两个 `PendingMessageQueue` + 三个 poll 点,总实现不足百行,语义却完整覆盖三个场景。
- **opencode V1** 没有队列——所有输入直接写进历史,靠"step 边界重读历史自然拾取"实现事实上的 steering。代价是**用户无法表达 follow-up 意图**:任务运行中发的每条消息都会在下一个 step 边界并入。V2 重做时补上了显式的 `delivery: "steer" | "queue"` 双投递语义 + durable inbox——绕了一整代才回到双队列。
- **codex** 用"同一 Op 双语义"(`Op::UserInput` 空闲时开新任务、运行中自动转 steering),客户端协议最简,但同样无法表达"排队等任务结束"的意图,且语义取决于到达时刻的竞态(第 10 节详述)。

## 2. 数据结构与 API

### 2.1 Agent 对外 API([05 · Agent 核心循环](./05-agent-loop.md) 第 1 节的队列相关子集)

```ts
class Agent {
  prompt(text: string, opts?): Promise<void>     // 仅空闲时;运行中调用 throw(强制走 steer/followUp)
  steer(msg: UserMessage | string): void         // 随时可调,入 steering 队列
  followUp(msg: UserMessage | string): void      // 随时可调,入 follow-up 队列
  abort(): void                                  // 硬中断
  continue(): Promise<void>                      // abort/重试后续跑:优先 drain steering,否则 follow-up
  clearQueues(): void
  steeringMode / followUpMode: 'all' | 'one-at-a-time'   // 默认 one-at-a-time
  readonly state: 'idle' | 'running'
}
```

`steer` / `followUp` 接受 `string` 是便利重载:内部包装成 `UserMessage`,并打上对应的 `source` 标记(`'steering'` / `'follow_up'`,见 [内部协议](./03-internal-protocol.md) 的 `UserMessage.source` 字段)。两个方法都是同步 `void`——入队即返回,不等待消费;排队状态通过 `queue_update` 事件观察(第 8 节)。

### 2.2 内部队列(补充类型,不进 protocol 层)

```ts
// src/agent/queue.ts
export class PendingMessageQueue {
  constructor(public kind: 'steering' | 'follow_up') {}
  mode: 'all' | 'one-at-a-time' = 'one-at-a-time';

  push(msg: UserMessage): void;     // msg.id 即 QueuedMessage.id,注入后保持不变
  drain(): UserMessage[];           // 'all' 取空;'one-at-a-time' 只取最老一条
  snapshot(): QueuedMessage[];      // 供 queue_update 事件载荷
  clear(): void;
  get size(): number;
}
```

关键约定:**消息 id 在入队时生成,注入转录后仍是同一个 id**。`QueuedMessage.id === UserMessage.id`,UI 靠 id 而非文本内容关联排队条目与最终消息(为什么必须如此见第 8 节 pi 的教训)。

`drain()` 的 `'one-at-a-time'` 语义:只弹出队首最老一条,其余留在队列里等**下一个** drain 点(即再跑完一个 turn 之后)。这是 pi 的原始设计,也与 opencode V2 的 `promoteNextQueued`("一次只提升一条 queue 消息,再重新评估")一致。

### 2.3 事件侧类型(定义见 [03 · 内部协议](./03-internal-protocol.md),原样引用)

```ts
export interface QueuedMessage { id: string; text: string; kind: 'steering' | 'follow_up' }

// AgentEvent 中与本篇相关的变体:
| { type: 'queue_update'; steering: QueuedMessage[]; followUp: QueuedMessage[] }
| { type: 'agent_start'; reason: 'prompt' | 'follow_up' | 'continue' }
```

`agent_start.reason: 'follow_up'` 让 UI 能区分"用户显式发起的任务"与"follow-up 队列续命的任务"。

## 3. 七条精确语义(逐条展开)

以下七条是本篇的权威语义定义,实现不得偏离。每条附设计依据。

### 语义 1:steering 不打断当前 turn

当前 assistant 的 tool calls **全部执行完**后,才在 turn 边界注入 steering;注入形态是追加在 toolResults 之后的 user 消息(`source: 'steering'`)。

**为什么:**
- **工具不可腰斩。** 执行到一半的 edit 会留下损坏的文件,跑到一半被跳过的 bash 状态不可知。pi 的 `types.ts` 注释原话:"Tool calls from the current assistant message are not skipped"——这是我们源码验证过的、pi 的明确设计承诺,不是实现巧合。
- **转录必须始终合法。** Chat Completions 要求 assistant 的 `tool_calls` 与紧随其后的 `role:'tool'` 消息严格配对;在 assistant 与 toolResults 之间插 user 消息,下一次请求直接 400。turn 边界(toolResults 之后)是唯一天然合法的注入点。
- **codex 同款佐证。** codex 的 pending_input 也在采样间隙 drain(`run_turn` 每轮采样前 `get_pending_input()`),且用 `can_drain_pending_input` 标志保证 turn 首轮先采样原始输入——三个独立实现(pi、codex、opencode V2 的 "Safe Provider-Turn Boundary")收敛到同一个注入点,说明这是正确答案。
- **代价可接受。** 副作用是 steering 无法打断一次超长的 LLM 流式响应或长工具——pi 也没有做"软打断流"。真急了用 `abort()`,这正是两档打断分工的边界(第 6 节)。

### 语义 2:steering 会续命

assistant 未再发起工具调用(本来内层循环该退出)时,只要 steering 队列非空,内层循环继续——注入 steering 并开启下一个 turn。

**为什么:** 用户 steering 的意图是"继续做,但调整方向"。若 assistant 恰好在这个 turn 没发工具调用就自然收尾,steering 消息若不续命就会被搁置到下一次 prompt,语义断裂——用户明明是在对**这个**任务说话。pi 的内层循环条件就是 `while (hasMoreToolCalls || pendingMessages.length > 0)`;codex 的 `RegularTask::run` 外层同样有"`run_turn` 结束后若 `has_pending_input` 则再跑一轮"的兜底,注释明言是为了保证收尾瞬间到达的消息不丢。

### 语义 3:follow-up 只在 agent 本来要结束时被 poll

没有更多 toolCall、也没有 steering 消息时,才 poll follow-up 队列;有则注入并开新 turn(外层循环 continue,`agent_start` 不重发,但语义上是任务续接),无则 `agent_end`。

**为什么:** follow-up 的用户意图是"当前任务做完之后"。提前注入会污染当前任务的上下文焦点——这正是 opencode V1 的缺陷(无法表达此意图)。opencode V2 的 `CONTEXT.md` 把这条写成了正式语义:"queue 绝不在 drain 需要继续时提升"。follow-up 的优先级也由此确定:**steering 永远先于 follow-up 被消费**——只要还有 steering,agent 就没有"本来要结束"。

### 语义 4:队列模式默认 one-at-a-time

`'one-at-a-time'`(默认)每个注入点只取最老一条;`'all'` 取空整个队列。

**为什么:** 用户连发三条 steering 时,三条一次性全灌给模型,指令间的优先级与先后语境全靠模型猜;one-at-a-time 让每条消息获得一个完整的 turn 响应周期,行为可预测。pi 的两个队列默认都是 one-at-a-time;opencode V2 的 queue 提升同样一次一条再重新评估。`'all'` 保留给"多条消息本来就是同一段话"的场景(如 headless 客户端把一段长指令分片入队)。模式是 Agent 实例上的可变属性,CLI 可通过命令切换。

### 语义 5:硬打断 = abort()

`abort()` 触发 AbortController;AbortSignal 贯穿 provider 流(StreamFn 以 `stopReason: 'aborted'` 收尾)与工具执行(sequential 批次在每个工具后检查 signal 直接 break,剩余 toolCall 不执行也不伪造结果)。被中断的 assistant 消息(`stopReason: 'aborted'`)**保留在转录**、**重放时由 transform 层过滤**;未执行的孤儿 toolCall 在下一次请求前由 transform 层补合成 `"[Tool execution was interrupted]"` 的 isError 结果。

**为什么:** 详见第 6、7 节。要点:转录完整性(用户能看到"这里被打断了")与出站合法性(API 不接受不完整 turn)是两个正交需求,分别用"保留"与"重放过滤 + 补合成"满足。pi 的 transform-messages 与 opencode 的 cleanup(悬空 tool call 重放时转 `"[Tool execution was interrupted]"`)都是同一结论。

### 语义 6:prompt() 运行中 throw;CLI 键位三分

`prompt()` 在 `state === 'running'` 时 throw(报错文案指向 `steer()` / `followUp()`)。CLI 键位:**流式期间 Enter = steer,Alt+Enter = followUp,Esc = abort**。

**为什么:** 若 `prompt()` 在运行中自动降级为 steer 或 followUp,调用者拿到的语义取决于毫秒级竞态(消息到达时任务是否恰好刚结束)——这正是 codex 单 Op 方案的固有问题(第 10 节)。pi 在两层都强制显式:`Agent.prompt()` 运行中直接 throw("Use steer() or followUp() to queue messages"),上层 `AgentSession.prompt()` 在流式期间必须显式传 `streamingBehavior: "steer" | "followUp"` 否则同样 throw。入口强制二选一,没有第三种模糊状态。键位分配的依据:steering 是流式期间最高频的动作,给成本最低的 Enter;follow-up 次之给 Alt+Enter;Esc 是终端用户对"停下"的肌肉记忆(键位实现细节见 [CLI 文档](./09-cli.md))。

### 语义 7:agent_end 后的残留队列由 session 层决定

`shouldStopAfterTurn()` 返回 true 时直接 `agent_end`,**不 poll 任何队列**;队列内容保留。是否用 `continue()` 续跑残留队列,由 session 层(或任何宿主)在收到 `agent_end` 后自行决定。

**为什么:** `shouldStopAfterTurn` 是宿主的"优雅停"钩子(token 预算耗尽、审批被拒终止等),此时"要不要继续消费队列"是**策略**问题而非**机制**问题——loop 若自作主张续跑,宿主刚下达的"停"就被队列复活了。pi 的分工完全相同:loop 层不 poll 直接退出,coding-agent 层在 `_handlePostAgentRun` 里检查 `agent.hasQueuedMessages()` 再决定 `agent.continue()`。codex 则选择自动续(`on_task_finished` 把残余 pending input 记为下一 turn 的输入)——我们不采纳,显式交给 session 层更可控。

`continue()` 的消费顺序(与 [05](./05-agent-loop.md) 第 1 节的 Agent API 一致):**优先 drain steering,否则 follow-up**。典型场景是 abort 之后——最后一条消息是 aborted 的 assistant,`continue()` 把 steering 队列里的消息当作新 prompt 启动,并跳过起跑前的那次 steering poll(pi 的 `skipInitialSteeringPoll`,防止同一条消息被 drain 两次);两个队列皆空时 `continue()` throw。

## 4. 注入点时序

runLoop(见 [Agent 核心](./05-agent-loop.md) 的骨架)共有**三个** poll 点:起跑前一次 steering poll、每个 turn 结束后的 steering 注入点、agent 即将停止时的 follow-up 注入点。

```mermaid
sequenceDiagram
    participant U as CLI/用户
    participant A as Agent
    participant L as runLoop
    participant P as Provider (StreamFn)
    participant T as Tools

    U->>A: prompt("重构 auth 模块")
    A->>L: run()
    Note over L: ① 起跑前 poll 一次 steering<br/>(用户在上一轮回答期间可能已输入)
    loop 内层:hasMoreToolCalls || pending 非空
        L->>L: turn_start;逐条注入 pendingMessages<br/>(message_start / message_end)
        L->>P: streamFn(model, ctx, { signal })
        P-->>L: ProviderEvent 流 → AssistantMessage
        U->>A: steer("别动 tests/ 目录")
        Note over A: 入 steering 队列<br/>emit queue_update
        L->>T: 执行本 turn 全部 toolCalls(不被 steering 打断)
        T-->>L: toolResults(按源顺序回填)
        L->>L: turn_end
        Note over L: shouldStopAfterTurn()? true → agent_end(不 poll)
        Note over L: ② steering 注入点:drainSteering()<br/>非空 → pending,内层继续(续命)
    end
    Note over L: ③ follow-up 注入点:drainFollowUp()
    alt followUps 非空
        L->>L: pending = followUps;外层 continue(新 turn 续跑)
    else 两队列皆空
        L-->>A: agent_end(reason: 'completed')
        A-->>U: state = 'idle'
    end
```

三个 poll 点的取舍说明:

- **① 起跑前 poll**:pi 的注释场景——用户在 agent 上一次回答的流式输出期间就按 Enter 输入了下一条,消息进了 steering 队列但 agent 已经 idle。下一次 `prompt()` 起跑时先把这些消息捎上,不丢失。
- **② 每 turn 结束后**:唯一的 steering 注入点,位于 `shouldStopAfterTurn` **之后**——优雅停的优先级高于队列(语义 7)。
- **③ agent 即将停止时**:唯一的 follow-up 注入点。内层循环退出(无 toolCall、无 steering)才会到达这里,机械地保证了语义 3。

## 5. 注入形态:模型视角

steering 消息注入后,转录(以及下一次 provider 请求)长这样:

```
user        (source:'prompt')    "重构 auth 模块"
assistant   (tool_calls: [read#1, edit#2])
tool_result (toolCallId: #1)
tool_result (toolCallId: #2)
user        (source:'steering')  "别动 tests/ 目录"     ← 注入点:toolResults 之后
assistant   ...                                          ← 模型带着新指令继续
```

要点:

1. **位置固定在 toolResults 之后**。这保证 wire 层的 `assistant(tool_calls) → tool → tool` 配对完整,steering 消息只是其后的一条普通 user 消息——任何 OpenAI 兼容 provider 都合法。
2. **模型看到的就是一条 user 消息**。`source: 'steering'` 是内部协议字段,adapter 出站时不产生任何 wire 差异(Chat Completions 没有对应概念);它服务于 UI 渲染(排队徽标、消息角标)、持久化统计与测试断言。不用 system 消息或特殊前缀包装——pi 与 codex 均验证裸 user 消息效果最好,模型天然把"工具结果之后的用户发言"理解为即时指令。
3. **注入走完整的消息生命周期**:每条注入消息发 `message_start` / `message_end`(`message: UserMessage`),UI 借此把排队中的消息"转正"为转录消息(配合第 8 节的 id 关联)。
4. follow-up 的注入形态完全相同,只是 `source: 'follow_up'`、注入点在 ③;对模型而言它开启的是"上一任务收尾之后的新指令"。

## 6. steering vs abort:两档打断的分工

| 维度 | steering(温和引导) | abort(硬中断) |
|---|---|---|
| 触发 | `steer()` / Enter | `abort()` / Esc |
| 当前工具 | 全部执行完 | signal 生效,执行中的工具中断,剩余跳过 |
| provider 流 | 不受影响,流完为止 | 立即中断,`stopReason: 'aborted'` |
| 转录 | 追加 user 消息 | aborted assistant 保留;孤儿 toolCall 由 transform 补 |
| agent 状态 | 继续 running(续命) | `agent_end(reason: 'aborted')` → idle |
| 恢复 | 无需恢复 | `continue()` 或新 `prompt()` |
| 队列 | 消费 steering | **队列保留**(pi 同款:Esc 后输入可再编辑重发) |

设计上刻意让两档职责不重叠:steering **永不**中断执行中的任何东西(哪怕是跑 10 分钟的 bash),abort **必然**中断一切。中间档("软打断当前流"——流式期间收到 steering 就提前掐断本次采样)pi 没有做,我们 v1 也不做:它需要在 turn 内部加检查点、且掐断后的半截 assistant 消息同样要走 aborted 修复路径,复杂度接近 abort 却只省一次采样,收益不成比例。

abort 的实现纪律(codex 源码给出的两条重要顺序约束,照抄):

- **先让任务观察到 cancellation,再清理 pending 状态**。codex 的注释明确:若先丢弃 pending approvals,进行中的审批等待会以"拒绝"形态先漏给模型,产生一条假的 denied 结果。我们的 M6 approval 层同理:abort 时先 cancel signal,待任务 settle 后再以 abort 决议清空 `pendingApprovals` 注册表。
- **abort 不清空 steering / follow-up 队列**。用户 Esc 的意图是"停下当前动作",不是"忘掉我刚才排队说的话";排队消息保留,由用户决定重新编辑还是直接 `continue()`。`clearQueues()` 才是显式清空入口。

## 7. abort 后的转录修复:与 transform 层的分工

abort 会在转录里留下两类"伤口":

1. **不完整的 assistant 消息**:`stopReason: 'aborted'`,content 可能是半截文本或参数不全的 toolCall。
2. **孤儿 toolCall**:assistant 发了 N 个 toolCall,abort 时只执行了前 K 个,后 N−K 个没有对应的 ToolResultMessage。

修复责任严格分层:

**agent/queue 层只负责"如实记录"**——aborted assistant 消息照常落转录(错误/中止也是一条合法 AssistantMessage,见 [03 · 内部协议](./03-internal-protocol.md) 的消息模型);未执行的工具**不伪造结果**(pi 的 sequential abort 路径就是检查 signal 后直接 break,不造 toolResult)。转录是事实日志,发生了什么就是什么。

**transform 层负责"出站前修复视图"**——每次发起 provider 请求前(见 [Provider adapter](./04-provider-adapter.md) 的 transform 规格),对 messages 做与 abort 相关的两步:

```ts
// 伪码:transform 层中与 abort 相关的两步(完整四步见 04 文档)
// repairForReplay 是 convertContext(src/agent/transform.ts)内部的 abort 相关修复步骤,
// 此处单独具名只为示意,并非独立导出的第三个函数
function repairForReplay(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of messages) {
    // 1. aborted / error 的 assistant 消息整条跳过,不重放
    if (m.role === 'assistant' && (m.stopReason === 'aborted' || m.stopReason === 'error')) continue;
    out.push(m);
  }
  // 2. 孤儿 toolCall 补合成结果:对每个没有配对 ToolResultMessage 的 toolCall,
  //    紧随其 assistant 消息插入
  //    { role:'tool_result', toolCallId, toolName, isError: true,
  //      content: [{ type:'text', text: '[Tool execution was interrupted]' }] }
  return insertSyntheticResults(out);
}
```

注意两步的作用对象不同:第 1 步过滤的是**被 abort 掐断的那条** assistant(它自身不完整,重放会让模型困惑甚至触发 provider 校验错误——pi 的注释:不完整 turn 重放会触发 API 报错);第 2 步修复的是**完整落盘但工具批次被中断**的 assistant(消息本身合法、必须重放,只是缺 tool_result 配对)。两步合起来保证 Chat Completions 的 `tool_calls` / `tool` 配对永远合法。

**为什么修复放 transform 层而不是 abort 时就地改转录:**

- 转录不可变性:就地修改意味着持久化文件里出现"从未真实发生"的合成结果,session 恢复、usage 统计、UI 历史回放都会被污染。transform 修复是每次请求前的纯函数视图变换,不落盘、幂等、可测试。
- 三个参照系一致:pi 的 `transform-messages.ts`(出站前跳过 aborted/error + 孤儿补合成)、opencode 的 cleanup(悬空 tool call 标 `metadata.interrupted`,**重放时**才转 `"[Tool execution was interrupted]"`)、codex(history 保留,采样前组装视图)。没有一家在 abort 现场改历史。
- 修复规则会随 compat 演进(不同 provider 对孤儿的容忍度不同),放在 agent 的 transform 层(`src/agent/transform.ts`,入口 `convertContext`,规格见 [04](./04-provider-adapter.md)),改规则不触碰 loop 本体。

transform 层的其余职责(跨模型 reasoning 降级、toolCallId 归一化、非视觉模型图片降级)与 steering/abort 无关,规格在 [04](./04-provider-adapter.md)。

## 8. queue_update 事件与 UI 排队徽标

### 8.1 事件发射时机

`queue_update` 在**每次队列内容变化**时发射,载荷是两个队列的完整快照(而非增量):

- `steer()` / `followUp()` 入队后;
- drain 消费时——精确地说,注入消息的 `message_start` 发出之前先发 `queue_update`(该消息已不在快照中);
- `clearQueues()` 之后。

快照式载荷让 UI 无需维护本地状态机:收到事件,整个徽标区重画,完毕。乱序、重连、丢事件都不会造成 UI 与真实队列漂移。

### 8.2 pi 的教训:必须携带 id

pi 的 coding-agent 层在 Agent 队列之外镜像了一份字符串数组(`_steeringMessages`)用于 UI 展示,消息注入时靠**文本匹配**(`indexOf(messageText)`)从镜像中移除——用户连发两条相同文本的 steering 时会误删错位。这是我们源码调研中明确标记"应避免"的缺陷。

我们的修正:`QueuedMessage` 携带 `id`,且该 id 就是注入后 `UserMessage.id`(2.2 节约定)。UI 的关联链条:

```
steer("...") → queue_update(快照含 {id: 'u_42', kind: 'steering'})   → 渲染排队徽标
turn 边界注入 → queue_update(快照不含 u_42)+ message_start(id: 'u_42') → 徽标消失,转录出现该消息
```

全程 id 精确匹配,零文本比较;重复文本、用户撤回重发都不会错乱。CLI 渲染约定(细节在 [09](./09-cli.md)):steering 排队显示为 `» 待注入`、follow-up 显示为 `⋯ 排队中`,附队列序号。headless `--json` 模式下 `queue_update` 原样输出 NDJSON,外部客户端获得同等能力。

## 9. 边界情况清单

逐条为可测试断言,vitest 用 faux provider 全离线覆盖(见 [测试策略](./10-testing.md)):

1. **运行中调用 `prompt()`**:同步 throw,错误文案含 "Use steer() or followUp()" 指引;agent 状态不受影响。
2. **idle 时调用 `steer()`**:合法,消息静置队列;下一次 `prompt()` 起跑前的 poll(注入点 ①)会捎上它。CLI 正常情况下不会走到这条(键位仅流式期间映射为 steer),但 API 用户会。
3. **agent_end 后队列有残留**(`shouldStopAfterTurn` 提前停、abort、one-at-a-time 未消费完等):loop 不自动续;session 层在 `agent_end` 处理器里检查队列非空并按策略调用 `continue()`(语义 7)。
4. **abort 后 `continue()`**:最后一条消息是 aborted assistant → 优先 drain steering 作为新起点(跳过起跑 poll 防双重 drain),否则 drain follow-up,两者皆空 throw。消费了队列消息时 `agent_start.reason` 为 `'follow_up'`;两队列皆空的纯重采样才是 `'continue'`(以 [05](./05-agent-loop.md) §1.2 与 [03](./03-internal-protocol.md) §7.2 为准)。
5. **compaction 期间的输入暂存**:compaction(M7,见 [session 文档](./08-session-persistence.md))运行期间转录正在被摘要重写,此时注入 steering 可能落在即将被丢弃的尾部或被摘要吞掉。照 pi 的做法:session 层在 compaction 进行中把用户输入暂存到第三个临时缓冲,compaction settle 后按原语义(steer/followUp)重放入队。Agent 核心对此无感知——这是 session 层的编排责任。
6. **steering 消息本身触发长任务**:注入的 steering 让模型又发起了大量工具调用——这是语义 2 的正常形态,内层循环继续,follow-up 队列继续等待"真正的结束"。不存在"steering 只能小修小补"的隐含假设,测试需覆盖 steering 后再跑 10+ turn 的场景。
7. **一个 turn 内连发多条 steering(one-at-a-time)**:每个 turn 边界消费一条;若模型不再发工具调用,靠语义 2 逐 turn 续命逐条消费,顺序 = 入队顺序。
8. **`stopReason: 'length'` 的 turn 与 steering**:length 不属于 error/aborted,内层循环不退出;该批 toolCall 全批合成失败结果后照常走 turn_end → steering 注入点。steering 与"参数截断重试"在同一个下轮请求中共存,合法。
9. **abort 恰逢 steering 刚入队**:abort 优先——`agent_end(reason:'aborted')`,队列保留(第 6 节纪律);消息不丢,等 `continue()`。
10. **并行工具执行中 abort**:执行中的工具收到 signal 各自中断;已完成的照常产出结果、按 assistant 源顺序回填,未产出结果的成为孤儿由 transform 补(第 7 节)。
11. **空文本 steer**:`steer('')` / 纯空白入队前 trim 后拒绝(no-op 并返回),避免注入空 user 消息(部分 provider 对空 content 报错)。
12. **`clearQueues()` 时机**:任意时刻可调;仅清空未消费的排队消息,已注入转录的不受影响;随后发 `queue_update` 空快照。

## 10. 对比:codex 的「同一 Op 双语义」与我们的显式双队列

codex 的外协议只有一个用户输入入口:`Op::UserInput`。core 收到后先尝试 `steer_input`——存在 active turn 就把输入 push 进 `turn_state.pending_input`(= steering);返回 `NoActiveTurn` 才 `spawn_task` 开新任务。**同一个 Op,语义由 core 的当前状态决定**,客户端完全无需感知 agent 忙闲。

这个方案的优点是真实的:外协议最小(跨进程时尤其省心)、客户端零状态。但有三个对我们不成立的前提:

1. **codex 表达不了 follow-up。** 任务运行中到达的消息一律按 steering 处理,"排队等当前任务结束再做"这个意图在 codex 协议里不存在(残余 pending input 在 task 结束时自动变成下一任务的输入,但那是"没消费完的 steering",不是用户可选择的投递方式)。我们的核心需求 2 明确要求两种意图都可表达——这一条就否决了单 Op 方案。
2. **语义取决于竞态。** 单 Op 下,同一条消息在 agent_end 前 1ms 到达是 steering、后 1ms 到达是新任务——用户按下 Enter 时无法预知会得到哪种语义。显式双队列下 `steer()` / `followUp()` 任何时刻调用语义恒定:steer 在 idle 时静置等下次起跑捎带(边界 2),followUp 永远等"结束"点。可预测性是本地交互工具的第一优先级。
3. **场景不同。** codex 的双队列(Submission Queue / Event Queue)解决的是 **UI 与 core 跨进程解耦**,单 Op 是那个约束下的最优解;我们是进程内 library + 薄 CLI,`steer()` / `followUp()` 就是两个方法调用,没有协议面积压力。

旁证是 opencode 的演化终点:V1 事实上等价于 codex 的"运行中一律 steering"(写历史 + step 边界拾取),V2 重做时引入的正是显式的 `delivery: "steer" | "queue"` 双投递——与我们的双队列同构。pi 则从第一天就是双队列。三个项目、两条路径、一个终点。

我们同时吸收 codex 方案的合理内核:**headless `--json` 模式**的命令面保留显式的 `{"type":"steer"}` / `{"type":"follow_up"}`(而非单一 user_input),把"显式表达意图"的原则贯穿到外协议;`abort` 对应 codex 的 `Op::Interrupt`,`agent_end.reason` 对应其 `TurnAborted.reason` 的简化版。

## 11. 验收清单

- [ ] `steer()` / `followUp()` 在 idle 与 running 两种状态下均可调用,不 throw;`prompt()` 在 running 时同步 throw 且文案指向前两者。
- [ ] steering 注入点:faux provider 脚本验证注入消息出现在 toolResults 之后、下一次 StreamFn 收到的 Context 中位置正确、`source === 'steering'`。
- [ ] 当前 turn 的工具在 steer 入队后仍全部执行完(工具执行计数断言)。
- [ ] 续命:assistant 无 toolCall + steering 非空 → 内层循环继续;两队列皆空 → `agent_end(reason:'completed')`。
- [ ] follow-up 仅在无 toolCall 且无 steering 时被消费;消费后外层循环续跑,新消息 `source === 'follow_up'`。
- [ ] one-at-a-time:入队 3 条 steering,恰好分 3 个 turn 边界逐条注入;切 `'all'` 后一次注入全部。
- [ ] 起跑前 poll:idle 时 `steer()` 两条 → `prompt()` → 首个 turn 注入(one-at-a-time 注入 1 条)。
- [ ] abort:provider 流以 `stopReason:'aborted'` 收尾;aborted assistant 落转录;下一次请求(经 transform)不含该消息、孤儿 toolCall 均有 `"[Tool execution was interrupted]"` isError 配对结果。
- [ ] abort 不清队列;`clearQueues()` 清空并发空快照 `queue_update`。
- [ ] `continue()`:abort 后优先消费 steering 且不双重 drain;皆空 throw;消费了队列消息时 `agent_start.reason === 'follow_up'`,两队列皆空的纯重采样才是 `'continue'`。
- [ ] `queue_update`:入队、注入、清空三个时机各发一次;快照 id 与注入后 `UserMessage.id` 一致;重复文本消息不错乱(pi 教训的回归测试)。
- [ ] `shouldStopAfterTurn` 返回 true → `agent_end` 且两队列保持原样未被 poll。
- [ ] 边界清单第 5-12 条各有对应测试用例。

## 相关文档

- [05 · Agent 核心循环](./05-agent-loop.md) —— runLoop 骨架、turn 生命周期、工具执行三阶段与 abort 传播
- [04 · Provider 接口与 Chat Completions adapter](./04-provider-adapter.md) —— transform 层完整四步规格、wire 层配对规则
- [09 · CLI 与 REPL](./09-cli.md) —— Enter/Alt+Enter/Esc 键位实现、排队徽标渲染、headless JSON 命令面
- [03 · 内部协议](./03-internal-protocol.md) —— UserMessage.source、QueuedMessage、AgentEvent 全集
