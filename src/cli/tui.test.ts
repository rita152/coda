// OpenTUI 视图回归测试：用内存 TestRenderer 验证全屏分区、顶部向下的转录顺序、
// 固定底部状态、响应式降级与 Enter/Shift+Enter。无需真实 TTY 或网络。

import { afterEach, describe, expect, it } from 'bun:test';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalBroker } from '../agent/index.js';
import type {
  AssistantMessage,
  ProviderEvent,
  ToolResultMessage,
  UserMessage,
} from '../protocol/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import { Session } from '../session/index.js';
import type { SessionEvent, SessionUsage } from '../session/index.js';
import {
  approvalDecisionForKey,
  createTuiScreen,
  formatContextUsage,
  formatTokenCount,
  formatWorkspacePath,
  runTuiController,
  sanitizeTerminalText,
  TuiInteractionState,
  tuiCanAbort,
  tuiEnterState,
} from './tui.js';
import type { TuiScreen } from './tui.js';

const MODEL = { provider: 'openai', api: 'openai-chat', model: 'gpt-5.2' };
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    id: 'a1',
    timestamp: 1,
    content: [],
    model: MODEL,
    stopReason: 'stop',
    usage: { input: 0, output: 0 },
    ...over,
  };
}

function user(text: string): UserMessage {
  return {
    role: 'user',
    id: 'u1',
    timestamp: 0,
    content: [{ type: 'text', text }],
    source: 'prompt',
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  over: Partial<ToolResultMessage> = {},
): ToolResultMessage {
  return {
    role: 'tool_result',
    id: `result-${toolCallId}`,
    timestamp: 2,
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    ...over,
  };
}

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-tui-'));
  tempDirs.push(dir);
  return dir;
}

function waitForSessionEvent(
  session: Session,
  predicate: (event: SessionEvent) => boolean,
): Promise<SessionEvent> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function textDelta(delta: string): ProviderEvent {
  return {
    type: 'text_delta',
    contentIndex: 0,
    delta,
    partial: assistant(),
  };
}

async function setup(
  width = 100,
  height = 30,
  onSubmit: () => void = () => {},
): Promise<{
  screen: TuiScreen;
  flush: () => Promise<void>;
  frame: () => string;
  spans: Awaited<ReturnType<typeof createTestRenderer>>['captureSpans'];
  resize: (width: number, height: number) => void;
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>['mockInput'];
  renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'];
  interaction: TuiInteractionState;
  resolveHighlights: () => Promise<void>;
  destroyHighlighter: () => Promise<void>;
  destroy: () => Promise<void>;
}> {
  const testRenderer = await createTestRenderer({ width, height, kittyKeyboard: true });
  const treeSitterClient = new MockTreeSitterClient();
  const interaction = new TuiInteractionState();
  const screen = await createTuiScreen(testRenderer.renderer, {
    cwd: '/Users/test/work/coda',
    model: MODEL,
    version: '0.0.1',
    color: true,
    contextLimit: 128_000,
    onSubmit,
    interaction,
    treeSitterClient,
  });
  return {
    screen,
    flush: () => testRenderer.flush(),
    frame: testRenderer.captureCharFrame,
    spans: testRenderer.captureSpans,
    resize: testRenderer.resize,
    mockInput: testRenderer.mockInput,
    renderer: testRenderer.renderer,
    interaction,
    resolveHighlights: async () => {
      treeSitterClient.resolveAllHighlightOnce();
      await testRenderer.flush();
    },
    destroyHighlighter: async () => {
      treeSitterClient.resolveAllHighlightOnce();
      await treeSitterClient.destroy();
    },
    destroy: async () => {
      treeSitterClient.resolveAllHighlightOnce();
      await testRenderer.waitForVisualIdle();
      await testRenderer.renderer.idle();
      testRenderer.renderer.destroy();
      screen.destroy();
      await treeSitterClient.destroy();
    },
  };
}

describe('TUI footer 格式', () => {
  it('token 使用紧凑 1000 制格式', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_250)).toBe('1.3k');
    expect(formatTokenCount(128_000)).toBe('128k');
    expect(formatTokenCount(2_400_000)).toBe('2.4m');
  });

  it('只在明确知道上限时显示占用百分比', () => {
    expect(formatContextUsage(2_405)).toBe('context 2.4k tokens · limit unknown');
    expect(formatContextUsage(2_405, 128_000)).toBe('context 2.4k / 128k · 1.9%');
  });

  it('workspace 仅缩写 HOME 的真实子路径', () => {
    expect(formatWorkspacePath('/Users/test', '/Users/test')).toBe('~');
    expect(formatWorkspacePath('/Users/test/work/coda', '/Users/test')).toBe('~/work/coda');
    expect(formatWorkspacePath('/Users/tester/work', '/Users/test')).toBe('/Users/tester/work');
  });
});

describe('全屏 OpenTUI 布局', () => {
  it('顶部显示版本、像素 Logo 和 tips，底部固定 prompt 与两行状态', async () => {
    const view = await setup();
    try {
      await view.flush();
      const frame = view.frame();
      expect(frame).toContain('coda v0.0.1');
      expect(frame).toContain('▄█▄');
      expect(frame).toContain('Tips for getting started');
      expect(frame).toContain('Ask coda anything…');
      expect(frame).toContain('/Users/test/work/coda');
      expect(frame).toContain('context 0 / 128k · 0%');
      expect(frame).toContain('openai/gpt-5.2');
    } finally {
      await view.destroy();
    }
  });

  it('默认主题让整帧不透明，并把主画布与转录空白区渲染为纯白', async () => {
    const view = await setup();
    try {
      await view.flush();
      const lines = view.spans().lines;
      const allSpans = lines.flatMap((line) => line.spans);
      expect(allSpans.length).toBeGreaterThan(0);
      for (const span of allSpans) {
        expect(span.bg.toInts()[3]).toBe(255);
      }

      const headerLine = lines[4];
      expect(headerLine).toBeDefined();
      for (const span of headerLine?.spans ?? []) {
        expect(span.bg.toInts().slice(0, 3)).toEqual([250, 250, 250]);
        expect(span.bg.intent).toBe('indexed');
        expect(span.bg.slot).toBe(255);
      }

      const transcriptLine = lines[10];
      expect(transcriptLine).toBeDefined();
      expect(transcriptLine?.spans.length).toBeGreaterThan(0);
      for (const span of transcriptLine?.spans ?? []) {
        expect(span.bg.toInts().slice(0, 3)).toEqual([255, 255, 255]);
        expect(span.bg.intent).toBe('indexed');
        expect(span.bg.slot).toBe(231);
      }

      for (const line of lines.slice(-2)) {
        for (const span of line.spans) {
          expect(span.bg.toInts().slice(0, 3)).toEqual([255, 255, 255]);
        }
      }
    } finally {
      await view.destroy();
    }
  });

  it('短转录从中区顶部向下追加，不贴着 prompt 从底部上推', async () => {
    const view = await setup();
    try {
      view.screen.render({ type: 'message_start', message: user('inspect the repository') });
      view.screen.render({ type: 'message_start', message: assistant() });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: textDelta('I will start at the top of the output area.'),
      });
      view.screen.render({
        type: 'message_end',
        message: assistant({
          content: [{ type: 'text', text: 'I will start at the top of the output area.' }],
        }),
      });
      await view.flush();
      await view.resolveHighlights();

      const lines = view.frame().split('\n');
      const headerBottom = lines.findIndex((line) => line.startsWith('└'));
      const userRow = lines.findIndex((line) => line.trim() === 'you');
      const assistantRow = lines.findIndex((line) => line.includes('I will start at the top'));
      const promptRow = lines.findIndex((line) => line.includes('coda · ready'));

      expect(headerBottom).toBeGreaterThanOrEqual(0);
      expect(userRow).toBeGreaterThan(headerBottom);
      expect(userRow - headerBottom).toBeLessThanOrEqual(3);
      expect(assistantRow).toBeGreaterThan(userRow);
      expect(assistantRow).toBeLessThan(promptRow);
      expect(promptRow - assistantRow).toBeGreaterThan(4);
    } finally {
      await view.destroy();
    }
  });

  it('usage_update 刷新 context 状态而不使用 cumulative token', async () => {
    const view = await setup();
    try {
      const usage: SessionUsage = {
        cumulative: { input: 90_000, output: 10_000 },
        turns: 5,
        contextTokens: 4_096,
      };
      view.screen.render({ type: 'usage_update', usage });
      await view.flush();
      const frame = view.frame();
      expect(frame).toContain('context 4.1k / 128k · 3.2%');
      expect(frame).not.toContain('context 100k');
    } finally {
      await view.destroy();
    }
  });

  it('窄终端隐藏 Logo/tips，但保留版本、输入与 context 行', async () => {
    const view = await setup();
    try {
      view.resize(54, 18);
      await view.flush();
      const frame = view.frame();
      expect(frame).toContain('coda v0.0.1');
      expect(frame).not.toContain('Tips for getting started');
      expect(frame).not.toContain('▄█▄');
      expect(frame).toContain('Ask coda anything…');
      expect(frame).toContain('context 0 / 128k');
    } finally {
      await view.destroy();
    }
  });

  it('resize 可恢复完整快捷键，且不会覆盖审批键位', async () => {
    const view = await setup();
    try {
      view.screen.render({
        type: 'approval_request',
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        description: 'run bun test',
      });
      view.resize(54, 18);
      await view.flush();
      expect(view.frame()).toContain('y once · a always · n deny · Esc abort');

      view.screen.resolveApproval();
      view.resize(100, 30);
      await view.flush();
      expect(view.frame()).toContain('Enter send · Shift+Enter newline');
      expect(view.frame()).not.toContain('Enter send · Shift+Enter line ');
    } finally {
      await view.destroy();
    }
  });

  it('Enter 提交，Shift+Enter 只插入换行', async () => {
    let submissions = 0;
    const view = await setup(80, 24, () => {
      submissions++;
    });
    try {
      view.screen.focusInput();
      await view.mockInput.typeText('first');
      view.mockInput.pressEnter({ shift: true });
      await view.mockInput.typeText('second');
      await view.flush();
      expect(submissions).toBe(0);
      expect(view.screen.getInput()).toBe('first\nsecond');

      view.mockInput.pressEnter();
      await view.flush();
      expect(submissions).toBe(1);
    } finally {
      await view.destroy();
    }
  });

  it('Kitty 小键盘 Enter 提交而不是插入换行', async () => {
    let submissions = 0;
    const view = await setup(80, 24, () => {
      submissions++;
    });
    try {
      view.screen.focusInput();
      await view.mockInput.typeText('keypad');
      await view.mockInput.pressKeys(['\x1b[57414u']);
      await view.flush();
      expect(submissions).toBe(1);
      expect(view.screen.getInput()).toBe('keypad');
    } finally {
      await view.destroy();
    }
  });

  it('历史恢复后把 CJK 与 ZWJ emoji 光标放在真实末尾', async () => {
    const view = await setup();
    try {
      view.screen.focusInput();
      view.screen.setInput('中文');
      await view.mockInput.typeText('X');
      expect(view.screen.getInput()).toBe('中文X');

      view.screen.setInput('A🧑‍💻B');
      await view.mockInput.typeText('Z');
      expect(view.screen.getInput()).toBe('A🧑‍💻BZ');
    } finally {
      await view.destroy();
    }
  });
});

describe('TUI 安全渲染与转录恢复', () => {
  it('统一移除 ANSI/OSC/DCS 与危险 C0/C1，同时保留 Unicode、tab 和换行', () => {
    const raw =
      '甲\t乙\n' +
      '\x1b]52;c;U0VDUkVU\x07' +
      '\x1b[31mred\x1b[0m' +
      '\x1bP1;2|DCS_SECRET\x1b\\' +
      '\x00\x08\x0b\x7f\x9f';
    const clean = sanitizeTerminalText(raw);

    expect(clean).toBe('甲\t乙\nred');
    expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(sanitizeTerminalText(clean)).toBe(clean);
  });

  it('所有事件来源进入 Text/Markdown 前都清除终端控制序列', async () => {
    const view = await setup();
    const osc = '\x1b]52;c;Q09EQV9JTkpfU0VDUkVU\x07';
    try {
      view.screen.render({ type: 'message_start', message: user(`user${osc}safe`) });
      view.screen.render({ type: 'message_start', message: assistant() });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: textDelta(`assistant${osc}safe`),
      });
      view.screen.render({
        type: 'message_end',
        message: assistant({ content: [{ type: 'text', text: `final${osc}safe` }] }),
      });
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: `printf ${osc}safe` },
      });
      view.screen.render({
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        update: { output: `tail${osc}safe` },
      });
      view.screen.render({
        type: 'plan_update',
        steps: [{ step: `inspect${osc}safe`, status: 'in_progress' }],
      });
      view.screen.render({
        type: 'approval_request',
        approvalId: 'approval-1',
        toolCallId: 'tool-1',
        description: `run${osc}safe`,
      });
      view.screen.render({ type: 'error', fatal: false, message: `warning${osc}safe` });
      await view.flush();
      await view.resolveHighlights();

      const frame = view.frame();
      expect(frame).not.toContain('\x1b');
      expect(frame).not.toContain('\x07');
      expect(frame).not.toContain('Q09EQV9JTkpfU0VDUkVU');
      expect(frame).toContain('finalsafe');
      expect(frame).toContain('warningsafe');
    } finally {
      await view.destroy();
    }
  });

  it('流式 text/reasoning 按 contentIndex 保持块边界，终态不再跳变', async () => {
    const view = await setup();
    try {
      const textOne = assistant({ content: [{ type: 'text', text: '' }] });
      const textTwo = assistant({
        content: [
          { type: 'text', text: 'FIRST' },
          { type: 'text', text: '' },
        ],
      });
      const reasoningOne = assistant({
        content: [
          { type: 'text', text: 'FIRST' },
          { type: 'text', text: 'SECOND' },
          { type: 'reasoning', text: '' },
        ],
      });
      const reasoningTwo = assistant({
        content: [
          { type: 'text', text: 'FIRST' },
          { type: 'text', text: 'SECOND' },
          { type: 'reasoning', text: 'THINK-ONE' },
          { type: 'reasoning', text: '' },
        ],
      });

      view.screen.render({ type: 'message_start', message: assistant() });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'text_start', contentIndex: 0, partial: textOne },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'text_delta', contentIndex: 0, delta: 'FIRST', partial: textOne },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'text_end', contentIndex: 0, content: 'FIRST', partial: textOne },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'text_start', contentIndex: 1, partial: textTwo },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'text_delta', contentIndex: 1, delta: 'SECOND', partial: textTwo },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'reasoning_start', contentIndex: 2, partial: reasoningOne },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: {
          type: 'reasoning_delta',
          contentIndex: 2,
          delta: 'THINK-ONE',
          partial: reasoningOne,
        },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: {
          type: 'reasoning_end',
          contentIndex: 2,
          content: 'THINK-ONE',
          partial: reasoningOne,
        },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: { type: 'reasoning_start', contentIndex: 3, partial: reasoningTwo },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'a1',
        event: {
          type: 'reasoning_delta',
          contentIndex: 3,
          delta: 'THINK-TWO',
          partial: reasoningTwo,
        },
      });
      await view.flush();
      await view.resolveHighlights();
      const streaming = view.frame();
      expect(streaming).not.toContain('FIRSTSECOND');
      expect(streaming).not.toContain('THINK-ONETHINK-TWO');
      expect(streaming.indexOf('SECOND')).toBeGreaterThan(streaming.indexOf('FIRST'));
      expect(streaming.indexOf('THINK-TWO')).toBeGreaterThan(streaming.indexOf('THINK-ONE'));

      view.screen.render({
        type: 'message_end',
        message: assistant({
          content: [
            { type: 'text', text: 'FIRST' },
            { type: 'text', text: 'SECOND' },
            { type: 'reasoning', text: 'THINK-ONE' },
            { type: 'reasoning', text: 'THINK-TWO' },
          ],
        }),
      });
      await view.flush();
      await view.resolveHighlights();
      const finalFrame = view.frame();
      expect(finalFrame).not.toContain('FIRSTSECOND');
      expect(finalFrame).not.toContain('THINK-ONETHINK-TWO');
    } finally {
      await view.destroy();
    }
  });

  it('恢复时重建工具参数摘要、最新 plan，并显示 plan 失败', async () => {
    const view = await setup(100, 50);
    try {
      view.screen.replayTranscript([
        assistant({
          id: 'a-tools-1',
          content: [
            {
              type: 'tool_call',
              id: 'plan-1',
              name: 'plan',
              arguments: { steps: [{ step: 'old step', status: 'in_progress' }] },
            },
            {
              type: 'tool_call',
              id: 'bash-1',
              name: 'bash',
              arguments: { command: 'bun test' },
            },
          ],
          stopReason: 'tool_calls',
        }),
        toolResult('plan-1', 'plan', '1. [in_progress] old step', {
          details: { steps: [{ step: 'old step', status: 'in_progress' }] },
        }),
        toolResult('bash-1', 'bash', 'tests passed'),
        assistant({
          id: 'a-tools-2',
          content: [
            {
              type: 'tool_call',
              id: 'plan-2',
              name: 'plan',
              arguments: { steps: [{ step: 'new step', status: 'completed' }] },
            },
            { type: 'tool_call', id: 'plan-3', name: 'plan', arguments: {} },
            { type: 'tool_call', id: 'plan-4', name: 'plan', arguments: {} },
          ],
          stopReason: 'tool_calls',
        }),
        toolResult('plan-2', 'plan', '1. [completed] new step', {
          details: { steps: [{ step: 'new step', status: 'completed' }] },
        }),
        toolResult('plan-3', 'plan', 'invalid plan arguments', { isError: true }),
        toolResult('plan-4', 'plan', 'malformed plan details'),
      ]);
      await view.flush();
      await view.resolveHighlights();

      const frame = view.frame();
      expect(frame).toContain('bash: bun test');
      expect(frame).toContain('new step');
      expect(frame).not.toContain('old step');
      expect(frame).toContain('invalid plan arguments');
      expect(frame).toContain('✗ plan');
      expect(frame).toContain('malformed plan details');
    } finally {
      await view.destroy();
    }
  });
});

describe('TUI 交互状态投影', () => {
  it('retry 取消和 compaction 结束都回到 idle，Enter/Esc 语义按 phase 区分', async () => {
    const view = await setup();
    try {
      view.screen.render({
        type: 'agent_end',
        reason: 'error',
        messages: [],
        willRetry: true,
      });
      view.screen.render({
        type: 'retry_scheduled',
        attempt: 1,
        maxAttempts: 5,
        delayMs: 1_000,
        errorMessage: 'retry me',
      });
      expect(view.interaction.phase).toBe('retrying');
      expect(tuiEnterState(view.interaction.phase)).toBe('running');
      expect(tuiCanAbort(view.interaction.phase)).toBe(true);

      view.screen.render({ type: 'error', fatal: false, message: 'retry cancelled by abort' });
      await view.flush();
      expect(view.interaction.phase).toBe('idle');
      expect(view.frame()).toContain('coda · ready');

      view.screen.render({ type: 'compaction_start', reason: 'threshold' });
      await view.flush();
      expect(view.interaction.phase).toBe('compacting');
      expect(tuiEnterState(view.interaction.phase)).toBe('idle');
      expect(tuiCanAbort(view.interaction.phase)).toBe(true);
      expect(view.frame()).toContain('coda · compacting context');

      view.screen.render({ type: 'compaction_end', ok: false, droppedMessages: 0 });
      await view.flush();
      expect(view.interaction.phase).toBe('idle');
      expect(view.frame()).toContain('coda · ready');
    } finally {
      await view.destroy();
    }
  });

  it('审批只接受完全无修饰键的决议', () => {
    const plain = {
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      super: false,
      hyper: false,
    };
    expect(approvalDecisionForKey(plain)).toBe('allow_always');
    for (const modifier of ['ctrl', 'meta', 'shift', 'option', 'super', 'hyper'] as const) {
      expect(approvalDecisionForKey({ ...plain, [modifier]: true })).toBeUndefined();
    }
  });
});

describe('TUI 控制器接线', () => {
  it('审批期间冻结修饰键和 bracketed paste，决议后恢复输入', async () => {
    const session = await Session.create({
      dir: makeTempDir(),
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: { ref: MODEL },
        tools: [],
        systemPrompt: 'test',
      },
    });
    const listeners = new Set<(event: SessionEvent) => void>();
    const broker = new ApprovalBroker((event) => {
      for (const listener of [...listeners]) listener(event);
    });
    const approval = {
      broker,
      onAbort: (): void => {
        broker.abortAll();
      },
      subscribe(listener: (event: SessionEvent) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const view = await setup();
    view.screen.focusInput();
    const controller = runTuiController(
      session,
      approval,
      view.screen,
      view.renderer,
      {
        model: MODEL,
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    view.screen.setInput('seed');
    const pending = broker.request({
      toolCallId: 'call-1',
      description: 'run tests',
      patterns: ['bash:bun test'],
    });
    await view.flush();
    expect(broker.pendingCount).toBe(1);

    await view.mockInput.pasteBracketedText('PASTED\nTEXT');
    view.mockInput.pressKey('a', { meta: true });
    view.mockInput.pressKey('a', { super: true });
    await view.flush();
    expect(view.screen.getInput()).toBe('seed');
    expect(broker.pendingCount).toBe(1);

    view.mockInput.pressKey('a');
    expect(await pending).toEqual({
      decision: 'allow_always',
      learned: ['bash:bun test'],
    });
    await view.mockInput.pasteBracketedText('AFTER\nTEXT');
    await view.flush();
    expect(view.screen.getInput()).toBe('seedAFTER\nTEXT');

    view.screen.clearInput();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

  it('retry 退避期间 Enter 进入 steering，不会启动第二个 prompt 破坏续跑', async () => {
    let releaseSleep: ((aborted: boolean) => void) | undefined;
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const streamFn = createFauxStreamFn({
      turns: [
        {
          error: {
            message: 'temporary provider failure',
            details: { kind: 'http', status: 500, retryable: true },
          },
        },
        { events: [{ kind: 'text', text: 'retry succeeded' }] },
      ],
    });
    const session = await Session.create({
      dir: makeTempDir(),
      agentConfig: {
        streamFn,
        model: { ref: MODEL },
        tools: [],
        systemPrompt: 'test',
      },
      retry: {
        jitter: () => 0.5,
        sleep: (_delayMs, signal) =>
          new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (aborted: boolean): void => {
              if (settled) return;
              settled = true;
              resolve(aborted);
            };
            releaseSleep = finish;
            signal.addEventListener('abort', () => {
              finish(true);
            }, { once: true });
            markSleepStarted();
          }),
      },
    });
    const errors: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'error') errors.push(event.message);
    });
    const view = await setup();
    view.screen.focusInput();
    const controller = runTuiController(
      session,
      undefined,
      view.screen,
      view.renderer,
      {
        model: MODEL,
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    const retryScheduled = waitForSessionEvent(
      session,
      (event) => event.type === 'retry_scheduled',
    );
    void session.prompt('initial prompt');
    await retryScheduled;
    await sleepStarted;
    expect(view.interaction.phase).toBe('retrying');

    const steeringQueued = waitForSessionEvent(
      session,
      (event) =>
        event.type === 'queue_update' &&
        event.steering.some((message) => message.text === 'steer during retry'),
    );
    await view.mockInput.typeText('steer during retry');
    view.mockInput.pressEnter();
    await steeringQueued;

    const finalAgentEnd = waitForSessionEvent(
      session,
      (event) => event.type === 'agent_end' && event.willRetry !== true,
    );
    expect(releaseSleep).toBeDefined();
    releaseSleep?.(false);
    await finalAgentEnd;
    expect(streamFn.calls).toHaveLength(2);
    expect(errors.some((message) => message.includes('Nothing to continue'))).toBe(false);
    expect(
      session.messages.some(
        (message) =>
          message.role === 'user' &&
          message.source === 'steering' &&
          message.content.some(
            (part) => part.type === 'text' && part.text === 'steer during retry',
          ),
      ),
    ).toBe(true);

    await view.resolveHighlights();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

  it('retry 退避期间单次 Esc 取消重试并恢复 idle', async () => {
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const streamFn = createFauxStreamFn({
      turns: [
        {
          error: {
            message: 'temporary provider failure',
            details: { kind: 'http', status: 500, retryable: true },
          },
        },
        { events: [{ kind: 'text', text: 'must not run' }] },
      ],
    });
    const session = await Session.create({
      dir: makeTempDir(),
      agentConfig: {
        streamFn,
        model: { ref: MODEL },
        tools: [],
        systemPrompt: 'test',
      },
      retry: {
        jitter: () => 0.5,
        sleep: (_delayMs, signal) =>
          new Promise<boolean>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve(true);
            }, { once: true });
            markSleepStarted();
          }),
      },
    });
    const view = await setup();
    view.screen.focusInput();
    const controller = runTuiController(
      session,
      undefined,
      view.screen,
      view.renderer,
      {
        model: MODEL,
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    const retryScheduled = waitForSessionEvent(
      session,
      (event) => event.type === 'retry_scheduled',
    );
    void session.prompt('initial prompt');
    await retryScheduled;
    await sleepStarted;
    const cancelled = waitForSessionEvent(
      session,
      (event) => event.type === 'error' && event.message === 'retry cancelled by abort',
    );

    view.mockInput.pressEscape();
    await cancelled;
    await view.flush();
    expect(streamFn.calls).toHaveLength(1);
    expect(view.interaction.phase).toBe('idle');
    expect(view.frame()).toContain('coda · ready');

    await view.resolveHighlights();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });
});
