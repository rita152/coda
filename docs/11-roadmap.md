# 交付状态

本仓库不再维护并行的协议迁移路线。当前实现和后续改动均以 canonical Runtime protocol 为唯一事实：

- RuntimeOp 与 EventEnvelope 已成为所有运行期输入/输出边界。
- workspace Supervisor、per-thread mailbox、durable transcript/control 与 per-thread seq 已落地。
- capability registry、冻结 snapshot、canonical resource policy 与 control response 已落地。
- TUI、one-shot 与 `--json` 已统一消费 RuntimePort；headless 使用协议 `2.0.0`。
- Agent loop payload 与 CLI view 仅作为内部/人类前端投影，不是额外的 Runtime protocol。
- 持久化、恢复、duplicate OpId、control、cross-thread concurrency 与 canonical transport 均有单元/集成/e2e 覆盖。

后续工作必须是对现有 canonical 契约的增量演进：新增 RuntimeOp/Event 时同步更新 `src/protocol/`、相关
Runtime writer/reader、本文档集与测试；不得重新引入默认 identity、裸事件、第二条 approval 通道或兼容 transport。
