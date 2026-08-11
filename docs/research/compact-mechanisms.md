# Coda 与 Codex、Pi、OpenCode、grok-build 的上下文压缩机制

研究日期：2026-08-11。以下结论基于本地源码快照：Coda `a8a7b06413a6`、Codex `f93109615ff2`、Pi `958c13f25080`、OpenCode `bc2d3df05f88`、grok-build `393430ee4934`。

## 结论

- Coda 当前**没有 compaction**。它只有 fail-closed 的 context-capacity guard：调用前估算完整请求，真实 provider 请求前再次检查，若超限就失败；provider 报告的 overflow 也被归一化为不可重试错误。源码和 ADR 都明确要求不得静默截断、丢弃或总结历史（`docs/adr/0028-fail-closed-on-context-overflow.md:5-7`，`packages/coding-agent/src/prompt/context-budget.ts:9-35`，`packages/ai/src/diagnostics.ts:36-92`）。
- Coda 的 durable session 是 append-only JSONL，但 v1 明确推迟 branching、compaction 和 summaries；Agent 每次请求仍把内存里的全部消息发给模型（`docs/adr/0016-persist-interactive-sessions-as-jsonl.md:5-11`，`packages/agent/src/agent.ts:648-669`）。
- 对 Coda 最合适的第一版不是直接复制 grok-build 的复杂全替换管线，而是组合 Pi 的“摘要 + 精确保留最近尾部”和 Codex 的“精确 replacement-history checkpoint / context-window identity”。

必须区分两层：

1. **durable transcript**：磁盘上保存完整事实，可用于审计、恢复、分支或 rewind；
2. **model-visible context**：下一次 provider 调用真正收到的消息，可以由 checkpoint、摘要和最近尾部重新构造。

成熟实现通常保留前者、替换后者；“清空新会话”也不是 compaction，因为它没有携带摘要或 continuation state。

## Coda：当前是超限保护，不是压缩

- 预算输入包括 system prompt、全部历史消息、新 user input 和全部 tool schemas。估算规则是序列化 UTF-8 bytes / 3，图片另计 8192 tokens；输出预留为 `min(model.maxTokens, 16384, contextWindow / 4)`（`packages/coding-agent/src/prompt/context-budget.ts:9-35,47-62`）。
- 检查发生在初始运行、每次新 Run 准备阶段，以及物化出 provider `Context` 后、真正 stream 前，因此 Tool Result 把上下文撑爆时下一次模型调用会被挡住（`packages/coding-agent/src/application.ts:1363-1369,1391-1397,1415-1421`；测试：`packages/coding-agent/test/context-overflow.test.ts:28-74`）。
- Agent runtime 的 reducer 只线性追加 user、assistant、tool-result；`#streamAttempt` 每次复制全部 `runtimeState.public.messages`，没有选择边界、摘要节点或替换历史（`packages/agent/src/reducer.ts:65-100`，`packages/agent/src/agent.ts:648-669`）。
- provider overflow 被映射为 `context_overflow` 且 `retryable=false`；retry ADR 也明确排除 context overflow（`packages/ai/src/diagnostics.ts:36-92`，`docs/adr/0017-retry-attempts-before-tool-execution.md:5-7`）。
- ADR 说交互用户“可开始新空 Session”，但对应 issue 仍为 `ready-for-agent`；当前实际行为是失败后仍留在原 oversized Session（`.scratch/coda-coding-agent/issues/01-offer-empty-session-after-overflow.md:1-16`）。

## Codex：上下文窗口 checkpoint，远端原生压缩优先

- 自动触发基于 provider usage / 活跃 context-window 状态；当模型需要 follow-up 或有 pending input，且 token limit 或显式 new-context 请求到达时，可在同一 turn 中途 compact 后继续（`/Users/zp/Desktop/codex/codex-rs/core/src/session/turn.rs:371-443`）。模型切到更小窗口时也会 pre-turn compact（同文件 `1047-1141`）。
- 路由顺序是实验性的 `TokenBudget` reset、支持远端压缩时 remote v2/v1、否则 local summary。`RemoteCompactionV2` 是 stable 且默认开启；`TokenBudget` 默认关闭（`/Users/zp/Desktop/codex/codex-rs/core/src/session/turn.rs:1149-1225`，`/Users/zp/Desktop/codex/codex-rs/features/src/lib.rs:1337-1341,1450-1455`）。
- local 模式把现有 history 加上 compact prompt 重新请求模型；若这个请求自己 overflow，就逐项删除最老 history 直到能总结。成功后保留受限数量的原始 user messages，加摘要和重新生成的 canonical initial context，替换模型可见 history（`/Users/zp/Desktop/codex/codex-rs/core/src/compact.rs:241-393,526-549,622-695`）。
- remote v2 让 Responses 流返回模型原生 `Compaction` item；remote v1 调 `/responses/compact`。两条远端路径都会过滤或重写不适合跨窗口携带的内容，并重新注入当前 canonical context（`/Users/zp/Desktop/codex/codex-rs/core/src/compact_remote_v2_attempt.rs:30-135`，`/Users/zp/Desktop/codex/codex-rs/core/src/compact_remote.rs:320-466`）。
- 持久化不是只记一段摘要：`CompactedItem` 保存精确 `replacement_history`、窗口序号和窗口链 IDs；恢复时以 checkpoint 替换 history，再重放其后的 rollout suffix（`/Users/zp/Desktop/codex/codex-rs/core/src/session/mod.rs:3212-3257`，`/Users/zp/Desktop/codex/codex-rs/protocol/src/protocol.rs:3240-3257`，`/Users/zp/Desktop/codex/codex-rs/core/src/session/rollout_reconstruction.rs:318-381`）。

## Pi：结构化迭代摘要 + 精确保留最近尾部

- 默认启用；预留 16,384 tokens，并精确保留最近约 20,000 tokens。触发条件是 `contextTokens > contextWindow - reserveTokens`（`/Users/zp/Desktop/pi/packages/coding-agent/src/core/compaction/compaction.ts:126-136,235-238`）。
- token 计数优先使用最后一个有效 assistant usage，再估算其后的消息；aborted/error/zero-usage 响应不被当成可靠基线（同文件 `146-230`）。
- cut point 从后向前选择，保护 tool call/result 关系；通常保留完整最近尾部。单 turn 自己过大时允许在 turn 内切分，但会把被切掉的 turn prefix 单独总结，以衔接保留的 suffix（同文件 `308-461,710-918`）。
- 摘要是结构化 continuation state，包含目标、约束、进展、决策、下一步和关键上下文；重复 compact 时把 previous summary 作为迭代输入，并累积文件读写信息（同文件 `467-685,710-789`）。
- durable history 不被删。`CompactionEntry` 保存 summary、`firstKeptEntryId`、tokensBefore 等；构造模型上下文时取最新 compaction summary，再接从 `firstKeptEntryId` 开始的原消息和 checkpoint 后的新消息，且按当前 tree leaf 生效（`/Users/zp/Desktop/pi/packages/coding-agent/src/core/session-manager.ts:69-80,410-470,1096-1119`）。
- 对 provider 显式/静默 overflow 或可恢复的 length stop，Pi 会 compact 并自动重试一次；阈值型 compact 不自动重试。失败 assistant 只从活跃上下文移除，durable session 仍保留（`/Users/zp/Desktop/pi/packages/coding-agent/src/core/agent-session.ts:1950-2053`）。

## OpenCode：桌面当前 legacy 路径与 V2 迁移路径并存

### 当前桌面 / HTTP 路径

- 当前 session handler 的 prompt 与 summarize 仍调用 legacy `SessionPrompt` / `SessionCompaction`，所以不能把 `packages/core` 的 V2 直接描述成桌面现状（`/Users/zp/Desktop/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:273-305`）。
- 自动 overflow 用实际 assistant token total 与 usable context 比较；默认 reserve 至多 20k output tokens（`/Users/zp/Desktop/opencode/packages/opencode/src/session/overflow.ts:8-34`）。
- 默认精确保留最多最近 2 turns，尾部预算为 usable context 的 25%，并夹在 2k 到 8k 之间；超大 turn 可在 message 边界切分（`/Users/zp/Desktop/opencode/packages/opencode/src/session/compaction.ts:28-34,80-120,188-239`）。
- 总结时隐藏上一轮 marker/summary，迭代 previous summary；图片等 media 被剥离，tool output 限制为 2,000 chars，summary 请求不带 tools/system。若 summary 请求本身仍 overflow，则给出终止错误（同文件 `289-419`）。
- `CompactionPart` 和 `tail_start_id` 保存在 durable session；下一次模型上下文重排成 compaction marker/summary、精确保留尾部和更新消息。overflow 场景还会 replay 最近真实 user request 或注入 synthetic continue（同文件 `415-536`；`/Users/zp/Desktop/opencode/packages/opencode/src/session/message-v2.ts:521-571`）。
- 另有可配置的 prune：只在 `cfg.compaction.prune` 为真时，把旧 tool output 标记为 compacted，使模型看到 placeholder；默认并非必走主压缩路径（`/Users/zp/Desktop/opencode/packages/opencode/src/session/compaction.ts:241-287`）。

### `packages/core` V2

- V2 默认 buffer 20k、keep 8k、summary output 4096，并生成固定结构摘要（`/Users/zp/Desktop/opencode/packages/core/src/session/compaction.ts:12-46,114-125`）。
- V2 把历史序列化成纯文本，选出 `head` 与 `recent` 字符串；它甚至可能按字符切开一条序列化消息，因此不具备 Pi 那样的结构化 tool-pair 边界保证（同文件 `74-159`）。
- runner 在每 turn 重载 durable history，preflight compact 后重建请求；provider overflow 只做一次 compact-and-retry，第二次终止（`/Users/zp/Desktop/opencode/packages/core/src/session/runner/llm.ts:173-289,355-381`）。
- checkpoint 在模型侧被转换为一个 historical、非指令性的 `<conversation-checkpoint>` user message，包含 summary 与 serialized recent context（`/Users/zp/Desktop/opencode/packages/core/src/session/runner/to-llm-message.ts:147-165`）。

## grok-build：全量替换 + 多级降级 + 精确 checkpoint

- 默认 auto threshold 是 85%，summary model 默认沿用当前 session model；two-pass prefire 默认关闭（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-agent/src/compaction.rs:9-45`）。支持手动 `/compact [context]`（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md:27-36`）。
- pre-sampling 使用“上次精确 usage + 之后消息的 byte estimate”，因此包含新 tool results；此外还有 post-tool overflow preflight、model-downshift 和 provider metadata 所揭示的实际小窗口触发（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs:1811-2003`，`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:2091-2115,2710-2720`）。
- 正常 grok-build shell 路径是 full replace：默认以 verbatim conversation 生成 9 段结构摘要，并重建 system、user metadata、AGENTS/project instructions、最后真实 user query、summary 和包含 task/subagent/MCP/todo/plan 的 system reminder（`/Users/zp/Desktop/grok-build/crates/common/xai-grok-compaction/src/code_compaction/templates/full_replace_summary_prompt.txt:1-19`，`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs:901-1115,1436-1615`）。
- shell 明确调用 `state_context.for_compaction()`；这个 view 把 `recent_messages` 清空，因此当前默认 full-replace 路径不保留一段精确 assistant/tool 尾部，只保留最后真实 user query、summary 与重建的 live state（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs:1597-1615`，`/Users/zp/Desktop/grok-build/crates/codegen/xai-chat-state/src/compaction_utils.rs:604-624`）。
- summary 请求自己超限时走 `verbatim -> verbatim_fitted -> lossy` 输入阶梯；fitted 为 summary 留 32,768 tokens，lossy 使用约 70% context 并移除 tool results/reasoning/images 等（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/compaction.rs:970-981,1051-1070,1148-1215`，`/Users/zp/Desktop/grok-build/crates/codegen/xai-chat-state/src/compaction_utils.rs:74-122`）。
- exact compacted model history 写入独立 checkpoint JSON，`updates.jsonl` 只写轻量 marker；replay/rewind 能跨 compaction 恢复模型当时看到的精确 history（`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/extensions/notification.rs:1263-1327`，`/Users/zp/Desktop/grok-build/crates/codegen/xai-grok-shell/src/session/helpers/replay.rs:33-120,282-449`）。
- 默认是 summary-only，但可选 `Transcript` 指向原始 `updates.jsonl`，或 `Segments` 生成可按需读取的 Markdown 片段。这是其他四个项目没有的 out-of-band detail recovery（`/Users/zp/Desktop/grok-build/crates/codegen/xai-chat-state/src/compaction_mode.rs:7-20`）。
- 仓库共享 compaction crate 还包含用于 Grok chat 的 intra/inter compaction（保留 tail、分块总结等），但 grok-build shell 的主会话路径使用 `code_compaction` full replace，不能混为一谈（`/Users/zp/Desktop/grok-build/crates/common/xai-grok-compaction/src/lib.rs:1-38`）。

## 对 Coda 的设计建议

第一版建议采用以下最小闭环：

1. 新增 append-only `CompactionRecord`，不修改或删除旧 JSONL。至少记录 summary、`firstKeptMessageId`、`replacementHistory`、tokens before/after、model、prompt hash/version、trigger、parent/window IDs。
2. 模型上下文从最新 checkpoint 重建：canonical system/project/skill/tool context + compact summary + 有界的精确 recent tail + checkpoint 后新消息。
3. cut point 只落在合法 turn/tool-pair 边界；summary 请求可以截断 tool body，但被保留的主上下文不得静默改写。
4. 触发点至少覆盖 user prompt 前、tool results 后；优先用 provider actual usage，估算作增量补充。提供手动 `/compact [focus]`。
5. provider overflow 允许一次 compact-and-retry；第二次 fail closed，防止循环。
6. JSONL 先保持线性，也应从一开始给 checkpoint 预留 parent/window identity，以免未来 branching/replay 再迁移格式。

这条路线继承 Pi 的 continuation fidelity、Codex 的 deterministic replay，以及 Coda 已有的 fail-closed 安全边界；grok-build 的 transcript/segments 和 two-pass 可以等第一版稳定后再考虑。
