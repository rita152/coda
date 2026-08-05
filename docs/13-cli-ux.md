# CLI UX

TUI、human one-shot 与 headless 共用同一 RuntimePort。它们的差异只在输入映射和 presentation，不能改变
RuntimeOp、EventEnvelope、control 或持久化语义。

## TUI

TUI 在完整双 TTY 中启动。它订阅 EventEnvelope 并维护可丢弃的 view model：thread 列表、消息、工具进度、
pending control、usage 和 diagnostics。所有用户动作生成完整 RuntimeOp；thread 切换不改变其它 thread 的
run/queue。Esc/取消提交或触发目标 thread 的 abort，不直接操作 provider。

普通 composer 状态下的无修饰 `↑`/`↓` 在当前 thread 的 prompt 历史中浏览并把选中项写回输入框；
`Ctrl+R` 反向搜索同一历史。弹层（命令菜单、file/command picker、provider 输入、approval/session/diff
面板）可见时，`↑`/`↓` 仍归弹层所有，不做历史切换。

control card 使用 Runtime 给出的 presentation；批准、拒绝和资源确认均提交带 requestId 的
`control_response`。UI 不保存 approval resolver，不从 shell args 重建风险说明。

## One-shot

`exec`/`-p` 的 human output 是 EventEnvelope 的 renderer。完成、error、retry 与 timeout 的退出码由 Runtime
终态决定；renderer terminal result 不写回 transcript。机器可读输出时 progress/warning 走 stderr。
`--output=stream-json` 以 `{type:"stream_start",version:2}` 公告 record schema；event record 使用外层
`{type:"event",envelope}`，其中 `envelope` 是 RuntimePort
交付的完整 EventEnvelope；内部 payload 投影或为了人类终止状态合成的 event 不得写入机器流。

## Headless

`--json` 是 protocol `2.0.0` 的 NDJSON endpoint。它适合自动化、多 thread client 和嵌入宿主：client
自己提供 workspace/thread/op identity，消费 EventEnvelope，并根据 `op_receipt` 与 `transport_error` 作出
重试决策。EOF 是正常关闭，stdout 不混入 banner、颜色或人类日志。

## 可访问性与稳定性

人类界面提供键盘可达、终端尺寸变化处理、颜色降级与明确错误文本。presentation 只能格式化 canonical
数据；未知事件可安全忽略，已知事件的未知字段不得导致崩溃。CLI flag、帮助、completion 与 slash command
共享同一命令目录，避免行为漂移。
