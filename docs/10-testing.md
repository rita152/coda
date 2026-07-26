[← 返回地图](./README.md)

# 10 测试策略(Testing)

本文规定测试金字塔、faux provider 规格、adapter 的 SSE fixture 回放、steering/follow-up 的确定性测试方法、工具测试矩阵、headless e2e 与 CI 建议。测试框架统一用 vitest。

## 1. 测试哲学

三条原则,全部来自参考项目的正反面经验:

1. **默认离线、默认确定**。任何进 CI 的测试不碰网络、不依赖真实模型。能做到的前提是架构本身:agent 只认 `StreamFn`,于是一个脚本化的 faux provider 就能驱动全部循环逻辑;adapter 的流解析是纯函数(opencode V2 把协议做成 `step(state, chunk) → events` 的纯转换,正是为了可单测),于是录制的 chunk 回放即可覆盖。
2. **真实 IO 只出现在它是被测对象的层**。工具测试用真实文件系统、真实 ripgrep、真实子进程——mock 文件系统测 edit 等于没测(CRLF/BOM/mtime 全是真实 fs 行为)。除此之外的层一律无 IO。
3. **协议不变量用测试钉死**。StreamFn 铁律(绝不 throw)、事件三段式语法、tool_calls/tool 配对合法性——这些是文档承诺,每条都要有对应断言,防止实现漂移。

## 2. 测试金字塔

```mermaid
flowchart TB
  E2E["L5 CLI e2e:built 产物 + --json headless(个位数用例)"]
  LOOP["L4 loop 集成:agent + faux provider + 测试工具(数十)"]
  TOOLS["L3 工具:真实 fs / rg / 子进程,tmpdir 隔离(上百)"]
  ADPT["L2 adapter:SSE chunk fixture 回放(数十)"]
  PROTO["L1 protocol:EventStream / 类型不变量(数十)"]
  E2E --> LOOP --> TOOLS --> ADPT --> PROTO
```

| 层 | 位置 | 依赖 | 速度目标 |
|---|---|---|---|
| L1 protocol | `src/protocol/*.test.ts` | 无(零运行时依赖是该目录的架构约束) | 毫秒级 |
| L2 adapter | `src/providers/openai-chat/*.test.ts` + `__fixtures__/` | fixture 文件 | 毫秒级 |
| L3 tools | `src/tools/*.test.ts` | tmpdir、rg 二进制、child_process | 秒级 |
| L4 loop | `src/agent/*.test.ts`、`src/session/*.test.ts` | faux provider | 毫秒级 |
| L5 e2e | `e2e/*.test.ts`(独立 vitest project) | tsup 构建产物 | 数秒 |

L1 要点(不展开):`EventStream` 的 push/end/result 语义(end 后 push 被忽略并产生开发模式警告(console.warn)、迭代器收尾、result 在 end 前 pending)、单消费者迭代顺序、`partial` 快照与 delta 累积一致性的属性测试(随机事件序列折叠后等于 done 消息——对应 opencode `LLMResponse.reduce` 的 reducer 思路)。

## 3. faux provider 详细规格

`src/providers/faux/` 不是测试夹具堆,而是**正式 provider**:实现 `StreamFn`、遵守全部协议不变量,e2e 也用它(CLI `--provider faux`)。它同时是内部协议的可执行规格——faux 自己违反事件语法,L4 全线报警。

### 3.1 接口

```ts
// src/providers/faux/types.ts
export interface Gate { open(): void; readonly opened: Promise<void> }
export function createGate(): Gate;

export type FauxEventSpec =
  | { kind: 'text'; text: string; chunkSize?: number }        // 按 chunkSize 拆成多个 text_delta,默认 8
  | { kind: 'reasoning'; text: string; chunkSize?: number }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown>; id?: string;
      truncatedRaw?: string }                                  // 配合 stopReason:'length' 模拟截断参数
  | { kind: 'gate'; gate: Gate };                              // 暂停发射直到测试放行(受控注入点)

export interface FauxTurn {
  events?: FauxEventSpec[];
  stopReason?: StopReason;    // 缺省推断:有 tool_call → 'tool_calls',否则 'stop'
  error?: { message: string; details?: ProviderErrorDetails }; // 以 error 事件收尾(stopReason 'error')
  usage?: Partial<Usage>;     // 缺省 { input: 100, output: 10 }
  onRequest?: (model: ModelConfig, context: Context, options?: StreamOptions) => void; // 出站断言钩子
}

export interface FauxScript {
  turns: FauxTurn[];
  onExhausted?: 'throw' | 'emptyStop';   // 脚本耗尽:测试默认 'throw'(多余请求即 bug),e2e 用 'emptyStop'
}

export function createFauxStreamFn(script: FauxScript): StreamFn & {
  readonly calls: { model: ModelConfig; context: Context; options?: StreamOptions }[];  // 深拷贝留档
};
```

### 3.2 行为语义

- 第 n 次调用消费 `turns[n]`;调用参数深拷贝进 `calls`,供测试断言 transform 层的出站产物(aborted 消息被过滤了吗、孤儿 toolCall 补结果了吗、steering 注入位置对吗)。**断言出站转录永远用 `calls` / `onRequest`,不要去猜 agent 内部状态**。
- 事件发射逐个 `await Promise.resolve()` 让出微任务,保证消费端观察到真实的流式顺序;**不用计时器**,除 gate 外没有任何时间依赖——这是确定性的根基。
- 严格遵守事件语法:`start` → 各内容块三段式(`*_start`/`*_delta`/`*_end`,contentIndex 递增)→ `done` 或 `error`;每个事件带逐步生长的 `partial` 快照;`tool_call` 的 arguments 分片经容错 JSON 解析持续刷新——与真 adapter 行为一致。
- **铁律同守**:faux 一旦被调用绝不 throw/reject(pi 的 StreamFunction 铁律)。`onExhausted: 'throw'` 的「throw」发生在测试进程的断言层面(通过 `stream.push` 前检测并 fail 测试),不是 StreamFn 抛异常。
- abort:在每个事件发射间隙与 gate 等待中检查 `options.signal`;已 abort 则立即以 `error` 事件收尾,`partial` 保留已发内容,stopReason 'aborted'——精确复刻真 adapter 的中断形态。
- `error` turn:先发 `events` 里的内容(可模拟「流到一半断掉」),再发 `error` 事件,消息带 `errorDetails`(见 [08](./08-session-persistence.md) 5.1),让 retry 分类逻辑可离线测试。
- length 截断:`stopReason: 'length'` + `tool_call` 的 `truncatedRaw`(写入 `rawArguments`,`arguments` 为容错解析结果)——用于验证 loop 层「length + toolCalls 全批合成错误结果不执行」的规则。

### 3.3 gate:受控注入点

gate 是本方案唯一的同步原语,把「时序巧合」变成「显式放行」:

```ts
const gate = createGate();
const streamFn = createFauxStreamFn({ turns: [
  { events: [ { kind: 'text', text: 'thinking...' },
              { kind: 'gate', gate },                    // 流悬停在此
              { kind: 'text', text: 'done' } ] },
]});
agent.prompt('go');
await waitForEvent(events, 'message_update');   // 确认流已开始
agent.steer('改用方案 B');                       // 流式中途注入——必须入队而非立即生效
gate.open();
await agent.waitForIdle();
```

pi 的教训「steering UI 队列靠消息文本 indexOf 匹配回收会误伤重复文本」提醒我们:队列断言一律用 `QueuedMessage.id` 与 `source` 字段,不用文本内容匹配。

## 4. adapter 测试:SSE chunk fixture 回放

### 4.1 结构:把流解析做成可注入 chunk 的纯入口

openai-node 的 `ChatCompletionStream.ts` 内部处理了大量累积边界(tool_calls 按 index 拼装、usage 尾 chunk、in-band error)。我们决定不用这个 helper(事件粒度与错误策略不匹配,见 [04](./04-provider-adapter.md)),等于把这些边界全接到自己手里——**必须用 fixture 回放守住同等覆盖**。为此 adapter 内部拆出纯函数入口,测试不 mock openai SDK、不碰网络:

```ts
// src/providers/openai-chat/consume.ts(内部模块,测试直接 import)
export function consumeChatStream(
  chunks: AsyncIterable<unknown /* ChatCompletionChunk 形状,不 import openai 类型到签名 */>,
  init: { model: ModelRef; compat: CompatFlags },
  out: ProviderEventStream,
  signal?: AbortSignal,
): Promise<void>;
```

fixture 是 JSONL:一行 = 一条 SSE `data:` 的 JSON payload,存 `src/providers/openai-chat/__fixtures__/`。测试 helper `replayFixture(name, compat?)` 返回 `{ events: ProviderEvent[]; final: AssistantMessage }`。

```jsonl
{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":""}}]},"finish_reason":null}]}
{"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":\"a.ts\"}"}},{"index":1,"id":"call_b","function":{"name":"grep","arguments":"{\"pattern\":\"x\"}"}}]},"finish_reason":null}]}
{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
{"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":31}}
```

### 4.2 fixture 清单(canonical,M2 验收项)

| fixture | 场景 | 关键断言 |
|---|---|---|
| `basic-text.jsonl` | 正常文本流 | `start` → `text_start/delta*/end` → `done`;拼接 content 与 `text_end.content` 一致;stopReason 'stop' |
| `parallel-tool-calls.jsonl` | 两个 tool_calls 按 `index` 交错分片 | 按 index 定位槽位不串包;arguments 逐段拼接;流式期间容错解析持续刷新 `arguments`;两个 `tool_call_end`;stopReason 'tool_calls' |
| `usage-chunk.jsonl` | `include_usage` 的尾 chunk(`choices:[]`) | 空 choices 的 usage chunk 不 crash;Usage 换算为 inclusive 口径(含 cached/reasoning 明细字段映射) |
| `usage-missing.jsonl` | provider 未发 usage chunk | usage 各字段为 0/undefined,无 NaN;done 正常 |
| `length-truncated.jsonl` | `finish_reason:"length"` 且 arguments 半截 JSON | 照常产出 ToolCallPart;`rawArguments` 保留原始截断串;stopReason 'length'(不执行是 loop 层的事,adapter 不管) |
| `in-band-error.jsonl` | 流中 `data: {"error":{...}}` | `error` 事件;stopReason 'error';errorMessage 含 code/message;errorDetails 分类正确 |
| `missing-tool-call-id.jsonl` | delta.tool_calls 无 `id` 字段 | 兜底生成 `call_<uuid>`;同一槽位后续 delta 仍归并到同一 toolCall;两次回放 id 不冲突 |
| `reasoning-content.jsonl` | 第三方方言 `delta.reasoning_content` | compat.reasoningFormat 开启时产出 ReasoningPart 与 `reasoning_*` 三段事件;关闭时忽略不 crash |
| `empty-choices-keepalive.jsonl` | 中途出现 `choices:[]` 且无 usage 的 chunk | 静默忽略;后续 chunk 正常处理 |
| `text-then-tool.jsonl` | 同一响应先文本后 tool_calls | contentIndex 正确递进;`text_end` 在 `tool_call_start` 前 |
| `content-filter.jsonl` | `finish_reason:"content_filter"` | 走 done 分支正常收尾;stopReason 'content_filter' |

fixture 之外的两个错误路径用单测直接构造(无法录成 chunk):SDK `create()` reject(APIError with status)→ 流内 `error` 事件、绝不向外抛(**铁律测试**:对每种错误注入方式断言 `streamFn` 调用本身 never rejects);`APIUserAbortError` → stopReason 'aborted'。

### 4.3 录制与维护

`scripts/record-fixture.ts`:读 `OPENAI_API_KEY` 环境变量,对真实 endpoint 发起带 `stream:true` 的请求,把每条 chunk 原样写 JSONL(脱敏:去 headers、request id 可保留)。**手动运行、fixture 入库**;CI 永不联网。第三方方言(DeepSeek 等的 `reasoning_content`)同法录制。fixture 一经断言固化,升级 `openai` 包大版本时先跑回放——SDK 变更影响一目了然。

## 5. loop 集成测试(L4):steering / follow-up / abort 的确定性方法

全部用 faux provider + 测试工具(`ToolDefinition` 的极简实现,execute 可挂 gate)。事件序列断言用「归一化快照」:收集 AgentEvent 流,剥掉 timestamp/id/usage 后 snapshot 事件 type 序列——gemini-cli 的工具状态机思路,状态迁移序列本身就是规格。

关键用例:

1. **steering 在 turn 边界注入,不打断工具**:turn1 返回 tool_call,工具 execute 挂 gate;工具执行中 `steer()`;放行后断言:(a) `calls[1].context` 中 steering user 消息(source:'steering')紧跟 toolResult 之后;(b) 事件序列为 `tool_execution_end → turn_end → message_start(user/steering) → turn_start` 的相对顺序;(c) 工具没有被中断(结果非 isError)。
2. **steering 续命**:turn1 纯文本(stop),但流式期间(gate)注入 steering → 断言 agent 未结束、发起第 2 次请求;队列空 + 无 toolCall 时才 agent_end。
3. **follow-up 只在收尾时消费**:turn1 纯文本;流式期间 `followUp()` → turn1 结束后断言 agent 继续(`calls[1]` 含 source:'follow_up' 消息)且中间无 `agent_end`;对照组:同场景用 steer,注入时机相同、结果一致但 `queue_update` 内容不同——两队列语义差异在「turn 中还有工具」的场景才分化,补一个 turn1 带 toolCall 的对照用例。
4. **one-at-a-time vs all**:连注 3 条 steering,默认模式断言每个注入点只取最老一条(`calls` 逐次多一条);切 'all' 断言一次取空。
5. **abort 全链路**:流式中途 abort(faux 在 gate 处感知 signal)→ assistant stopReason 'aborted' 入转录;`continue()` 后用 `calls` 断言 transform 产物:aborted 消息被过滤、孤儿 toolCall 已补 `[Tool execution was interrupted]` 结果。工具执行中 abort → 工具收到 signal、结果 isError。
6. **length + toolCalls 不执行**:faux turn stopReason 'length' 带 truncatedRaw → 断言工具 execute 从未被调用(spy)、全批合成错误结果回喂、loop 继续。
7. **校验失败回喂不终止**:faux 发未知工具名 / 非法参数的 tool_call → 断言合成 isError 结果内容含「可用工具列表 / 请修正参数」文案且下一 turn 照常发起(opencode 的 `invalid` 工具与「请按 schema 重写输入」文案是该行为的出处)。
8. **parallel 与 sequential**:两个 gate 工具并行批次,断言并发执行、结果按源顺序回填;批内含 `executionMode:'sequential'` 工具(bash)时整批顺序。
9. **retry / compaction(M7,session 层)**:faux turn1 `error{ details: { kind:'http', status:500, retryable:true } }`、turn2 成功 → vitest fake timers 断言退避时长、`agent_end.willRetry === true`、`retry_scheduled` 事件、`calls[1]` 与 `calls[0]` 出站一致(失败消息被过滤);overflow kind → 断言走 compaction 而非退避。compaction 用「faux usage 报高 input」触发阈值,断言 shouldStopAfterTurn 停跑、摘要请求(也是一次 faux call)、续跑后出站消息数骤减且首条为 synthetic summary。

Session 持久化集成测试同层:真实 tmpdir 下 create → 跑脚本 → 直接丢弃 Session 对象(模拟 kill)→ resume → 断言转录/usage/compaction 状态复原;尾行截断文件的恢复(手工 truncate 文件尾)。

## 6. 工具测试(L3):真实文件系统

每个测试 `beforeEach` 建独立 tmpdir 作为 `ToolContext.cwd`,`afterEach` 清理;FileTracker 每测试新建。

### 6.1 edit 工具测试矩阵

edit 是全项目风险密度最高的工具。矩阵按「匹配层级 × 文件形态 × 约束」展开,每行一个独立用例:

| # | 场景 | 期望 |
|---|---|---|
| 1 | 精确匹配单处命中 | 替换成功,details 含合法 unified diff |
| 2 | oldText 出现 2 次且无 replaceAll | isError,错误信息含出现次数与消歧建议 |
| 3 | `replaceAll: true` 多处命中 | 全部替换 |
| 4 | oldText === newText | isError(无意义编辑) |
| 5 | oldText 为空串 | isError(新建文件走 write) |
| 6 | CRLF 文件 + LF 风格 oldText | 剥离-匹配-还原:命中且输出保持 CRLF |
| 7 | UTF-8 BOM 文件 | BOM 保留在输出首部 |
| 8 | 智能引号/em-dash:磁盘是 `"…"`,oldText 是 ASCII `"..."` | 精确失败 → fuzzy 归一化命中;**未触碰行逐字节与原文件相等**(行 overlay 断言) |
| 9 | NFKC:全角字符差异 | 同上,fuzzy 命中且保留原字节 |
| 10 | 行尾空白差异(trailing spaces) | fuzzy 命中 |
| 11 | 真实内容差异(改了词) | fuzzy 不得命中,isError——零风险层绝不做编辑距离(aider 作者把 fuzzy 匹配 return 成死代码的教训:激进模糊匹配宁可没有) |
| 12 | 未 read 直接 edit | isError:read-before-edit 硬约束 |
| 13 | read 后文件被外部修改(测试里 utimes/重写)再 edit | isError:mtime 变新 |
| 14 | read → edit 成功 → 再 edit | 成功:FileTracker 在成功写入后自动刷新登记 |
| 15 | 多 edits 顺序应用 | 后一 edit 作用在前一 edit 的结果上;中途失败则整体不落盘(原子性) |
| 16 | parallel 批次中两个 edit 同一路径 | 串行化执行,结果无交错(同路径写锁) |
| 17 | write 覆盖已读旧文件 | 与 12/13 同约束;write 新文件自动建目录 |

### 6.2 bash 工具

| 场景 | 方法与期望 |
|---|---|
| timeout | `sleep 5` + timeout 1s → isError,输出解释超时原因与下一步建议;耗时 ≈1s(上限断言,防没生效) |
| kill tree | 命令内 spawn 孙进程(`sh -c 'sleep 30 & sleep 30'`);超时/abort 后按记录的 pgid 检查无存活进程——detached 进程组 + killProcessTree 是 pi/opencode 共同做法,必须有测试钉住 |
| abort | 长命令执行中触发 signal → 进程组被杀,结果 isError 且说明被中断 |
| tail 截断 | 产出 5000 行 → 结果保留尾部 2000 行/50KB,附完整输出落盘路径且该文件存在、内容全量(错误信息在尾部,所以保尾不保头) |
| onUpdate 节流 | 持续输出的命令,收集 update 时间戳,相邻间隔 ≥ 100ms(允许首条例外) |
| exit code | 非零退出 → isError,输出含 exit code;stderr 并入输出 |
| workdir | 指定 workdir 后 `pwd` 输出验证;不存在的 workdir → isError |

计时类断言给宽松上下界(如 0.9s–3s),并标注为「宽松时序用例」;L3 是唯一允许真实时间流逝的层。

### 6.3 read / grep / glob(要点)

- read:offset/limit 的 1-indexed 语义与 `N: text` 前缀;单行 2000 字符截断;二进制检测(写入含 NUL 的文件);不存在路径返回相似文件名候选(tmpdir 里放近似名文件);读取后 FileTracker 有登记。
- grep:大 fixture 下 `limit=100` 达到即 kill rg(断言结果条数与进程退出);literal 与正则模式;行长 500 截断。
- glob:touch 控制 mtime,断言 24h 内修改的文件排最前。

## 7. e2e(L5):headless --json 驱动完整会话

headless 模式(stdin JSON 命令、stdout NDJSON AgentEvent,见 [09](./09-cli.md))本身就是「内部协议对外暴露」的验证,e2e 直接以它为接口驱动 **tsup 构建产物**——codex 的 `exec` 模式同思路,机器可驱动的入口让 e2e 不需要 PTY 仿真。

```
harness:
  child = spawn('node', ['dist/coda.js', '--json', '--provider', 'faux',
                         '--faux-script', 'e2e/scripts/<case>.json', '--cwd', tmpdir])
  写 stdin: {"type":"prompt","text":"..."}\n
  逐行读 stdout NDJSON → 事件断言(带 30s 看门狗)
```

`--faux-script` 是 FauxScript 的可序列化子集(events + stopReason + usage,无回调无 gate)。用例:

1. 纯文本对话:事件序列 `agent_start → message_* → agent_end(completed)`,退出码 0。
2. 工具回路:脚本让模型 read tmpdir 里的预置文件,断言 `tool_execution_*` 事件与 tool_result 内容。
3. steer:脚本 turn1 调 bash 工具跑 `sleep 0.5`;harness 观察到 `tool_execution_start` 后写入 steer 命令,断言后续出现 source:'steering' 的 message_start。文件脚本没有 gate,这里依赖 0.5s 窗口——**e2e 是唯一允许这种宽松时序的层**,该用例标记 `retry: 1`;其精确版本已在 L4 用 gate 钉死,e2e 只验「管道通」。
4. abort:写 abort 命令,断言 agent_end(aborted)、进程干净退出。
5. resume:会话 1 跑完退出,`--resume <id>` 启动会话 2,断言首个事件前的转录回显/usage 与会话 1 一致。

## 8. CI 建议

- **矩阵**:GitHub Actions,`os: [ubuntu-latest, macos-latest] × node: [20, 22]`。Windows 不进 v1 矩阵(bash 工具依赖 POSIX 进程组),CRLF 相关行为已由 L3 用例在 POSIX 上覆盖文件内容层面。
- **步骤**:`npm ci` → lint → `tsc --noEmit` → vitest(L1–L4)→ `tsup` 构建 → e2e(L5)。总预算 < 5 分钟,L1–L4 < 60 秒。
- **边界规则自检**:lint 步骤跑 `import/no-restricted-paths`(`openai` 只准出现在 `src/providers/openai-chat/`);另加一个「守卫的守卫」测试——程序化调用 ESLint 检查一段违规 import 片段,断言规则确实报错。opencode V1 的 `tools: Record<string, ai.Tool>` 类型泄漏说明:边界靠自觉必失守,必须机械强制且强制本身要有测试。
- **无密钥**:CI 环境不配置任何 API key;`record-fixture.ts` 只在开发者本机手动跑。可选:manual-dispatch 的 nightly workflow 用 secret 对真实 API 做一次冒烟(basic-text + tool call),失败只告警不 block。
- **flake 政策**:只有 §7 用例 3 允许 `retry: 1`;其余任何测试出现 flake 按 bug 处理(几乎总意味着漏了 gate 或用了真实计时器)。
- **覆盖率**:v8 provider;对 `src/protocol`、`src/agent`、`src/providers/openai-chat` 设行覆盖阈值 90%,`src/cli` 不设(渲染逻辑靠 e2e 冒烟)。
- **确定性守则**(写进 CONTRIBUTING):测试内禁用裸 `setTimeout` 等待(用 gate 或事件等待);id/timestamp 经注入的 idgen/clock 或快照归一化;快照只对「事件 type 序列」做,不对含时间戳的完整对象做。

## 9. 验收清单

- [ ] M1:L1 全绿;faux provider 通过「事件语法自检」用例集(每种 FauxTurn 形态产出的事件序列合法、铁律成立)。
- [ ] M2:§4.2 全部 11 个 fixture 入库且断言通过;两个错误路径单测(reject 不外抛、abort 映射)通过;`record-fixture.ts` 可用。
- [ ] M3:工具矩阵(§6)全绿,macOS 与 Linux 双平台;bash kill tree 用例验证无孤儿进程。
- [ ] M4:§5 用例 1–8 全绿,steering/follow-up/abort/transform 的断言全部基于 `calls` 与事件序列,无一处依赖真实时间。
- [ ] M5:session 持久化集成测试(kill/resume/尾行截断)与 e2e 用例 1–5 全绿。
- [ ] M7:§5 用例 9(retry/compaction)全绿。
- [ ] CI:双 OS × 双 Node 矩阵稳定通过,总时长 < 5 分钟;边界规则自检在位。

## 相关文档

- [03 内部协议](./03-internal-protocol.md) —— 被 L1 与 faux provider 钉死的事件语法与不变量
- [04 Provider adapter](./04-provider-adapter.md) —— fixture 覆盖的 chunk 边界与 CompatFlags 语义
- [07 工具集](./07-tools.md) —— edit/bash 等被测行为的规格出处
- [09 CLI](./09-cli.md) —— headless --json 模式,e2e 的驱动接口
