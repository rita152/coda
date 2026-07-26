// ToolResultMessage 的统一构造:成功输出、错误输出、length 全批合成失败,
// 以及框架级截断 post-hook(docs/07-tools.md §1.6)。所有错误路径产出形态一致
// (pi-mono 同款约定:工具只 throw,不自己构造 error 结果)。

import type { TextPart, ToolCallPart, ToolResultMessage } from '../protocol/index.js';
import type { ToolOutput, TruncatedDetails } from '../tools/types.js';
import { clipHead, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, safeBasename, spillToFile } from '../shared/index.js';
import { newMessageId } from './ids.js';

/** 成功结果:应用框架级截断 post-hook(工具自带截断标记则跳过)。 */
export function toToolResultMessage(
  call: ToolCallPart,
  output: ToolOutput,
  spillDir: string,
): ToolResultMessage {
  const selfTruncated = (output.details as TruncatedDetails | undefined)?.truncated === true;
  const content = selfTruncated ? output.content : applyTruncationHook(call, output.content, spillDir);
  return {
    role: 'tool_result',
    id: newMessageId('tr'),
    timestamp: Date.now(),
    toolCallId: call.id,
    toolName: call.name,
    content,
    isError: false,
    details: output.details,
  };
}

/** 错误结果(prepare 拒绝、execute throw、length 合成批共用)。 */
export function errorToolResult(call: ToolCallPart, message: string): ToolResultMessage {
  return {
    role: 'tool_result',
    id: newMessageId('tr'),
    timestamp: Date.now(),
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** execute throw 的统一格式化:AbortError → 中断文案;其余取 message。 */
export function formatToolError(err: unknown): string {
  if (isAbortError(err)) return 'Tool execution was interrupted';
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * stopReason 'length' ⇒ 全批合成 isError、不执行(docs/05-agent-loop.md §2.4 的硬规则)。
 * 文案必须可执行:告诉模型为什么没执行、下一步怎么办。
 */
export function failTruncatedToolCalls(toolCalls: ToolCallPart[]): ToolResultMessage[] {
  return toolCalls.map((call) =>
    errorToolResult(
      call,
      'This tool call was not executed: the model output was cut off by the output token limit ' +
        '(stopReason: length), so the arguments may be incomplete. ' +
        'Reduce the size of a single response or split the work into multiple smaller tool calls, ' +
        'then resend the complete arguments.',
    ),
  );
}

/**
 * 框架级截断 post-hook:全部 TextPart 合并计额,2000 行 / 48KB 双上限;
 * 超限全文落盘,尾部附可执行续读提示(截断时告诉模型下一步怎么办——
 * 参考项目里回报率最高的一条)。ImagePart 原样保留,不参与计额。
 */
function applyTruncationHook(
  call: ToolCallPart,
  content: ToolOutput['content'],
  spillDir: string,
): ToolOutput['content'] {
  const textParts = content.filter((p): p is TextPart => p.type === 'text');
  if (textParts.length === 0) return content;

  const fullText = textParts.map((p) => p.text).join('\n');
  const clip = clipHead(fullText, { maxLines: MAX_OUTPUT_LINES, maxBytes: MAX_OUTPUT_BYTES });
  if (!clip.truncated) return content;

  const saved = spillToFile(spillDir, `${Date.now()}-${safeBasename(call.id)}.txt`, fullText);
  const savedLine = saved !== undefined ? `\nFull output saved to: ${saved}` : '';
  const note =
    `\n[Output truncated: showing first ${clip.keptLines} of ${clip.totalLines} lines.` +
    `${savedLine}\n` +
    (saved !== undefined
      ? 'Grep or read the saved file to search the full content.]'
      : 'Narrow the request (offset/limit, a tighter pattern, or a smaller scope) to see the rest.]');

  const truncatedPart: TextPart = { type: 'text', text: clip.text + note };
  // 保留非文本 part(图片),文本合并为单一截断块
  return [truncatedPart, ...content.filter((p) => p.type !== 'text')];
}
