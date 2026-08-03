// Append-only renderer 单测：假输出收集写入串，驱动一次性事件序列。

import { describe, expect, it } from 'bun:test';
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
  toolHeadline,
  truncateToWidth,
} from './renderer.js';
import type { Renderer } from './renderer.js';

class FakeOut {
  chunks: string[] = [];
  columns = 80;
  enqueue(s: string): void {
    this.chunks.push(s);
  }
  drain(): Promise<void> {
    return Promise.resolve();
  }
  get text(): string {
    return this.chunks.join('');
  }
}

function makeAppendOnly(): { out: FakeOut; r: Renderer } {
  const out = new FakeOut();
  const r = createRenderer(out, { color: false });
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

describe('append-only one-shot 渲染', () => {
  it('统一清洗模型、工具、diff、plan、provider 错误与恢复数据的终端控制序列', () => {
    const { out, r } = makeAppendOnly();
    const attack =
      '\x1b]52;c;OSC_SECRET\x07' +
      '\x1b[31mvisible\x1b[0m' +
      '\x1bP1;2|DCS_SECRET\x1b\\' +
      '\x00\x08\x0b\x7f\x9f';
    r.render({ type: 'message_start', message: um(attack) });
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta(attack) });
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: `bash${attack}`,
      args: { command: attack },
    });
    r.render({ type: 'tool_execution_update', toolCallId: 'c1', update: { output: attack } });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: tr({
        toolName: `read${attack}`,
        content: [{ type: 'text', text: attack }],
        details: { path: attack, diff: `+${attack}` },
      }),
    });
    r.render({ type: 'plan_update', steps: [{ step: attack, status: 'in_progress' }] });
    r.render({
      type: 'approval_request',
      approvalId: 'approval-1',
      toolCallId: 'call-approval',
      description: attack,
    });
    r.render({ type: 'error', fatal: false, message: attack });
    r.render({
      type: 'retry_scheduled',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1,
      errorMessage: attack,
    });
    r.replayTranscript([
      um(attack),
      am({ content: [{ type: 'text', text: attack }] }),
      tr({ content: [{ type: 'text', text: attack }], details: { diff: attack } }),
    ]);
    expect(out.text).toContain('visible');
    expect(out.text).not.toContain('OSC_SECRET');
    expect(out.text).not.toContain('DCS_SECRET');
    expect(out.text).not.toContain('\x1b');
    expect(out.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('text_delta 直写拼接,text_end 补换行', () => {
    const { out, r } = makeAppendOnly();
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

  it('text_delta 将 CRLF 与裸 CR 统一为换行，不吞掉行边界', () => {
    const { out, r } = makeAppendOnly();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('a\r\nb\rc') });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'text_end', contentIndex: 0, content: 'a\nb\nc', partial: am() },
    });
    expect(out.text).toContain('a\nb\nc\n');
    expect(out.text).not.toContain('\r');
  });

  it('append-only 不写入 reasoning 摘要或状态卡片', () => {
    const { out, r } = makeAppendOnly();
    r.render({ type: 'message_start', message: am() });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_start', contentIndex: 0, partial: am() },
    });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_delta', contentIndex: 0, delta: 'thinking hard', partial: am() },
    });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: {
        type: 'reasoning_end',
        contentIndex: 0,
        content: 'thinking hard',
        partial: am(),
      },
    });
    expect(out.text).not.toContain('thinking hard');
    expect(out.text).not.toContain('thinking');
    expect(out.text).not.toContain('\x1b');
  });

  it('bash 完成后以 Ran 块展示多行命令与紧凑输出预览', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'npm test\necho second-line' },
    });
    expect(out.text).toBe('');
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      result: tr({
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'tests passed\nexit code 0' }],
      }),
    });
    expect(out.text).toContain('● Ran npm test\n  │ echo second-line\n  └ tests passed');
    expect(out.text).not.toContain('exit code 0');
  });

  it('bash 使用成功/失败状态点、命令高亮和首尾输出预览', () => {
    const out = new FakeOut();
    out.columns = 160;
    const r = createRenderer(out, { color: true });
    const output = [
      'M docs/09-cli.md',
      'M docs/10-testing.md',
      ...Array.from({ length: 9 }, (_, index) => `middle ${index + 1}`),
      '6c9b145 Upgrade terminal workflows',
      'd43c8b1 Productize CLI',
      'exit code 0',
    ].join('\n');
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'bash-preview',
      toolName: 'bash',
      args: { command: 'git status --short && git log -5 --oneline --decorate' },
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'bash-preview',
      result: tr({
        toolCallId: 'bash-preview',
        toolName: 'bash',
        content: [{ type: 'text', text: output }],
      }),
    });

    expect(out.text).toContain('\x1b[32m●\x1b[0m \x1b[1mRan\x1b[0m \x1b[34mgit\x1b[0m status');
    expect(out.text).toContain('\x1b[31m--short\x1b[0m \x1b[36m&&\x1b[0m \x1b[34mgit\x1b[0m');
    expect(out.text).toContain('  └ M docs/09-cli.md');
    expect(out.text).toContain('    … +9 lines (use /review to view output)');
    expect(out.text).toContain('    d43c8b1 Productize CLI');
    expect(out.text).not.toContain('exit code 0');

    r.render({
      type: 'tool_execution_start',
      toolCallId: 'bash-failure',
      toolName: 'bash',
      args: { command: 'bun -e "throw new Error(\'boom\')"' },
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'bash-failure',
      result: tr({
        toolCallId: 'bash-failure',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'Error: boom\nexit code 1' }],
      }),
    });
    expect(out.text).toContain('\x1b[31m✗\x1b[0m \x1b[1mRan\x1b[0m \x1b[34mbun\x1b[0m');
    expect(out.text).toContain('\x1b[32m"throw new Error(\'boom\')"\x1b[0m');
  });

  it('工具头:read 带 offset/limit,edit 带 edits 数', () => {
    expect(toolHeadline('read', { path: 'src/a.ts', offset: 200 })).toBe('read src/a.ts [offset=200]');
    expect(toolHeadline('edit', { path: 'src/cli/main.ts', edits: [{}, {}] })).toBe(
      'edit src/cli/main.ts (2 edits)',
    );
    expect(toolHeadline('grep', { pattern: 'StreamFn', path: 'src/', limit: 100 })).toBe(
      'grep "StreamFn" src/ (limit 100)',
    );
    expect(toolHeadline('plan', {})).toBeUndefined(); // plan 不渲染工具头
  });

  it('连续 ls/glob/grep/read 折叠为一个 Explored 块，且相邻 read 合并路径', () => {
    const { out, r } = makeAppendOnly();
    const calls = [
      ['read-1', 'read', { path: 'package.json' }],
      ['read-2', 'read', { path: 'package.json' }],
      ['read-3', 'read', { path: 'bun.lock' }],
      ['ls-1', 'ls', { path: 'docs' }],
      ['glob-1', 'glob', { pattern: '**/*.md', path: 'docs' }],
      ['grep-1', 'grep', { pattern: '^#{1,3}', path: '*.md' }],
    ] as const;
    for (const [toolCallId, toolName, args] of calls) {
      r.render({ type: 'tool_execution_start', toolCallId, toolName, args });
      r.render({
        type: 'tool_execution_end',
        toolCallId,
        result: tr({ toolCallId, toolName }),
      });
    }
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });

    expect(out.text).toContain(
      '• Explored\n' +
        '  └ Read package.json, bun.lock\n' +
        '    List docs\n' +
        '    List **/*.md in docs\n' +
        '    Search ^#{1,3} in *.md',
    );
    expect(out.text.match(/Explored/gu)).toHaveLength(1);
    expect(out.text).not.toContain('● read package.json');
    expect(out.text).not.toContain('✓ read');
  });

  it('探索工具失败保留显式失败事实', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'missing-read',
      toolName: 'read',
      args: { path: 'missing.ts' },
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'missing-read',
      result: tr({
        toolCallId: 'missing-read',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT: missing.ts' }],
      }),
    });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });

    expect(out.text).toContain('• Explored');
    expect(out.text).toContain('✗ Read missing.ts: ENOENT: missing.ts');
  });

  it('并行探索在封口后等待真实结果，失败不附着到其他工具块', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'parallel-read',
      toolName: 'read',
      args: { path: 'a.ts' },
    });
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'parallel-edit',
      toolName: 'edit',
      args: { path: 'b.ts', edits: [{}] },
    });
    expect(out.text).not.toContain('Explored');

    r.render({
      type: 'tool_execution_end',
      toolCallId: 'parallel-edit',
      result: tr({
        toolCallId: 'parallel-edit',
        toolName: 'edit',
        content: [{ type: 'text', text: 'edited' }],
      }),
    });
    expect(out.text).not.toContain('Explored');
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'parallel-read',
      result: tr({
        toolCallId: 'parallel-read',
        toolName: 'read',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT' }],
      }),
    });

    const editEnd = out.text.indexOf('✓ edit');
    const explored = out.text.indexOf('Explored · 1 failed');
    const failure = out.text.indexOf('✗ Read a.ts: ENOENT');
    expect(editEnd).toBeGreaterThanOrEqual(0);
    expect(explored).toBeGreaterThan(editEnd);
    expect(failure).toBeGreaterThan(explored);
    expect(out.text.slice(editEnd, explored)).toContain('\n\n');
  });

  it('不可见 reasoning 不会把连续探索拆成两个块', () => {
    const { out, r } = makeAppendOnly();
    const reasoning = am({
      content: [{ type: 'reasoning', kind: 'content', text: 'private reasoning' }],
    });
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'read-a',
      toolName: 'read',
      args: { path: 'a.ts' },
    });
    r.render({
      type: 'message_update',
      messageId: 'reasoning-message',
      event: { type: 'reasoning_start', contentIndex: 0, partial: reasoning },
    });
    r.render({
      type: 'message_update',
      messageId: 'reasoning-message',
      event: {
        type: 'reasoning_delta',
        contentIndex: 0,
        delta: 'private reasoning',
        partial: reasoning,
      },
    });
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'read-b',
      toolName: 'read',
      args: { path: 'b.ts' },
    });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });

    expect(out.text.match(/Exploration incomplete/gu)).toHaveLength(1);
    expect(out.text).toContain('Read a.ts, b.ts');
    expect(out.text).not.toContain('private reasoning');
  });

  it('steering / follow-up / synthetic 的 message_start 回显', () => {
    const { out, r } = makeAppendOnly();
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
    const { out, r } = makeAppendOnly();
    r.render({ type: 'message_end', message: am({ stopReason: 'aborted' }) });
    r.render({ type: 'message_end', message: am({ stopReason: 'length' }) });
    r.render({ type: 'message_end', message: am({ stopReason: 'error', errorMessage: 'boom' }) });
    expect(out.text).toContain('[aborted]');
    expect(out.text).toContain('[output truncated by model limit]');
    expect(out.text).toContain('[error] boom');
  });

  it('abort 中断的未完流式行由 message_end 兜底收行', () => {
    const { out, r } = makeAppendOnly();
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('half a li') });
    r.render({ type: 'message_end', message: am({ stopReason: 'aborted' }) });
    expect(out.text).toContain('half a li\n[aborted]\n');
  });

  it('queue_update 徽标文案:非空打印,两队列皆空不打印', () => {
    const { out, r } = makeAppendOnly();
    r.render({ type: 'queue_update', steering: [qm('s1', 'steering')], followUp: [] });
    expect(out.text).toContain('[steer 1 · follow-up 0]');
    const before = out.text;
    r.render({ type: 'queue_update', steering: [], followUp: [] });
    expect(out.text).toBe(before); // 皆空:无输出
  });

  it('agent_start follow_up 标记;agent_end 打印 usage 小结', () => {
    const { out, r } = makeAppendOnly();
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
    const { out, r } = makeAppendOnly();
    r.render({ type: 'agent_end', reason: 'error', messages: [] });
    expect(out.text).toContain('✖ agent run failed');
  });

  it('tool_execution_end:成功补状态与 details 摘要,失败带首行错误', () => {
    const { out, r } = makeAppendOnly();
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

  it('独立工具块恰隔一行，同一调用的结果与 diff 保持紧凑', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'write-1',
      toolName: 'write',
      args: { path: 'src/a.ts' },
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'write-1',
      result: tr({
        toolCallId: 'write-1',
        toolName: 'write',
        content: [{ type: 'text', text: 'written' }],
        details: { diff: '+added\n-removed' },
      }),
    });
    r.render({
      type: 'tool_execution_start',
      toolCallId: 'edit-1',
      toolName: 'edit',
      args: { path: 'src/b.ts', edits: [{}] },
    });
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'edit-1',
      result: tr({ toolCallId: 'edit-1', toolName: 'edit' }),
    });

    const rows = out.text.split('\n');
    const row = (fragment: string): number => {
      const index = rows.findIndex((line) => line.includes(fragment));
      if (index < 0) throw new Error(`missing ${fragment}`);
      return index;
    };
    const write = row('✓ write');
    const added = row('+added');
    const removed = row('-removed');
    const edit = row('● edit src/b.ts');
    expect(added).toBe(write + 1);
    expect(removed).toBe(added + 1);
    expect(rows[removed + 1]).toBe('');
    expect(edit).toBe(removed + 2);
  });

  it('details.diff 渲染上限 40 行,超出提示行数(docs/09 §4)', () => {
    const { out, r } = makeAppendOnly();
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
    const { out, r } = makeAppendOnly();
    r.render({ type: 'error', message: 'disk full', fatal: false });
    r.render({ type: 'error', message: 'cannot continue', fatal: true });
    expect(out.text).toContain('⚠ disk full');
    expect(out.text).toContain('✖ fatal: cannot continue');
  });

  it('plan_update 以 Codex 风格标题、进度和树状清单渲染三种状态', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'plan_update',
      steps: [
        { step: 'read files', status: 'completed' },
        { step: 'edit code', status: 'in_progress' },
        { step: 'run tests', status: 'pending' },
      ],
    });
    expect(out.text).toContain(
      '* Updated Plan | 1/3 complete\n' +
        '  \\ [x] read files\n' +
        '    [>] edit code\n' +
        '    [ ] run tests',
    );
  });

  it('成功 plan 工具结果让位于紧随其后的整表 checklist，不额外打印工具结果', () => {
    const { out, r } = makeAppendOnly();
    const steps = [{ step: 'render a focused plan', status: 'in_progress' }] as const;
    r.render({
      type: 'tool_execution_end',
      toolCallId: 'plan-1',
      result: tr({ toolCallId: 'plan-1', toolName: 'plan', details: { steps } }),
    });
    r.render({ type: 'plan_update', steps: [...steps] });

    expect(out.text).toContain('* Updated Plan | 0/1 complete');
    expect(out.text).not.toContain('✓ plan');
    expect(out.text).not.toContain('1. [in_progress]');
  });

  it('retry/compaction 叠加事件渲染(SessionEvent 透传面)', () => {
    const { out, r } = makeAppendOnly();
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
    const { out, r } = makeAppendOnly();
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
    expect(out.text).toContain('• Explored');
    expect(out.text).toContain('  └ Read src/utils.ts');
    expect(out.text).not.toContain('● read src/utils.ts');
    expect(out.text).not.toContain('✓ read');
    expect(out.text).toContain('改完了。');
  });

  it('replay 按工具结果顺序封口探索块，不跨 edit 合并或拆开 edit 调用', () => {
    const { out, r } = makeAppendOnly();
    r.replayTranscript([
      am({
        content: [
          { type: 'tool_call', id: 'read-a', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'tool_call', id: 'edit-b', name: 'edit', arguments: { path: 'b.ts', edits: [{}] } },
          { type: 'tool_call', id: 'read-c', name: 'read', arguments: { path: 'c.ts' } },
        ],
        stopReason: 'tool_calls',
      }),
      tr({ id: 'result-a', toolCallId: 'read-a' }),
      tr({ id: 'result-b', toolCallId: 'edit-b', toolName: 'edit', content: [{ type: 'text', text: 'edited' }] }),
      tr({ id: 'result-c', toolCallId: 'read-c' }),
    ]);

    expect(out.text.match(/Explored/gu)).toHaveLength(2);
    const firstRead = out.text.indexOf('Read a.ts');
    const editStart = out.text.indexOf('● edit b.ts');
    const editEnd = out.text.indexOf('✓ edit');
    const secondRead = out.text.indexOf('Read c.ts');
    expect(firstRead).toBeGreaterThanOrEqual(0);
    expect(editStart).toBeGreaterThan(firstRead);
    expect(editEnd).toBeGreaterThan(editStart);
    expect(secondRead).toBeGreaterThan(editEnd);
    expect(out.text).not.toContain('Read a.ts, c.ts');
  });

  it('replay 恢复最后一个成功 plan 快照而不留下运行中工具头', () => {
    const { out, r } = makeAppendOnly();
    r.replayTranscript([
      am({
        content: [{ type: 'tool_call', id: 'plan-old', name: 'plan', arguments: {} }],
        stopReason: 'tool_calls',
      }),
      tr({
        id: 'plan-old-result',
        toolCallId: 'plan-old',
        toolName: 'plan',
        details: { steps: [{ step: 'obsolete step', status: 'in_progress' }] },
      }),
      am({
        content: [{ type: 'tool_call', id: 'plan-new', name: 'plan', arguments: {} }],
        stopReason: 'tool_calls',
      }),
      tr({
        id: 'plan-new-result',
        toolCallId: 'plan-new',
        toolName: 'plan',
        details: { steps: [{ step: 'current step', status: 'completed' }] },
      }),
    ]);

    expect(out.text).toContain('Updated Plan | 1/1 complete');
    expect(out.text).toContain('current step');
    expect(out.text).not.toContain('obsolete step');
    expect(out.text).not.toContain('● plan');
  });

  it('replay 已完成与未完成探索仍按声明顺序投影', () => {
    const { out, r } = makeAppendOnly();
    r.replayTranscript([
      am({
        content: [
          { type: 'tool_call', id: 'read-complete', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'tool_call', id: 'read-incomplete', name: 'read', arguments: { path: 'b.ts' } },
        ],
        stopReason: 'tool_calls',
      }),
      tr({ id: 'read-complete-result', toolCallId: 'read-complete' }),
    ]);

    expect(out.text).toContain('• Exploration incomplete');
    expect(out.text).toContain('Read a.ts, b.ts');
    expect(out.text).not.toContain('Read b.ts, a.ts');
  });

  it('NO_COLOR 时全程零 ANSI 序列', () => {
    const { out, r } = makeAppendOnly();
    r.render({ type: 'agent_start', reason: 'prompt' });
    r.render({ type: 'message_start', message: um('go', 'prompt') });
    r.render({ type: 'message_start', message: am() });
    r.render({ type: 'message_update', messageId: 'a1', event: textDelta('hi') });
    r.render({ type: 'queue_update', steering: [qm('s1', 'steering')], followUp: [] });
    r.render({ type: 'turn_end', message: am(), toolResults: [] });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });
    expect(out.text).not.toContain('\x1b');
  });

  it('ASCII output keeps payload Unicode but replaces product status chrome', () => {
    const out = new FakeOut();
    const r = createRenderer(out, { color: false, ascii: true });
    r.render({ type: 'message_start', message: um('用户内容 中文🙂', 'prompt') });
    r.render({ type: 'agent_start', reason: 'follow_up' });
    r.render({ type: 'tool_execution_start', toolCallId: 'ascii-tool', toolName: 'read', args: { path: 'a' } });
    r.render({ type: 'tool_execution_end', toolCallId: 'ascii-tool', result: tr() });
    r.render({ type: 'plan_update', steps: [{ step: 'done', status: 'completed' }] });
    r.render({ type: 'error', fatal: false, message: 'warning' });
    r.render({ type: 'agent_end', reason: 'completed', messages: [] });

    expect(out.text).toContain('用户内容 中文🙂');
    expect(out.text).toContain('[ok] read');
    expect(out.text).toContain('[x] done');
    expect(out.text).toContain('[!] warning');
    expect(out.text).not.toMatch(/[✓✗✖⚠●▶○↻⋯∙»↪—]/u);
    expect(out.text).not.toContain('\x1b');
  });
});

describe('append-only color output', () => {
  it('有 color 时追加 SGR 着色，但不产生光标控制', () => {
    const out = new FakeOut();
    const r = createRenderer(out, { color: true });
    r.render({ type: 'message_start', message: um('visible user text') });
    r.render({ type: 'message_start', message: am() });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_start', contentIndex: 0, partial: am() },
    });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_delta', contentIndex: 0, delta: 'mm', partial: am() },
    });
    r.render({
      type: 'message_update',
      messageId: 'a1',
      event: { type: 'reasoning_end', contentIndex: 0, content: 'mm', partial: am() },
    });
    expect(out.text).toMatch(/\x1b\[[0-9;]*m/); // 着色仍在
    expect(out.text).not.toContain('mm');
    expect(out.text).not.toContain('thinking');
    expect(out.text).not.toContain('\x1b[J');
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

  it('ZWJ emoji 作为一个双列 grapheme', () => {
    expect(displayWidth('A👩‍💻B')).toBe(4);
  });
});

describe('approval_request append-only 渲染', () => {
  it('转录留痕一行', () => {
    const { out, r } = makeAppendOnly();
    r.render({
      type: 'approval_request',
      approvalId: 'ap_1',
      toolCallId: 'c1',
      description: 'bash: rm -rf dist',
    });
    expect(out.text).toContain('? approval required: bash: rm -rf dist');
    expect(out.text).not.toContain('[y=once');
  });
});
