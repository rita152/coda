// REPL 可测内核单测(docs/09 §3):斜杠命令分发、Enter 分派、输入历史环、双击消歧、
// /status //queue 格式化。键位接线依赖真实 TTY,由 repl.ts 头部人工冒烟清单覆盖。
// 双击消歧用注入时间戳,零真实计时器(docs/10 §8 确定性守则)。

import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../protocol/index.js';
import type { SessionUsage } from '../session/index.js';
import {
  approvalKeyDecision,
  CTRL_C_EXIT_WINDOW_MS,
  decideEnter,
  DoublePress,
  ESC_EXIT_WINDOW_MS,
  ESC_TIMEOUT_MS,
  formatQueueLines,
  formatStatusLines,
  InputHistory,
  parseSlashCommand,
} from './repl.js';

describe('parseSlashCommand(docs/09 §3.2)', () => {
  it('识别 /quit /queue /status /help', () => {
    expect(parseSlashCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseSlashCommand('/queue')).toEqual({ cmd: 'queue' });
    expect(parseSlashCommand('/status')).toEqual({ cmd: 'status' });
    expect(parseSlashCommand('/help')).toEqual({ cmd: 'help' });
  });

  it('/f 与 /followup 携带文本(任何终端的全功能兜底路径)', () => {
    expect(parseSlashCommand('/f 顺便改下颜色')).toEqual({ cmd: 'follow_up', text: '顺便改下颜色' });
    expect(parseSlashCommand('/followup run tests')).toEqual({ cmd: 'follow_up', text: 'run tests' });
    expect(parseSlashCommand('/f')).toEqual({ cmd: 'follow_up', text: '' });
  });

  it('非斜杠返回 undefined;未知斜杠返回 unknown', () => {
    expect(parseSlashCommand('hello')).toBeUndefined();
    expect(parseSlashCommand('/wat now')).toEqual({ cmd: 'unknown', input: '/wat now' });
  });
});

describe('decideEnter:键位表分派(docs/09 §3)', () => {
  it('空输入 → none(空闲与运行中一致)', () => {
    expect(decideEnter('idle', false, '')).toEqual({ kind: 'none' });
    expect(decideEnter('running', false, '   ')).toEqual({ kind: 'none' });
  });

  it('空闲 Enter=prompt;运行中 Enter=steer(风险最低的默认去向)', () => {
    expect(decideEnter('idle', false, '改一下')).toEqual({ kind: 'prompt', text: '改一下' });
    expect(decideEnter('running', false, '改一下')).toEqual({ kind: 'steer', text: '改一下' });
  });

  it('Alt+Enter(meta)= follow-up,空闲与运行中皆然', () => {
    expect(decideEnter('running', true, '收尾时跑测试')).toEqual({
      kind: 'follow_up',
      text: '收尾时跑测试',
    });
    expect(decideEnter('idle', true, 'x')).toEqual({ kind: 'follow_up', text: 'x' });
  });

  it('流式中 /f <text> 兜底 follow-up;/f 空文本 → none', () => {
    expect(decideEnter('running', false, '/f 顺便重命名')).toEqual({
      kind: 'follow_up',
      text: '顺便重命名',
    });
    expect(decideEnter('idle', false, '/f also idle ok')).toEqual({
      kind: 'follow_up',
      text: 'also idle ok',
    });
    expect(decideEnter('running', false, '/f')).toEqual({ kind: 'none' });
  });

  it('斜杠命令仅空闲时生效;运行中 /status 按普通文本 steer', () => {
    expect(decideEnter('idle', false, '/status')).toEqual({
      kind: 'command',
      command: { cmd: 'status' },
    });
    expect(decideEnter('running', false, '/status')).toEqual({ kind: 'steer', text: '/status' });
  });
});

describe('InputHistory:本会话输入历史环(↑/↓)', () => {
  it('↑ 依次回翻,到顶停住;↓ 翻回草稿', () => {
    const h = new InputHistory();
    h.push('first');
    h.push('second');
    expect(h.up('draft-in-progress')).toBe('second');
    expect(h.up('')).toBe('first');
    expect(h.up('')).toBe('first'); // 到顶停住
    expect(h.down()).toBe('second');
    expect(h.down()).toBe('draft-in-progress'); // 草稿还原
    expect(h.down()).toBe('draft-in-progress'); // 到底停住
  });

  it('空历史 ↑ 返回当前输入;空白提交不入历史;连续重复去重', () => {
    const h = new InputHistory();
    expect(h.up('keep me')).toBe('keep me');
    h.push('   ');
    expect(h.up('still me')).toBe('still me');
    h.push('same');
    h.push('same');
    expect(h.up('')).toBe('same');
    expect(h.up('')).toBe('same'); // 只存了一条
  });

  it('push 后重置到最新草稿位', () => {
    const h = new InputHistory();
    h.push('a');
    h.push('b');
    h.up('');
    h.up('');
    h.push('c');
    expect(h.up('')).toBe('c');
  });
});

describe('DoublePress:双击消歧状态机(注入时钟)', () => {
  it('窗口内第二击触发;触发后归零不连发', () => {
    const d = new DoublePress(500);
    expect(d.hit(1000)).toBe(false);
    expect(d.hit(1400)).toBe(true); // 400ms < 500ms
    expect(d.hit(1500)).toBe(false); // 已消费,第三击重新开窗
  });

  it('超窗不触发;reset 打断计数', () => {
    const d = new DoublePress(500);
    expect(d.hit(0)).toBe(false);
    expect(d.hit(600)).toBe(false); // 超窗:视为新的第一击
    expect(d.hit(700)).toBe(true);
    d.reset();
    expect(d.hit(701)).toBe(false); // reset 后需重新双击
  });

  it('窗口常量与规格一致(Esc 500ms / Ctrl+C 1.5s / 消歧 50ms)', () => {
    expect(ESC_EXIT_WINDOW_MS).toBe(500);
    expect(CTRL_C_EXIT_WINDOW_MS).toBe(1500);
    expect(ESC_TIMEOUT_MS).toBe(50);
  });
});

describe('/status 与 /queue 输出格式', () => {
  it('formatStatusLines 含模型、turns、token 累计与成本', () => {
    const usage: SessionUsage = {
      lastTurn: { input: 120, output: 31 },
      cumulative: { input: 2310, output: 95, costUSD: 0.0123, reasoning: 7 },
      turns: 3,
      contextTokens: 2405,
    };
    const lines = formatStatusLines(usage, 'gpt-5.2');
    expect(lines.join('\n')).toContain('model: gpt-5.2');
    expect(lines.join('\n')).toContain('turns: 3');
    expect(lines.join('\n')).toContain('tokens: 2310 in / 95 out (7 reasoning)');
    expect(lines.join('\n')).toContain('cost: $0.0123');
    expect(lines.join('\n')).toContain('last turn: 120 in / 31 out');
  });

  it('formatStatusLines 无定价/无模型时省略对应行(不渲染 0 成本)', () => {
    const usage: SessionUsage = { cumulative: { input: 10, output: 2 }, turns: 1, contextTokens: 12 };
    const joined = formatStatusLines(usage).join('\n');
    expect(joined).not.toContain('model:');
    expect(joined).not.toContain('cost:');
    expect(joined).toContain('tokens: 10 in / 2 out');
  });

  it('formatQueueLines:空队列提示;非空列出条目并截断长文本', () => {
    expect(formatQueueLines([], [])).toEqual(['queues empty']);
    const s: QueuedMessage[] = [{ id: 's1', text: 'a'.repeat(80), kind: 'steering' }];
    const f: QueuedMessage[] = [{ id: 'f1', text: 'short', kind: 'follow_up' }];
    const lines = formatQueueLines(s, f);
    expect(lines[0]).toBe('steering (1):');
    expect(lines[1]).toContain('…'); // 60 字符截断
    expect(lines).toContain('follow-up (1):');
    expect(lines).toContain('  1. short'); // 序号按各自队列内计
  });
});

describe('approvalKeyDecision:审批模式键位映射(M6,docs/09 §4)', () => {
  it('y=allow_once / a=allow_always / n=deny / Esc=abort', () => {
    expect(approvalKeyDecision('y')).toBe('allow_once');
    expect(approvalKeyDecision('a')).toBe('allow_always');
    expect(approvalKeyDecision('n')).toBe('deny');
    expect(approvalKeyDecision('escape')).toBe('abort');
  });

  it('其余键无审批动作(吞键由 repl 键位层负责,本映射只认四键)', () => {
    expect(approvalKeyDecision('return')).toBeUndefined();
    expect(approvalKeyDecision('q')).toBeUndefined();
    expect(approvalKeyDecision('')).toBeUndefined();
    expect(approvalKeyDecision('space')).toBeUndefined();
  });
});
