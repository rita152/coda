// TUI interaction decision tests: slash-command dispatch, insert-mode Enter routing,
// per-thread history, double-press disambiguation, approval keys, and status projections.

import { describe, expect, it } from 'bun:test';
import type { CliThreadUsage } from './frontend-types.js';
import {
  approvalKeyDecision,
  CTRL_C_EXIT_WINDOW_MS,
  decideEnter,
  DoublePress,
  formatStatusLines,
  InputHistory,
  INSERT_MODE_CHOICES,
  interactionCanAbort,
  interactionEnterState,
  parseSlashCommand,
  selectInsertModeChoice,
  SLASH_COMMAND_SPECS,
} from './tui-controls.js';

describe('TUI slash command parsing', () => {
  it('识别 canonical 命令及 /q 短别名', () => {
    expect(parseSlashCommand('/quit')).toEqual({ cmd: 'quit' });
    expect(parseSlashCommand('/q')).toEqual({ cmd: 'quit' });
    expect(parseSlashCommand('/insert-mode')).toEqual({ cmd: 'insert_mode' });
    expect(parseSlashCommand('/status')).toEqual({ cmd: 'status' });
    expect(parseSlashCommand('/help')).toEqual({ cmd: 'help' });
    expect(parseSlashCommand('/login')).toEqual({ cmd: 'login' });
    expect(parseSlashCommand('/model')).toEqual({ cmd: 'model' });
    expect(parseSlashCommand('/logout')).toEqual({ cmd: 'logout' });
    expect(parseSlashCommand('/auth')).toEqual({ cmd: 'auth_status' });
    expect(parseSlashCommand('/auth-status')).toEqual({ cmd: 'auth_status' });
    expect(parseSlashCommand('/doctor')).toEqual({ cmd: 'doctor' });
  });

  it('/queue 与 /followup 已退役，解析为 unknown', () => {
    expect(parseSlashCommand('/queue')).toEqual({ cmd: 'unknown', input: '/queue' });
    expect(parseSlashCommand('/f 顺便改下颜色')).toEqual({
      cmd: 'unknown',
      input: '/f 顺便改下颜色',
    });
    expect(parseSlashCommand('/followup run tests')).toEqual({
      cmd: 'unknown',
      input: '/followup run tests',
    });
  });

  it('解析 presentation、搜索、copy/export 与 Vim 命令', () => {
    expect(parseSlashCommand('/search tool call')).toEqual({
      cmd: 'transcript_search',
      query: 'tool call',
    });
    expect(parseSlashCommand('/prev')).toEqual({ cmd: 'search_previous' });
    expect(parseSlashCommand('/copy raw')).toEqual({ cmd: 'copy', mode: 'raw' });
    expect(parseSlashCommand('/export raw report.jsonl')).toEqual({
      cmd: 'export',
      mode: 'raw',
      path: 'report.jsonl',
    });
    expect(parseSlashCommand('/export report with spaces.txt')).toEqual({
      cmd: 'export',
      mode: 'text',
      path: 'report with spaces.txt',
    });
    expect(parseSlashCommand('/vim on')).toEqual({ cmd: 'vim', mode: 'on' });
    expect(parseSlashCommand('/files src')).toEqual({ cmd: 'file_complete', query: 'src' });
  });

  it('解析审阅、恢复与 session 管理命令', () => {
    expect(parseSlashCommand('/diff WORKSPACE')).toEqual({
      cmd: 'diff',
      scope: 'workspace',
    });
    expect(parseSlashCommand('/review')).toEqual({ cmd: 'review' });
    expect(parseSlashCommand('/permissions')).toEqual({ cmd: 'permissions' });
    expect(parseSlashCommand('/compact')).toEqual({ cmd: 'compact' });
    expect(parseSlashCommand('/retry turn-1')).toEqual({ cmd: 'retry', turnId: 'turn-1' });
    expect(parseSlashCommand('/fork turn-2')).toEqual({ cmd: 'fork', turnId: 'turn-2' });
    expect(parseSlashCommand('/new')).toEqual({ cmd: 'new' });
    expect(parseSlashCommand('/sessions running')).toEqual({
      cmd: 'sessions',
      query: 'running',
    });
    expect(parseSlashCommand('/resume thread-1')).toEqual({
      cmd: 'resume',
      threadId: 'thread-1',
    });
    expect(parseSlashCommand('/switch thread-2')).toEqual({
      cmd: 'switch',
      threadId: 'thread-2',
    });
    expect(parseSlashCommand('/rename Review Pass')).toEqual({
      cmd: 'rename',
      title: 'Review Pass',
    });
    expect(parseSlashCommand('/archive OFF')).toEqual({ cmd: 'archive', mode: 'off' });
  });

  it('非斜杠返回 undefined，未知斜杠返回 unknown', () => {
    expect(parseSlashCommand('hello')).toBeUndefined();
    expect(parseSlashCommand('/wat now')).toEqual({ cmd: 'unknown', input: '/wat now' });
  });

  it('目录中的 canonical 命令与隐藏别名都由解析器识别', () => {
    for (const command of SLASH_COMMAND_SPECS) {
      const suffix = command.argumentHint === undefined ? '' : ' example';
      expect(parseSlashCommand(`/${command.name}${suffix}`)?.cmd).not.toBe('unknown');
      for (const alias of command.aliases ?? []) {
        expect(parseSlashCommand(`/${alias}${suffix}`)?.cmd).not.toBe('unknown');
      }
    }
  });
});

describe('TUI Enter routing', () => {
  it('空输入在空闲与运行中都不提交', () => {
    expect(decideEnter('idle', 'steering', '')).toEqual({ kind: 'none' });
    expect(decideEnter('running', 'steering', '   ')).toEqual({ kind: 'none' });
  });

  it('默认 steering：空闲 Enter=prompt，运行中 Enter=steer', () => {
    expect(decideEnter('idle', 'steering', '改一下')).toEqual({ kind: 'prompt', text: '改一下' });
    expect(decideEnter('running', 'steering', '改一下')).toEqual({ kind: 'steer', text: '改一下' });
  });

  it('following 模式：空闲 Enter 仍为 prompt，运行中 Enter=follow-up', () => {
    expect(decideEnter('idle', 'following', '改一下')).toEqual({ kind: 'prompt', text: '改一下' });
    expect(decideEnter('running', 'following', '改一下')).toEqual({
      kind: 'follow_up',
      text: '改一下',
    });
  });

  it('insert mode 选择只接受 steering/following 或对应序号', () => {
    expect(INSERT_MODE_CHOICES.map((choice) => choice.label)).toEqual([
      'steering',
      'following',
    ]);
    expect(selectInsertModeChoice('steering')).toBe('steering');
    expect(selectInsertModeChoice('following')).toBe('following');
    expect(selectInsertModeChoice('1')).toBe('steering');
    expect(selectInsertModeChoice('2')).toBe('following');
    expect(selectInsertModeChoice('')).toBeUndefined();
    expect(selectInsertModeChoice('queue')).toBeUndefined();
  });

  it('运行中执行可用命令，provider 管理命令进入控制器', () => {
    expect(decideEnter('idle', 'steering', '/insert-mode')).toEqual({
      kind: 'command',
      command: { cmd: 'insert_mode' },
    });
    expect(decideEnter('running', 'following', '/insert-mode')).toEqual({
      kind: 'command',
      command: { cmd: 'insert_mode' },
    });
    expect(decideEnter('idle', 'steering', '/status')).toEqual({
      kind: 'command',
      command: { cmd: 'status' },
    });
    expect(decideEnter('running', 'following', '/status')).toEqual({
      kind: 'command',
      command: { cmd: 'status' },
    });
    expect(decideEnter('running', 'following', '/search error')).toEqual({
      kind: 'command',
      command: { cmd: 'transcript_search', query: 'error' },
    });
    expect(decideEnter('running', 'following', '/archive off')).toEqual({
      kind: 'command',
      command: { cmd: 'archive', mode: 'off' },
    });
    for (const cmd of ['login', 'model', 'logout'] as const) {
      expect(decideEnter('running', 'following', `/${cmd}`)).toEqual({
        kind: 'command',
        command: { cmd },
      });
    }
  });

  it('compacting 的 Enter 走 prompt/命令，但仍可 abort', () => {
    const state = interactionEnterState('compacting');
    expect(state).toBe('idle');
    expect(interactionCanAbort('compacting')).toBe(true);
    expect(decideEnter(state, 'following', '压缩后继续')).toEqual({
      kind: 'prompt',
      text: '压缩后继续',
    });
    expect(decideEnter(state, 'steering', '/quit')).toEqual({
      kind: 'command',
      command: { cmd: 'quit' },
    });
  });
});

describe('TUI prompt history', () => {
  it('依次回翻、到顶停住，并翻回原草稿', () => {
    const history = new InputHistory();
    history.push('first');
    history.push('second');
    expect(history.up('draft-in-progress')).toBe('second');
    expect(history.up('')).toBe('first');
    expect(history.up('')).toBe('first');
    expect(history.down()).toBe('second');
    expect(history.down()).toBe('draft-in-progress');
    expect(history.down()).toBe('draft-in-progress');
  });

  it('忽略空白与连续重复，并在 push 后回到最新位置', () => {
    const history = new InputHistory();
    expect(history.up('keep me')).toBe('keep me');
    history.push('   ');
    expect(history.up('still me')).toBe('still me');
    history.push('same');
    history.push('same');
    expect(history.up('')).toBe('same');
    expect(history.up('')).toBe('same');
    history.push('newest');
    expect(history.up('')).toBe('newest');
  });

  it('Ctrl+R 以 query 反向搜索旧 prompt，reset 后重新开始', () => {
    const history = new InputHistory();
    history.push('fix parser');
    history.push('run tests');
    history.push('fix renderer');
    expect(history.reverseSearch('fix')).toBe('fix renderer');
    expect(history.reverseSearch('fix')).toBe('fix parser');
    expect(history.reverseSearch('fix')).toBeUndefined();
    history.resetSearch();
    expect(history.reverseSearch('tests')).toBe('run tests');
  });

  it('切换 thread 时替换历史投影，不泄漏来源 thread', () => {
    const history = new InputHistory();
    history.replace(['source A', 'source B']);
    expect(history.reverseSearch('source')).toBe('source B');
    history.replace(['target only']);
    expect(history.reverseSearch('source')).toBeUndefined();
    expect(history.reverseSearch('target')).toBe('target only');
    expect(history.up('target draft')).toBe('target only');
    expect(history.down()).toBe('target draft');
  });
});

describe('TUI double-press disambiguation', () => {
  it('窗口内第二击触发，触发后归零不连发', () => {
    const presses = new DoublePress(500);
    expect(presses.hit(1_000)).toBe(false);
    expect(presses.hit(1_400)).toBe(true);
    expect(presses.hit(1_500)).toBe(false);
  });

  it('超窗不触发，reset 打断计数', () => {
    const presses = new DoublePress(500);
    expect(presses.hit(0)).toBe(false);
    expect(presses.hit(600)).toBe(false);
    expect(presses.hit(700)).toBe(true);
    presses.reset();
    expect(presses.hit(701)).toBe(false);
  });

  it('Ctrl+C 退出窗口常量为 1.5s', () => {
    expect(CTRL_C_EXIT_WINDOW_MS).toBe(1_500);
  });
});

describe('TUI status formatting', () => {
  it('status 包含模型、turns、token 累计与成本', () => {
    const usage: CliThreadUsage = {
      lastTurn: { input: 120, output: 31 },
      cumulative: { input: 2_310, output: 95, costUSD: 0.0123, reasoning: 7 },
      turns: 3,
      contextTokens: 2_405,
    };
    const joined = formatStatusLines(usage, 'gpt-5.2').join('\n');
    expect(joined).toContain('model: gpt-5.2');
    expect(joined).toContain('turns: 3');
    expect(joined).toContain('tokens: 2310 in / 95 out (7 reasoning)');
    expect(joined).toContain('cost: $0.0123');
    expect(joined).toContain('last turn: 120 in / 31 out');
  });

  it('无定价/无模型时省略对应行', () => {
    const usage: CliThreadUsage = {
      cumulative: { input: 10, output: 2 },
      turns: 1,
      contextTokens: 12,
    };
    const joined = formatStatusLines(usage).join('\n');
    expect(joined).not.toContain('model:');
    expect(joined).not.toContain('cost:');
    expect(joined).toContain('tokens: 10 in / 2 out');
  });
});

describe('TUI approval key mapping', () => {
  it('只接受 y/a/n/Esc 四个审批键', () => {
    expect(approvalKeyDecision('y')).toBe('allow_once');
    expect(approvalKeyDecision('a')).toBe('allow_always');
    expect(approvalKeyDecision('n')).toBe('deny');
    expect(approvalKeyDecision('escape')).toBe('abort');
    expect(approvalKeyDecision('return')).toBeUndefined();
    expect(approvalKeyDecision('q')).toBeUndefined();
    expect(approvalKeyDecision('')).toBeUndefined();
    expect(approvalKeyDecision('space')).toBeUndefined();
  });
});
