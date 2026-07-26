// transform 层的 agent 侧入口:每次出站请求前的固定清洗(规格见 docs/06-steering-following.md
// 与 docs/04-provider-adapter.md)。产出出站副本,绝不改写权威转录——权威转录永远保留
// error/aborted 消息与孤儿 toolCall 的「事实」,清洗只发生在每次出站的视图上。
//
// M3:仅骨架(副本语义就位)。完整规则在 M4 落地:
//   a. stopReason error/aborted 的 assistant 消息跳过不重放;
//   b. 孤儿 toolCall 补 "[Tool execution was interrupted]" isError 合成结果(配对合法性);
//   c. 跨模型 reasoning 降级/剥 signature、toolCallId 归一化;
//   d. 非视觉模型图片降占位文本。

import type { Context, ModelRef } from '../protocol/index.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- modelRef 在 M4 的跨模型降级规则中使用
export function convertContext(ctx: Context, modelRef: ModelRef): Context {
  return { ...ctx, messages: [...ctx.messages] };
}
