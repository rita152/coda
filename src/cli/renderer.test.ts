// Renderer 单测(docs/09 §4 渲染对应表):假 WriteStream 收集写入串,驱动事件序列。
// plain 模式断言关键内容(文本 delta 拼接、工具头、steering 回显、aborted 标记、徽标文案、
// 零 ANSI);ANSI 模式断言不炸 + 含清区序列 \x1b[<n>F\x1b[J 与 bracketed paste 开关。

import { describe, expect, it } from 'vitest';
import type {
  AgentMessage,
  AssistantMessage,
  ProviderEvent,
  QueuedMessage,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import type { SessionUsage } from '../session/index.js';
import {
  charWidth,
  createRenderer,
  displayWidth,
  sanitizeDynText,
  tailToWidth,
  toolHeadline,
  truncateToWidth,
} from './renderer.js';
import type { Renderer } from './renderer.js';

class FakeOut {
  chunks: string[] = [];
  columns = 80;
  isTTY = true;
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

function makePlain(): { out: FakeOut; r: Renderer } {
  const out = new FakeOut();
  const r = createRenderer(out as unknown as NodeJS.WriteStream, { color: false, interactive: false });
  return { out, r };
}

function makeAnsi(): { out: FakeOut; r: Renderer } {
  const out = new FakeOut();
  const r = createRenderer(out as unknown as NodeJS.WriteStream, { color: true, interactive: true });
  return { out, r };
}

const MODEL = { provider: 'faux', api: 'faux', model: 'faux-1' };

function am(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    id: 'a1',
    timestamp: 0,
    content: [],
    model: MODEL,
    stopReason: 'stop',
    usage: { input: 100, output: 10 },
    ...over,
  };
}

function um(text: string, source?: UserMessage['source']): UserMessage {
  return {
    role: 'user',
    id: 'u1',
    timestamp: 0,
    content: [{ type: 'text', text }],
    ...(source !== undefined && { source }),
  };
}

function tr(over: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: 'tool_result',
    id: 't1',
    timestamp: 0,
    toolCallId: 'call_1',
    toolName: 'read',
    content: [{ type: 'text', text: '1: hello' }],
    isError: false,
    ...over,
  };
}

function textDelta(delta: string): ProviderEvent {
  return { type: 'text_delta', contentIndex: 0, delta, partial: am() };
}

const qm = (id: string, kind: QueuedMessage['kind']): QueuedMessage => ({ id, text: `msg ${id}`, kind });

describe('plain 模式渲染(docs/09 §4)', () => {
  it('text_delta 直写拼接,text_end 补换行', () => {
    const { out, r } = makePlain();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('Hel') });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('lo') });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'text_end', contentIndex: 0, content: 'Hello', partial: am() },
    });
    expect(out.text).toContain('Hello\n');
  });

  it('reasoning_delta 无 color 时按原文输出', () => {
    const { out, r } = makePlain();
    r.render({ type: 'message_start', message: am() });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_delta', contentIndex: 0, delta: 'thinking hard', partial: am() },
    });
    expect(out.text).toContain('thinking hard');
    expect(out.text).not.toContain('\x1b');
  });

  it('工具头单行摘要:bash 取 command 首行(docs/09 §4 表)', () => {
    const { out, r } = makePlain();
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'npm test\necho second-line' },
    });
    expect(out.text).toContain('● bash: npm test');
    expect(out.text).not.toContain('second-line');
  });

  it('工具头:read 带 offset/limit,edit 带 edits 数', () => {
    expect(toolHeadline('read', { path: 'src/a.ts', offset: 200 })).toBe('read src/a.ts [offset=200]');
    expect(toolHeadline('edit', { path: 'src/cli/repl.ts', edits: [{}, {}] })).toBe(
      'edit src/cli/repl.ts (2 edits)',
    );
    expect(toolHeadline('grep', { pattern: 'StreamFn', path: 'src/', limit: 100 })).toBe(
      'grep "StreamFn" src/ (limit 100)',
    );
    expect(toolHeadline('plan', {})).toBeUndefined(); // plan 不渲染工具头
  });

  it('steering / follow-up / synthetic 的 message_start 回显', () => {
    const { out, r } = makePlain();
    r.render({ type: 'message_start', message: um('改用方案 B', 'steering') });
    r.render({ type: 'message_start', message: um('然后跑测试', 'follow_up') });
    r.render({ type: 'message_start', message: um('[Conversation summary]\nstuff', 'synthetic') });
    r.render({ type: 'message_start', message: um('普通输入', 'prompt') });
    expect(out.text).toContain('» steering: 改用方案 B');
    expect(out.text).toContain('» follow-up: 然后跑测试');
    expect(out.text).toContain('[Conversation summary]');
    expect(out.text).toContain('you: 普通输入');
  });

  it('message_end 警示行:aborted / length / error', () => {
    const { out, r } = makePlain();
    r.render({ type: 'message_end', message: am({ stopReason: 'aborted' }) });
    r.render({ type: 'message_end', message: am({ stopReason: 'length' }) });
    r.render({ type: 'message_end', message: am({ stopReason: 'error', errorMessage: 'boom' }) });
    expect(out.text).toContain('[aborted]');
    expect(out.text).toContain('[output truncated by model limit]');
    expect(out.text).toContain('[error] boom');
  });

  it('abort 中断的未完流式行由 message_end 兜底收行', () => {
    const { out, r } = makePlain();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('half a li') });
    r.render({ type: 'message_end', message: am({ stopReason: 'aborted' }) });
    expect(out.text).toContain('half a li\n[aborted]\n');
  });

  it('queue_update 徽标文案:非空打印,两队列皆空不打印', () => {
    const { out, r } = makePlain();
    r.render({ type: 'queue_update', steering: [qm('s1', 'steering')], followUp: [] });
    expect(out.text).toContain('[steer 1 · follow-up 0]');
    const before = out.text;
    r.render({ type: 'queue_update', steering: [], followUp: [] });
    expect(out.text).toBe(before); // 皆空:无输出
  });

  it('agent_start follow_up 标记;agent_end 打印 usage 小结', () => {
    const { out, r } = makePlain();
    r.render({ type: 'agent_start', reason: 'follow_up' });
    expect(out.text).toContain('↪ follow-up');
    const usage: SessionUsage = {
      cumulative: { input: 2310, output: 95, costUSD: 0.0123 },
      turns: 2,
      contextTokens: 2405,
    };
    r.render({ type: 'usage_update', usage });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });
    expect(out.text).toContain('2 turns');
    expect(out.text).toContain('tokens 2310 in / 95 out');
    expect(out.text).toContain('$0.0123');
  });

  it('agent_end error 打印醒目错误行', () => {
    const { out, r } = makePlain();
    r.render({ type: 'agent_end', reason: 'error', messages: [] });
    expect(out.text).toContain('✖ agent run failed');
  });

  it('tool_execution_end:成功补状态与 details 摘要,失败带首行错误', () => {
    const { out, r } = makePlain();
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: tr({ details: { path: '/repo/src/a.ts', truncated: false, totalLines: 120 } }),
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'c2',
      result: tr({
        toolName: 'edit',
        isError: true,
        content: [{ type: 'text', text: 'oldText not found in file\nmore context' }],
      }),
    });
    expect(out.text).toContain('✓ read src/a.ts (120 lines)');
    expect(out.text).toContain('✗ edit: oldText not found in file');
  });

  it('details.diff 渲染上限 40 行,超出提示行数(docs/09 §4)', () => {
    const { out, r } = makePlain();
    const diffLines = ['--- a', '+++ b', '@@ -1 +1 @@'];
    for (let i = 0; i < 50; i++) diffLines.push(`+added line ${i}`);
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: tr({ toolName: 'edit', details: { diff: diffLines.join('\n'), additions: 50, deletions: 0 } }),
    });
    expect(out.text).toContain('+added line 0');
    expect(out.text).toContain('+added line 36'); // 第 40 行(3 头部 + 37 条)
    expect(out.text).not.toContain('+added line 37');
    expect(out.text).toContain('(+13 more diff lines)');
  });

  it('error 事件:fatal 与 non-fatal 区分', () => {
    const { out, r } = makePlain();
    r.render({ type: 'error', message: 'disk full', fatal: false });
    r.render({ type: 'error', message: 'cannot continue', fatal: true });
    expect(out.text).toContain('⚠ disk full');
    expect(out.text).toContain('✖ fatal: cannot continue');
  });

  it('plan_update 以清单渲染三种状态', () => {
    const { out, r } = makePlain();
    r.render({
      type: 'plan_update',
      steps: [
        { step: 'read files', status: 'completed' },
        { step: 'edit code', status: 'in_progress' },
        { step: 'run tests', status: 'pending' },
      ],
    });
    expect(out.text).toContain('✔ read files');
    expect(out.text).toContain('▶ edit code');
    expect(out.text).toContain('○ run tests');
  });

  it('retry/compaction 叠加事件渲染(SessionEvent 透传面)', () => {
    const { out, r } = makePlain();
    r.render({
      type: 'retry_scheduled',
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4000,
      errorMessage: 'http 500',
    });
    r.render({ type: 'compaction_start', reason: 'threshold' });
    r.render({ type: 'compaction_end', ok: true, droppedMessages: 12 });
    expect(out.text).toContain('retry 2/5 in 4000ms: http 500');
    expect(out.text).toContain('compacting');
    expect(out.text).toContain('dropped 12');
  });

  it('replayTranscript:user/assistant/tool_call/tool_result 静态重放', () => {
    const { out, r } = makePlain();
    const messages: AgentMessage[] = [
      um('把 utils 重构一下', 'prompt'),
      am({
        content: [
          { type: 'text', text: '先看文件。' },
          { type: 'tool_call', id: 'call_a', name: 'read', arguments: { path: 'src/utils.ts' } },
        ],
        stopReason: 'tool_calls',
      }),
      tr({ toolCallId: 'call_a' }),
      am({ content: [{ type: 'text', text: '改完了。' }] }),
    ];
    r.replayTranscript(messages);
    expect(out.text).toContain('4 messages');
    expect(out.text).toContain('you: 把 utils 重构一下');
    expect(out.text).toContain('先看文件。');
    expect(out.text).toContain('● read src/utils.ts');
    expect(out.text).toContain('✓ read');
    expect(out.text).toContain('改完了。');
  });

  it('plain 模式全程零 ANSI 序列(NO_COLOR 纪律,docs/09 §9)', () => {
    const { out, r } = makePlain();
    r.render({ type: 'agent_start', reason: 'prompt' });
    r.render({ type: 'message_start', message: um('go', 'prompt') });
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('hi') });
    r.render({ type: 'queue_update', steering: [qm('s1', 'steering')], followUp: [] });
    r.render({ type: 'turn_end', message: am(), toolResults: [] });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });
    r.setInputLine?.('typing'); // plain 下 no-op
    r.setStatus?.('hint');
    r.mount?.();
    r.unmount?.();
    expect(out.text).not.toContain('\x1b');
  });
});

describe('ANSI 交互模式(docs/09 §1.3 动态区)', () => {
  it('完整事件序列不炸,输出含清区序列与 bracketed paste 开关', () => {
    const { out, r } = makeAnsi();
    r.mount?.();
    r.setInputLine?.('');
    r.render({ type: 'agent_start', reason: 'prompt' });
    r.render({ type: 'message_start', message: um('go 中文输入🙂', 'prompt') });
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('第一行很长'.repeat(40)) });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('尾巴\n下一行开头') });
    r.setInputLine?.('用户正在打字 with CJK 宽字符');
    r.render({ type: 'queue_update', steering: [qm('s1', 'steering')], followUp: [qm('f1', 'follow_up')] });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'text_end', contentIndex: 0, content: 'x', partial: am() },
    });
    r.render({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'npm t' } });
    r.render({ type: 'tool_execution_update', toolCallId: 'c1', update: { output: 'line1\nline2\n' } });
    r.render({ type: 'tool_execution_end', toolCallId: 'c1', result: tr({ toolName: 'bash' }) });
    r.render({ type: 'turn_end', message: am(), toolResults: [] });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });
    r.redraw?.();
    r.unmount?.();

    const text = out.text;
    expect(text).toMatch(/\x1b\[\d+F\x1b\[J/); // \x1b[<n>F\x1b[J 清区重绘(docs/09 §1.3)
    expect(text).toContain('\x1b[?2004h'); // bracketed paste 开
    expect(text).toContain('\x1b[?2004l'); // bracketed paste 关(unmount)
    expect(text).toContain('[steer 1 · follow-up 1]');
    expect(text).toContain('bash: npm t'); // 工具头(● 带色码,断言纯文本部分)
  });

  it('转录行永远以完整行落盘:流式未完行留在动态区', () => {
    const { out, r } = makeAnsi();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('complete line\npartial') });
    // 完整行进转录;partial 只出现在动态区重绘中,清区后不重复落盘
    expect(out.text).toContain('complete line\n');
    r.render({ type: 'message_end', message: am({ stopReason: 'aborted' }) });
    expect(out.text).toContain('[aborted]');
  });

  // ---- 动态区 \t/\r 清洗(docs/09 §1.3 行宽数学不变量:动态行物理不换行)----

  /** 最后一次动态区重绘的行(drawDyn 单次 write:lines.join('\n') + '\n')。 */
  function lastDynDraw(out: FakeOut): string {
    return out.chunks[out.chunks.length - 1] ?? '';
  }
  const SGR_RE = /\x1b\[[0-9;]*m/g;

  it('pending 含 \\t/\\r:清洗先于截断,动态行零 \\t/\\r 且行宽不超列宽', () => {
    const { out, r } = makeAnsi();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('col1\tcol2\rX') });
    const draw = lastDynDraw(out);
    expect(draw).toContain('col1  col2X'); // \t → 固定 2 空格;\r 剥除
    expect(draw).not.toContain('\t');
    expect(draw).not.toContain('\r');
    // 行数不变式:每个动态行剥色后显示宽度 ≤ 列宽-1(物理不换行 ⇒ 清区上移行数恒等)
    for (const line of draw.replace(/\n$/, '').split('\n')) {
      expect(displayWidth(line.replace(SGR_RE, ''))).toBeLessThanOrEqual(out.columns - 1);
    }
  });

  it('含 \\t 的超长流式尾行:tab 展开后再截断,宽度上限仍成立', () => {
    const { out, r } = makeAnsi();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('x\t'.repeat(60)) });
    const draw = lastDynDraw(out);
    expect(draw).not.toContain('\t');
    for (const line of draw.replace(/\n$/, '').split('\n')) {
      expect(displayWidth(line.replace(SGR_RE, ''))).toBeLessThanOrEqual(out.columns - 1);
    }
  });

  it('行数不变式:含 \\t/\\r 的动态区,下一次清区上移行数 = 上一次绘制行数', () => {
    const { out, r } = makeAnsi();
    r.setInputLine?.('a\tb\rc');
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('tabby\ttail\r!') });
    const drawnRows = lastDynDraw(out).replace(/\n$/, '').split('\n').length;
    const before = out.chunks.length;
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('more') });
    const clear = out.chunks.slice(before).find((c) => c.includes('\x1b[J')) ?? '';
    expect(clear).toBe(`\x1b[${drawnRows}F\x1b[J`);
  });

  it('输入行/工具尾行同样清洗;转录区 append 保留原文不清洗', () => {
    const { out, r } = makeAnsi();
    r.setInputLine?.('git log\t--oneline');
    expect(lastDynDraw(out)).toContain('> git log  --oneline');
    expect(lastDynDraw(out)).not.toContain('\t');
    r.render({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'make' } });
    r.render({ type: 'tool_execution_update', toolCallId: 'c1', update: { output: 'a\tb\rdone' } });
    expect(lastDynDraw(out)).toContain('a  bdone');
    // 转录区:含 \t 的完整流式行原文落盘(清洗只作用于动态区)
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('name\tvalue\n') });
    expect(out.chunks).toContain('name\tvalue\n');
  });

  it('sanitizeDynText:\\t → 2 空格、\\r 剥除', () => {
    expect(sanitizeDynText('a\tb\rc')).toBe('a  bc');
    expect(sanitizeDynText('plain')).toBe('plain');
  });
});

describe('interactive 与 color 解耦(NO_COLOR 只禁 SGR,不禁光标控制)', () => {
  it('interactive+无color:动态区仍用 \\x1b[F/\\x1b[J 重绘、输入行可见,零 SGR 着色', () => {
    const out = new FakeOut();
    const r = createRenderer(out as unknown as NodeJS.WriteStream, { color: false, interactive: true });
    r.mount?.();
    r.setInputLine?.('hello world');
    r.render({ type: 'agent_start', reason: 'prompt' });
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('streaming tail') });
    const text = out.text;
    expect(text).toMatch(/\x1b\[\d+F\x1b\[J/); // 光标控制:动态区清区重绘仍在
    expect(text).toContain('\x1b[?2004h');     // bracketed paste 是模式切换,不是着色
    expect(text).toContain('> hello world');   // raw mode 下输入行必须由动态区回显
    expect(text).not.toMatch(/\x1b\[[0-9;]*m/); // 零 SGR(NO_COLOR 纪律)
    r.unmount?.();
  });

  it('非交互+有color(-p 于 TTY):plain 追加带色,无光标控制', () => {
    const out = new FakeOut();
    const r = createRenderer(out as unknown as NodeJS.WriteStream, { color: true, interactive: false });
    r.render({ type: 'message_start', message: am() });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_delta', contentIndex: 0, delta: 'mm', partial: am() },
    });
    expect(out.text).toMatch(/\x1b\[[0-9;]*m/); // 着色仍在
    expect(out.text).not.toContain('\x1b[J');   // 无清区(plain 纯追加)
  });
});

describe('简化 wcwidth(docs/09 §8:CJK/emoji 宽度)', () => {
  it('CJK 宽 2、ASCII 宽 1、emoji 宽 2', () => {
    expect(charWidth('中'.codePointAt(0) ?? 0)).toBe(2);
    expect(charWidth('a'.codePointAt(0) ?? 0)).toBe(1);
    expect(charWidth('🙂'.codePointAt(0) ?? 0)).toBe(2);
    expect(displayWidth('你好ab')).toBe(6);
  });

  it('truncateToWidth 按显示宽度截断且不超宽', () => {
    expect(truncateToWidth('hello', 10)).toBe('hello');
    const t = truncateToWidth('你好世界啊', 5);
    expect(displayWidth(t)).toBeLessThanOrEqual(5);
    expect(t.endsWith('…')).toBe(true);
  });

  it('tailToWidth 保留末端', () => {
    expect(tailToWidth('abcdef', 10)).toBe('abcdef');
    const t = tailToWidth('abcdefghij', 5);
    expect(t.startsWith('…')).toBe(true);
    expect(t.endsWith('j')).toBe(true);
    expect(displayWidth(t)).toBeLessThanOrEqual(5);
  });
});

describe('approval_request 渲染(M6,docs/09 §4:动态区审批提示)', () => {
  it('plain:转录留痕一行(headless/-p 可读),无审批提示行', () => {
    const { out, r } = makePlain();
    r.render({
      type: 'approval_request',
      approvalId: 'ap_1',
      toolCallId: 'c1',
      description: 'bash: rm -rf dist',
    });
    expect(out.text).toContain('? approval required: bash: rm -rf dist');
    expect(out.text).not.toContain('[y=once');
  });

  it('ansi:动态区出现完整审批提示;决议后(tool_execution_start)撤下', () => {
    const { out, r } = makeAnsi();
    r.render({
      type: 'approval_request',
      approvalId: 'ap_1',
      toolCallId: 'c1',
      description: 'bash: rm -rf dist',
    });
    // 规格文案逐字(docs/09 §4):Allow <description>? [y=once / a=always / n=deny / Esc=abort]
    expect(out.text).toContain('Allow bash: rm -rf dist? [y=once / a=always / n=deny / Esc=abort]');

    out.chunks.length = 0;
    r.render({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'rm -rf dist' } });
    expect(out.text).not.toContain('Allow bash: rm -rf dist?'); // 审批已决议,提示不再重绘
  });

  it('ansi:agent_end 兜底撤下审批提示(abort 收尾场景)', () => {
    const { out, r } = makeAnsi();
    r.render({
      type: 'approval_request',
      approvalId: 'ap_2',
      toolCallId: 'c2',
      description: 'write /etc/hosts',
    });
    expect(out.text).toContain('Allow write /etc/hosts?');
    out.chunks.length = 0;
    r.render({ type: 'agent_end', reason: 'aborted', messages: [] });
    expect(out.text).not.toContain('Allow write /etc/hosts?');
  });
});
