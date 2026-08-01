// OpenTUI 视图回归测试：用内存 TestRenderer 验证全屏分区、顶部向下的转录顺序、
// 固定底部状态、响应式降级与 Enter/Shift+Enter。无需真实 TTY 或网络。

import { afterEach, describe, expect, it } from 'bun:test';
import {
  BoxRenderable,
  type KeyEvent,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
} from '@opentui/core';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalBroker } from '../agent/index.js';
import type {
  AssistantMessage,
  ProviderEvent,
  ThreadId,
  ToolResultMessage,
  UserMessage,
  WorkspaceRuntimeSnapshot,
  WorkspaceId,
} from '../protocol/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import { Session } from '../session/index.js';
import type { SessionEvent, SessionUsage } from '../session/index.js';
import { InteractiveRuntime } from './interactive-runtime.js';
import type { CliSession } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import {
  persistableDraft,
  ThreadPresentationStore,
} from './presentation-state.js';
import {
  approvalDecisionForKey,
  createTuiScreen,
  formatContextUsage,
  formatTokenCount,
  formatWorkspacePath,
  matchingSlashCommands,
  parseGitStatusOutput,
  runTuiController,
  sanitizeTerminalText,
  sanitizeTerminalTitle,
  TuiInteractionState,
  tuiCanAbort,
  tuiEnterState,
} from './tui.js';
import type { TuiOptions, TuiScreen } from './tui.js';

const MODEL = { provider: 'openai', api: 'openai-chat', model: 'gpt-5.2' };
const WORKSPACE_SNAPSHOT = {
  workspaceId: 'ws_tui_test' as WorkspaceId,
  permissions: {
    mode: 'interactive',
    policyRevision: 'test-policy-v1',
    ceiling: { revision: 'test-ceiling-v1', constraints: [] },
  },
} as const satisfies WorkspaceRuntimeSnapshot;
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

type TestRenderer = Awaited<ReturnType<typeof createTestRenderer>>['renderer'];

function promptRuleIndexes(view: { renderer: TestRenderer }): [number, number] {
  const prompt = view.renderer.root.findDescendantById('coda-prompt-box');
  if (
    !(prompt instanceof BoxRenderable) ||
    !Array.isArray(prompt.border) ||
    !prompt.border.includes('top') ||
    !prompt.border.includes('bottom')
  ) {
    throw new Error('prompt box with horizontal rules not found');
  }
  return [prompt.screenY, prompt.screenY + prompt.height - 1];
}

function cursorFrameRow(view: { renderer: TestRenderer }): number {
  // CliRenderer 对外暴露的是终端的 1-based 光标行；captureCharFrame 是 0-based 行数组。
  return view.renderer.getCursorState().y - 1;
}

function frameLines(frame: string): string[] {
  const lines = frame.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

async function setup(
  width = 100,
  height = 30,
  onSubmit: () => void = () => {},
  color = true,
  modelOptions: {
    model?: typeof MODEL;
    contextLimit?: number;
  } = { model: MODEL, contextLimit: 128_000 },
  overrides: Partial<TuiOptions> = {},
): Promise<{
  screen: TuiScreen;
  flush: () => Promise<void>;
  frame: () => string;
  spans: Awaited<ReturnType<typeof createTestRenderer>>['captureSpans'];
  resize: (width: number, height: number) => void;
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>['mockInput'];
  mockMouse: Awaited<ReturnType<typeof createTestRenderer>>['mockMouse'];
  renderer: Awaited<ReturnType<typeof createTestRenderer>>['renderer'];
  interaction: TuiInteractionState;
  resolveHighlights: () => Promise<void>;
  destroyHighlighter: () => Promise<void>;
  destroy: () => Promise<void>;
}> {
  const testRenderer = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
    // 与生产配置一致；input 必须自行处理鼠标聚焦。
    autoFocus: false,
  });
  const treeSitterClient = new MockTreeSitterClient();
  const interaction = new TuiInteractionState();
  const screen = await createTuiScreen(testRenderer.renderer, {
    cwd: '/Users/test/work/coda',
    version: '0.0.1',
    color,
    ...(modelOptions.model !== undefined && { model: modelOptions.model }),
    ...(modelOptions.contextLimit !== undefined && {
      contextLimit: modelOptions.contextLimit,
    }),
    ...overrides,
    workspaceSnapshot: overrides.workspaceSnapshot ?? WORKSPACE_SNAPSHOT,
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
    mockMouse: testRenderer.mockMouse,
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

  it('git porcelain 同时投影 branch 与 dirty，detached HEAD 不伪造分支', () => {
    expect(parseGitStatusOutput('## main...origin/main [ahead 1]\n M src/a.ts\n')).toEqual({
      branch: 'main',
      dirty: true,
    });
    expect(parseGitStatusOutput('## No commits yet on feature\n')).toEqual({
      branch: 'feature',
      dirty: false,
    });
    expect(parseGitStatusOutput('## HEAD (no branch)\n?? scratch.txt\n')).toEqual({
      dirty: true,
    });
  });
});

describe('全屏 OpenTUI 布局', () => {
  it('顶部显示版本、像素 Logo 和 tips，底部固定 prompt 与三行状态', async () => {
    const view = await setup();
    try {
      await view.flush();
      const frame = view.frame();
      expect(frame).toContain('coda v0.0.1');
      expect(frame).toContain('▄█▄');
      expect(frame).toContain('Tips for getting started');
      expect(frame).not.toContain('Ask coda anything…');
      expect(frame).toContain('/Users/test/work/coda');
      expect(frame).toContain('context 0 / 128k · 0%');
      expect(frame).toContain('openai/gpt-5.2');
    } finally {
      await view.destroy();
    }
  });

  it('prompt 使用透明双横线、无侧边/圆角/标题，并显示高对比品牌色竖线光标', async () => {
    const view = await setup();
    try {
      view.screen.focusInput();
      await view.flush();
      const frame = view.frame();
      const lines = frameLines(frame);
      const [top, bottom] = promptRuleIndexes(view);

      expect(bottom - top).toBe(2);
      expect(lines[top]?.trim()).toMatch(/^─+$/);
      expect(lines[bottom]?.trim()).toMatch(/^─+$/);
      expect(lines.slice(top + 1, bottom).join('')).not.toMatch(/[│╭╮╰╯┌┐└┘]/);
      expect(frame).not.toContain('coda · ready');
      expect(frame).not.toContain('Enter send · Shift+Enter newline');

      for (const ruleRow of [top, bottom]) {
        const ruleSpans = view.spans().lines[ruleRow]?.spans.filter((span) =>
          span.text.includes('─'),
        );
        expect(ruleSpans?.length).toBeGreaterThan(0);
        for (const span of ruleSpans ?? []) {
          expect(span.fg.toInts()).toEqual([160, 32, 94, 255]);
          expect(span.bg.toInts()).toEqual([0, 0, 0, 0]);
        }
      }

      const input = view.renderer.root.findDescendantById('coda-input');
      expect(input).toBeInstanceOf(TextareaRenderable);
      if (!(input instanceof TextareaRenderable)) throw new Error('Textarea not found');
      expect(input.cursorColor.intent).toBe('rgb');
      expect(input.cursorColor.toInts()).toEqual([201, 71, 64, 255]);
      const cursor = view.renderer.getCursorState();
      expect(cursor).toMatchObject({
        visible: true,
        style: 'line',
        blinking: true,
      });
      expect(cursor.color.toInts()).toEqual([201, 71, 64, 255]);
    } finally {
      await view.destroy();
    }
  });

  it('斜杠命令以上拉列表显示，按前缀过滤并用 Tab 补全', async () => {
    const view = await setup(100, 24);
    try {
      view.screen.focusInput();
      await view.mockInput.typeText('/');
      await view.flush();

      const menu = view.renderer.root.findDescendantById('coda-slash-menu');
      const prompt = view.renderer.root.findDescendantById('coda-prompt-box');
      if (!(menu instanceof BoxRenderable) || !(prompt instanceof BoxRenderable)) {
        throw new Error('slash menu or prompt box not found');
      }
      expect(menu.visible).toBe(true);
      expect(menu.height).toBe(8);
      expect(menu.screenY + menu.height).toBe(prompt.screenY);
      expect(view.frame()).toContain('→ [help] /help');
      expect(view.frame()).toContain('/followup <text>');
      expect(view.frame()).not.toContain('/f <text>');
      expect(view.frame()).not.toContain('/q ');
      expect(view.frame()).toContain('Show model, usage, and token status');
      expect(view.frame()).toContain('Add or update provider API-key authentication');
      const selectedSpans = view.spans().lines[menu.screenY]?.spans.filter(
        (span) => span.text.trim() !== '',
      );
      expect(
        selectedSpans?.some(
          (span) =>
            span.text.includes('/help') &&
            span.fg.toInts().join(',') === '201,71,64,255',
        ),
      ).toBe(true);

      await view.mockInput.typeText('stat');
      await view.flush();
      expect(menu.height).toBeGreaterThanOrEqual(2);
      expect(view.frame()).toContain('→ [task] /status');
      expect(view.frame()).not.toContain('/queue');

      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('/status ');
      expect(menu.visible).toBe(false);

      view.screen.clearInput();
      await view.mockInput.typeText('/');
      view.mockInput.pressArrow('down');
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('/queue ');

      view.screen.clearInput();
      await view.mockInput.typeText('/');
      view.mockInput.pressEscape();
      await view.flush();
      expect(view.screen.getInput()).toBe('/');
      expect(menu.visible).toBe(false);
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('/help ');

      view.screen.clearInput();
      await view.mockInput.typeText('/f');
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('/followup ');

      view.screen.clearInput();
      await view.mockInput.typeText('/q');
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('/quit ');
    } finally {
      await view.destroy();
    }
  });

  it('provider 选项复用斜杠命令上拉列表，并用方向键选择', async () => {
    const view = await setup(100, 24);
    try {
      view.screen.focusInput();
      view.screen.setCommandPrompt('选择登录方式（Esc 退出）', false, [
        { value: 'OAuth', label: 'OAuth', description: '尚未实现' },
        {
          value: 'API key',
          label: 'API key',
          description: '使用 provider API key',
        },
      ]);
      await view.flush();

      const menu = view.renderer.root.findDescendantById('coda-slash-menu');
      const prompt = view.renderer.root.findDescendantById('coda-prompt-box');
      if (!(menu instanceof BoxRenderable) || !(prompt instanceof BoxRenderable)) {
        throw new Error('prompt menu or prompt box not found');
      }
      expect(menu.visible).toBe(true);
      expect(menu.height).toBe(2);
      expect(menu.screenY + menu.height).toBe(prompt.screenY);
      expect(view.frame()).toContain('→ OAuth');
      expect(view.frame()).toContain('尚未实现');
      expect(view.frame()).toContain('API key');
      expect(view.frame()).not.toContain('1. OAuth');
      expect(view.frame()).not.toContain('2. API key');
      expect(view.screen.getInput()).toBe('OAuth');

      view.mockInput.pressArrow('down');
      await view.flush();
      expect(view.frame()).toContain('→ API key');
      expect(view.screen.getInput()).toBe('API key');
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('API key');

      await view.mockInput.typeText('oau');
      await view.flush();
      expect(menu.height).toBe(1);
      expect(view.frame()).toContain('→ OAuth');
      expect(view.frame()).not.toContain('使用 provider API key');
      expect(view.screen.getInput()).toBe('OAuth');
    } finally {
      await view.destroy();
    }
  });

  it('候选打开时 Enter 先采用当前前缀候选再提交', async () => {
    let submissions = 0;
    const view = await setup(80, 24, () => {
      submissions++;
    });
    try {
      view.screen.focusInput();
      await view.mockInput.typeText('/he');
      view.mockInput.pressEnter();
      await view.flush();
      expect(submissions).toBe(1);
      expect(view.screen.getInput()).toBe('/help ');
      expect(view.frame()).not.toContain('Show shortcuts and slash commands');
    } finally {
      await view.destroy();
    }
  });

  it('鼠标点击失焦的 prompt 后重新聚焦并显示闪烁竖线光标', async () => {
    const view = await setup(80, 24);
    try {
      view.screen.setInput('click to focus');
      view.screen.focusInput();
      await view.flush();
      const input = view.renderer.root.findDescendantById('coda-input');
      expect(input).toBeInstanceOf(TextareaRenderable);
      if (!(input instanceof TextareaRenderable)) throw new Error('Textarea not found');

      input.blur();
      await view.flush();
      expect(input.focused).toBe(false);
      expect(view.renderer.getCursorState().visible).toBe(false);

      const clickX = input.screenX + 1;
      const clickY = input.screenY;
      await view.mockMouse.click(clickX, clickY, 0, { delayMs: 0 });
      await view.flush();

      expect(input.focused).toBe(true);
      expect(view.screen.getInput()).toBe('click to focus');
      const cursor = view.renderer.getCursorState();
      expect(cursor).toMatchObject({
        visible: true,
        style: 'line',
        blinking: true,
      });
      const [top, bottom] = promptRuleIndexes(view);
      expect(cursorFrameRow(view)).toBeGreaterThan(top);
      expect(cursorFrameRow(view)).toBeLessThan(bottom);
      const cursorColumn = cursor.x - 1;
      expect(cursorColumn).toBeGreaterThanOrEqual(input.screenX);
      expect(cursorColumn).toBeLessThan(input.screenX + input.width);
    } finally {
      await view.destroy();
    }
  });

  it('prompt 默认一行，随显式/软换行增高，并在内容变短或终端变宽时缩回', async () => {
    const view = await setup(100, 24);
    try {
      view.screen.focusInput();
      await view.flush();
      expect(promptRuleIndexes(view)[1] - promptRuleIndexes(view)[0]).toBe(2);

      await view.mockInput.typeText('first');
      view.mockInput.pressEnter({ shift: true });
      await view.mockInput.typeText('second');
      await view.flush();
      expect(view.screen.getInput()).toBe('first\nsecond');
      expect(promptRuleIndexes(view)[1] - promptRuleIndexes(view)[0]).toBe(3);

      view.screen.clearInput();
      await view.flush();
      expect(promptRuleIndexes(view)[1] - promptRuleIndexes(view)[0]).toBe(2);

      const softWrapped =
        'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi';
      await view.mockInput.typeText(softWrapped);
      await view.flush();
      expect(promptRuleIndexes(view)[1] - promptRuleIndexes(view)[0]).toBe(2);
      expect(view.frame()).not.toContain('Tips for getting started');
      expect(view.frame()).not.toContain('▄█▄');

      view.resize(54, 24);
      await view.flush();
      const narrowFrame = view.frame();
      const [narrowTop, narrowBottom] = promptRuleIndexes(view);
      const narrowLines = frameLines(narrowFrame);
      expect(narrowBottom - narrowTop).toBe(3);
      expect(narrowBottom).toBe(narrowLines.length - 4);
      expect(narrowLines[narrowBottom + 1]).toContain('idle');
      expect(narrowLines[narrowBottom + 2]).toContain('/Users/test/work/coda');
      expect(narrowLines[narrowBottom + 3]).toContain('context 0 / 128k');
      expect(narrowFrame).not.toContain('Tips for getting started');
      expect(narrowFrame).not.toContain('▄█▄');

      view.resize(100, 24);
      await view.flush();
      const wideFrame = view.frame();
      const [wideTop, wideBottom] = promptRuleIndexes(view);
      const wideLines = frameLines(wideFrame);
      expect(wideBottom - wideTop).toBe(2);
      expect(wideBottom).toBe(view.spans().lines.length - 4);
      expect(wideLines[wideBottom + 1]).toContain('idle');
      expect(wideLines[wideBottom + 2]).toContain('/Users/test/work/coda');
      expect(wideLines[wideBottom + 3]).toContain('context 0 / 128k');
      expect(wideFrame).not.toContain('Tips for getting started');
      expect(wideFrame).not.toContain('▄█▄');

      view.screen.println('output remains visible');
      view.screen.setInput(Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
      await view.flush();
      const cappedFrame = view.frame();
      const [cappedTop, cappedBottom] = promptRuleIndexes(view);
      const cappedLines = frameLines(cappedFrame);
      expect(cappedBottom - cappedTop).toBe(9);
      expect(cappedBottom).toBe(view.spans().lines.length - 4);
      expect(cappedLines[cappedBottom + 1]).toContain('idle');
      expect(cappedLines[cappedBottom + 2]).toContain('/Users/test/work/coda');
      expect(cappedLines[cappedBottom + 3]).toContain('context 0 / 128k');
      expect(cappedFrame).toContain('output remains visible');
      expect(cappedFrame).toContain('line 11');
      expect(cappedFrame).not.toContain('line 0');

      const input = view.renderer.root.findDescendantById('coda-input');
      expect(input).toBeInstanceOf(TextareaRenderable);
      if (!(input instanceof TextareaRenderable)) throw new Error('Textarea not found');
      expect(input.height).toBe(8);
      expect(input.scrollY).toBeGreaterThan(0);
      const cursor = view.renderer.getCursorState();
      expect(cursor.visible).toBe(true);
      expect(cursorFrameRow(view)).toBeGreaterThan(cappedTop);
      expect(cursorFrameRow(view)).toBeLessThan(cappedBottom);
    } finally {
      await view.destroy();
    }
  });

  it('整棵视图树与动态内容保持 alpha=0，NO_COLOR 也不恢复实色背景', async () => {
    for (const color of [true, false]) {
      const view = await setup(100, 50, () => {}, color);
      try {
        view.screen.focusInput();
        view.screen.setInput('terminal foreground');
        view.screen.render({
          type: 'message_start',
          message: user('inspect transparent rendering'),
        });
        view.screen.render({ type: 'message_start', message: assistant() });
        view.screen.render({
          type: 'message_end',
          message: assistant({
            content: [
              {
                type: 'text',
                text:
                  '# Transparent\n\n> quote\n\n' +
                  '| key | value |\n| --- | --- |\n| alpha | zero |\n\n' +
                  '```ts\nconst alpha = 0;\n```',
              },
            ],
          }),
        });
        view.screen.render({
          type: 'approval_request',
          approvalId: 'approval-transparent',
          toolCallId: 'call-transparent',
          description: 'verify transparent background',
        });
        await view.flush();
        await view.resolveHighlights();

        for (const id of [
          'coda-page',
          'coda-header',
          'coda-brand',
          'coda-logo',
          'coda-brand-copy',
          'coda-tips',
          'coda-tips-title',
          'coda-tips-body',
          'coda-transcript',
          'coda-composer',
          'coda-slash-menu',
          'coda-slash-row-0',
          'coda-slash-prefix-0',
          'coda-slash-command-0',
          'coda-slash-description-0',
          'coda-prompt-box',
          'coda-input',
          'coda-workspace',
          'coda-runtime-row',
          'coda-context',
          'coda-model',
        ]) {
          const renderable = view.renderer.root.findDescendantById(id);
          const transparent =
            renderable !== undefined && 'backgroundColor' in renderable
              ? renderable.backgroundColor
              : renderable !== undefined && 'bg' in renderable
                ? renderable.bg
                : undefined;
          if (!(transparent instanceof RGBA)) {
            throw new Error(`${id} does not expose a background color`);
          }
          expect(transparent.toInts()).toEqual([0, 0, 0, 0]);
        }

        const transcript = view.renderer.root.findDescendantById('coda-transcript');
        if (!(transcript instanceof ScrollBoxRenderable)) {
          throw new Error('transcript ScrollBox not found');
        }
        for (const layer of [
          transcript.wrapper,
          transcript.viewport,
          transcript.content,
        ]) {
          expect(layer.backgroundColor.toInts()).toEqual([0, 0, 0, 0]);
        }

        const allSpans = view.spans().lines.flatMap((line) => line.spans);
        expect(allSpans.length).toBeGreaterThan(0);
        for (const span of allSpans) {
          expect(span.bg.toInts()).toEqual([0, 0, 0, 0]);
        }

        const input = view.renderer.root.findDescendantById('coda-input');
        if (!(input instanceof TextareaRenderable)) {
          throw new Error('prompt Textarea not found');
        }
        expect(input.textColor.intent).toBe('default');
        expect(input.cursorColor.intent).toBe('rgb');
        expect(input.cursorColor.toInts()).toEqual([201, 71, 64, 255]);
        expect(view.renderer.getCursorState().color.toInts()).toEqual([
          201,
          71,
          64,
          255,
        ]);
        const [promptTop, promptBottom] = promptRuleIndexes(view);
        const inputSpans = view.spans().lines
          .slice(promptTop + 1, promptBottom)
          .flatMap((line) => line.spans)
          .filter((span) => span.text.trim() !== '');
        expect(inputSpans.some((span) => span.text.includes('terminal foreground'))).toBe(true);
        for (const span of inputSpans) {
          expect(span.fg.intent).toBe('default');
        }

        if (!color) {
          for (const span of allSpans.filter((candidate) => candidate.text.trim() !== '')) {
            expect(
              span.fg.intent,
              `NO_COLOR span ${JSON.stringify(span.text)} used ${span.fg.toString()}`,
            ).toBe('default');
          }
        }
      } finally {
        await view.destroy();
      }
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

      const lines = frameLines(view.frame());
      const headerBottom = lines.findIndex((line) => line.startsWith('└'));
      const userRow = lines.findIndex((line) => line.trim() === 'you');
      const assistantRow = lines.findIndex((line) => line.includes('I will start at the top'));
      const workspaceRow = lines.findIndex((line) => line.includes('/Users/test/work/coda'));

      expect(headerBottom).toBeGreaterThanOrEqual(0);
      expect(userRow).toBeGreaterThan(headerBottom);
      expect(userRow - headerBottom).toBeLessThanOrEqual(3);
      expect(assistantRow).toBeGreaterThan(userRow);
      expect(assistantRow).toBeLessThan(workspaceRow);
      expect(workspaceRow - assistantRow).toBeGreaterThan(5);
    } finally {
      await view.destroy();
    }
  });

  it('手动上滚后动态增高 prompt 不抢回跟尾，向下滚动可回到最新输出', async () => {
    const view = await setup(80, 20);
    try {
      view.screen.focusInput();
      for (let index = 0; index < 20; index++) {
        view.screen.println(`row-${String(index).padStart(2, '0')}`);
      }
      await view.flush();
      expect(view.frame()).toContain('row-19');

      view.screen.scrollPage(-1);
      await view.flush();
      const scrolledFrame = view.frame();
      expect(scrolledFrame).toMatch(/row-(?:0\d|1[0-8])/);
      expect(scrolledFrame).not.toContain('row-19');

      view.screen.setInput('one\ntwo\nthree\nfour');
      view.screen.println('row-20');
      await view.flush();
      const heldFrame = view.frame();
      expect(heldFrame).toMatch(/row-(?:0\d|1\d)/);
      expect(heldFrame).not.toContain('row-20');

      for (let index = 0; index < 10; index++) view.screen.scrollPage(1);
      await view.flush();
      const latestFrame = view.frame();
      const [, promptBottom] = promptRuleIndexes(view);
      expect(latestFrame).toContain('row-20');
      expect(promptBottom).toBe(view.spans().lines.length - 4);
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
      const [, promptBottom] = promptRuleIndexes(view);
      const lines = frameLines(frame);
      expect(promptRuleIndexes(view)[1] - promptRuleIndexes(view)[0]).toBe(2);
      expect(promptBottom).toBe(lines.length - 4);
      expect(lines[promptBottom + 1]).toContain('idle');
      expect(lines[promptBottom + 2]).toContain('/Users/test/work/coda');
      expect(lines[promptBottom + 3]).toContain('context 0 / 128k');
      expect(frame).toContain('context 0 / 128k');
    } finally {
      await view.destroy();
    }
  });

  it('ultra-compact 高度逐级隐藏装饰，光标不越界且审批优先可见', async () => {
    const longDraft = Array.from({ length: 12 }, (_, index) => `draft-${index}`).join('\n');
    for (const height of [9, 7, 5, 3, 2, 1]) {
      const view = await setup(54, height);
      try {
        view.screen.setInput(longDraft);
        view.screen.focusInput();
        await view.flush();
        const cursor = view.renderer.getCursorState();
        expect(cursor.visible).toBe(true);
        expect(cursor.y).toBeGreaterThanOrEqual(1);
        expect(cursor.y).toBeLessThanOrEqual(height);
        expect(view.screen.getInput()).toBe(longDraft);
        expect(view.frame()).toContain('draft-11');
        expect(view.frame()).not.toContain('coda v0.0.1');
        if (height >= 5) {
          expect(view.frame()).toContain('/Users/test/work/coda');
          expect(view.frame()).toContain('context 0 / 128k');
        }
      } finally {
        await view.destroy();
      }
    }

    const approvalView = await setup(54, 1);
    try {
      approvalView.screen.focusInput();
      approvalView.screen.setInput('draft');
      approvalView.screen.render({
        type: 'approval_request',
        approvalId: 'approval-tiny',
        toolCallId: 'call-tiny',
        description: 'run command',
      });
      await approvalView.flush();
      const approvalLines = frameLines(approvalView.frame());
      expect(approvalLines).toHaveLength(1);
      expect(approvalLines[0]?.trim()).toBe('Approval · y/a/n/Esc');
      expect(approvalView.renderer.getCursorState().visible).toBe(false);
      expect(approvalView.screen.getInput()).toBe('draft');
    } finally {
      await approvalView.destroy();
    }
  });

  it('审批在非空多行 draft 下仍显示持久键位，决议后恢复 workspace 与洋红横线', async () => {
    const view = await setup(60, 18);
    try {
      view.screen.focusInput();
      view.screen.setInput(
        Array.from({ length: 8 }, (_, index) => `draft ${index}`).join('\n'),
      );
      view.screen.render({
        type: 'approval_request',
        approvalId: 'approval-1',
        toolCallId: 'call-1',
        description: 'run bun test',
      });
      await view.flush();
      const approvalFrame = view.frame();
      const [approvalTop, approvalBottom] = promptRuleIndexes(view);
      const approvalLines = frameLines(approvalFrame);
      expect(approvalFrame).toContain('Approval · y/a/n/Esc');
      expect(approvalFrame).toContain('run bun test');
      expect(approvalFrame).toContain('draft 7');
      expect(approvalFrame).not.toContain('/Users/test/work/coda');
      expect(approvalLines.at(-2)).toContain('Approval · y/a/n/Esc');
      expect(approvalLines.at(-1)).toContain('context 0 / 128k');
      expect(view.renderer.getCursorState().visible).toBe(false);
      for (const ruleRow of [approvalTop, approvalBottom]) {
        const ruleSpans = view.spans().lines[ruleRow]?.spans.filter((span) =>
          span.text.includes('─'),
        );
        expect(ruleSpans?.length).toBeGreaterThan(0);
        for (const span of ruleSpans ?? []) {
          expect(span.fg.toInts()).toEqual([138, 90, 10, 255]);
          expect(span.bg.toInts()).toEqual([0, 0, 0, 0]);
        }
      }

      view.screen.resolveApproval();
      await view.flush();
      const resolvedFrame = view.frame();
      const [resolvedTop, resolvedBottom] = promptRuleIndexes(view);
      expect(resolvedFrame).not.toContain('Approval · y/a/n/Esc');
      expect(resolvedFrame).toContain('/Users/test/work/coda');
      expect(view.screen.getInput()).toContain('draft 7');
      expect(view.renderer.getCursorState().visible).toBe(true);
      for (const ruleRow of [resolvedTop, resolvedBottom]) {
        const ruleSpans = view.spans().lines[ruleRow]?.spans.filter((span) =>
          span.text.includes('─'),
        );
        expect(ruleSpans?.length).toBeGreaterThan(0);
        for (const span of ruleSpans ?? []) {
          expect(span.fg.toInts()).toEqual([160, 32, 94, 255]);
          expect(span.bg.toInts()).toEqual([0, 0, 0, 0]);
        }
      }
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

  it('秘密输入只在内存缓冲保存，任何 TUI 帧都只显示遮罩', async () => {
    const view = await setup();
    const secret = 'sk-never-render-this';
    try {
      view.screen.setCommandPrompt('API key（秘密输入）', true);
      view.screen.focusInput();
      await view.mockInput.typeText(secret);
      await view.flush();

      expect(view.screen.getInput()).toBe(secret);
      expect(view.frame()).not.toContain(secret);
      expect(view.frame()).toContain('•'.repeat(secret.length));

      view.screen.clearInput();
      view.screen.setCommandPrompt(undefined, false);
      await view.flush();
      expect(view.screen.getInput()).toBe('');
      expect(view.frame()).not.toContain(secret);
    } finally {
      await view.destroy();
    }
  });
});

describe('UX2 TUI presentation workflow', () => {
  it('第一次用户交互后收缩 header，持久状态不因非空 draft 消失', async () => {
    const view = await setup(100, 30, () => {}, true, undefined, {
      threadId: 'thr_1234567890abcdef',
      workspaceSnapshot: {
        ...WORKSPACE_SNAPSHOT,
        permissions: { ...WORKSPACE_SNAPSHOT.permissions, mode: 'deny' },
      },
      branch: 'main',
      gitDirty: true,
    });
    try {
      view.screen.setInput('a long working draft');
      await view.flush();
      expect(view.frame()).not.toContain('Tips for getting started');
      expect(view.frame()).not.toContain('▄█▄');
      expect(view.frame()).toContain('permissions deny');
      expect(view.frame()).toContain('queue 0/0');
      expect(view.frame()).toContain('(main*)');

      view.screen.render({ type: 'message_start', message: user('first task') });
      view.screen.render({ type: 'agent_start', reason: 'prompt' });
      view.screen.render({
        type: 'queue_update',
        steering: [{ id: 's1', text: 'steer', kind: 'steering' }],
        followUp: [{ id: 'f1', text: 'later', kind: 'follow_up' }],
      });
      await view.flush();
      const frame = view.frame();
      expect(frame).not.toContain('Tips for getting started');
      expect(frame).not.toContain('▄█▄');
      expect(frame).toContain('running:working');
      expect(frame).toContain('queue 1/1');
      expect(frame).toContain('…7890abcdef');
      expect(frame).toContain('openai/gpt-5.2');
      expect(frame).toContain('a long working draft');
    } finally {
      await view.destroy();
    }
  });

  it('palette 显示分类、模糊命中、参数/快捷键和 disabled 原因', async () => {
    const view = await setup(100, 24);
    try {
      view.screen.focusInput();
      view.screen.openCommandPalette();
      await view.mockInput.typeText('srch');
      await view.flush();
      const frame = view.frame();
      expect(frame).toContain('[review] /search <query>');
      expect(frame).toContain('Ctrl+F');
      expect(frame).toContain('unavailable: the transcr');

      view.screen.render({ type: 'message_start', message: user('searchable text') });
      view.screen.openCommandPalette();
      await view.mockInput.typeText('srch');
      await view.flush();
      expect(view.frame()).not.toContain('unavailable: the transcr');
    } finally {
      await view.destroy();
    }
  });

  it('@ completion includes files/directories and inserts the selected workspace path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-completion-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'feature.ts'), 'export {};\n');
    const view = await setup(100, 24, () => {}, true, undefined, { cwd: root });
    try {
      view.screen.focusInput();
      view.screen.setInput('inspect @src/fe');
      await view.flush();
      expect(view.frame()).toContain('@src/feature.ts');
      expect(view.frame()).toContain('@src/feature/');
      view.mockInput.pressTab();
      await view.flush();
      expect(view.screen.getInput()).toBe('inspect @src/feature/');
    } finally {
      await view.destroy();
    }
  });

  it('手动上滚后累积 unread，不抢滚动；搜索和 latest 恢复可见位置', async () => {
    let highWater = 10;
    const view = await setup(80, 20, () => {}, true, undefined, {
      eventHighWaterSeq: () => highWater,
    });
    try {
      for (let index = 0; index < 24; index++) view.screen.println(`row-${index}`);
      await view.flush();
      for (let index = 0; index < 4; index++) view.screen.scrollPage(-1);
      await view.flush();
      const held = view.frame();
      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      const heldTop = transcript.scrollTop;

      highWater++;
      view.screen.render({ type: 'message_start', message: user('new output') });
      await view.flush();
      expect(view.frame()).toContain('1 new');
      expect(view.frame()).not.toContain('new output');
      expect(transcript.scrollTop).toBe(heldTop);
      expect(view.frame()).toContain(held.split('\n').find((line) => line.includes('row-'))?.trim() ?? 'row-');

      expect(view.screen.searchTranscript('row-3')).toBe(true);
      await view.flush();
      expect(view.frame()).toContain('match 1/');
      view.screen.jumpToLatest();
      await view.flush();
      expect(view.frame()).toContain('new output');
      expect(view.frame()).not.toContain('1 new');

      const beforeWheel = transcript.scrollTop;
      for (let index = 0; index < 4; index++) {
        await view.mockMouse.scroll(
          transcript.screenX + 1,
          transcript.screenY + 1,
          'up',
          { delayMs: 0 },
        );
      }
      await view.flush();
      const wheelTop = transcript.scrollTop;
      expect(wheelTop).toBeLessThan(beforeWheel);
      highWater++;
      view.screen.render({
        type: 'message_start',
        message: { ...user('mouse wheel output'), id: 'u-wheel' },
      });
      await view.flush();
      expect(view.frame()).toContain('1 new');
      expect(view.frame()).not.toContain('mouse wheel output');
      expect(transcript.scrollTop).toBe(wheelTop);
    } finally {
      await view.destroy();
    }
  });

  it('resize 与重新打开同一 thread 都按稳定 message anchor 恢复 draft/滚动', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-anchor-state-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_tui_anchor' as WorkspaceId,
      threadId: 'thr_tui_anchor' as ThreadId,
    });
    store.setDraft(persistableDraft('draft survives reopen'));
    store.flush();
    const messages = Array.from({ length: 30 }, (_, index): UserMessage => ({
      ...user(`anchored row ${index}`),
      id: `u-anchor-${index}`,
    }));
    const first = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 30,
    });
    try {
      first.screen.replayTranscript(messages);
      await first.flush();
      for (let index = 0; index < 10; index++) first.screen.scrollPage(-1);
      await first.flush();
      store.flush();
      const before = store.snapshot().scrollAnchor;
      expect(before?.blockKey).toStartWith('message:u-anchor-');

      first.resize(54, 20);
      await first.flush();
      expect(first.frame()).toContain('anchored row');
      expect(store.snapshot().scrollAnchor?.blockKey).toBe(before?.blockKey);
    } finally {
      await first.destroy();
    }

    const reopened = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 30,
    });
    try {
      reopened.screen.replayTranscript(messages);
      reopened.screen.restorePresentation(store.snapshot());
      await reopened.flush();
      expect(reopened.screen.getInput()).toBe('draft survives reopen');
      const anchorId = store.snapshot().scrollAnchor?.blockKey.split(':')[1];
      const anchorIndex = anchorId?.split('-').at(-1);
      expect(reopened.frame()).toContain(`anchored row ${anchorIndex}`);
      expect(reopened.frame()).not.toContain('anchored row 29');
    } finally {
      await reopened.destroy();
      store.dispose();
    }
  });

  it('secret buffer never reaches presentation callbacks and optional Vim mode is modal', async () => {
    const captured: string[] = [];
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-secret-state-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_tui_secret' as WorkspaceId,
      threadId: 'thr_tui_secret' as ThreadId,
    });
    const view = await setup(80, 24, () => {}, true, undefined, {
      presentation: { store },
    });
    try {
      view.screen.focusInput();
      view.screen.setInputChangeHandler((draft) => {
        captured.push(draft);
        store.setDraft(persistableDraft(draft));
      });
      await view.mockInput.typeText('public draft');
      view.screen.setCommandPrompt('API key', true);
      view.screen.setInput('sk-never-persist');
      await view.flush();
      expect(captured.join('\n')).toContain('public draft');
      expect(captured.join('\n')).not.toContain('sk-never-persist');
      store.flush();
      expect(store.snapshot().draft).toBe('public draft');

      view.screen.setCommandPrompt(undefined, false);
      view.screen.setVimEnabled(true);
      view.screen.setInput('abc');
      await view.mockInput.typeText('hxiZ');
      await view.flush();
      expect(view.screen.getInput()).toBe('abZ');
      expect(view.frame()).toContain('VIM INSERT');
    } finally {
      await view.destroy();
      store.dispose();
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
      '\x1b_APC_SECRET\x1b\\' +
      '\x1b^PM_SECRET\x1b\\' +
      '\x1bXSOS_SECRET\x1b\\' +
      '\x9d52;c;C1_OSC_SECRET\x9c' +
      '\x90C1_DCS_SECRET\x9c' +
      '\x9fC1_APC_SECRET\x9c' +
      '\x9eC1_PM_SECRET\x9c' +
      '\x98C1_SOS_SECRET\x9c' +
      '\x00\x08\x0b\x7f\x9f';
    const clean = sanitizeTerminalText(raw);

    expect(clean).toBe('甲\t乙\nred');
    expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(sanitizeTerminalText(clean)).toBe(clean);
  });

  it('terminal title 额外折叠 tab/newline，不能把模型名写成多行控制输出', () => {
    const title = sanitizeTerminalTitle(
      ' coda · model\tvariant\nnext\x1b]0;INJECTED\x07 ',
    );
    expect(title).toBe('coda · model variant next');
    expect(title).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
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
  it('命令模糊匹配只返回当前 phase 可执行项，并保留 canonical 排序', () => {
    expect(matchingSlashCommands('/ST', 'idle').map((command) => command.name)[0]).toBe(
      'status',
    );
    const running = matchingSlashCommands('/', 'running').map((command) => command.name);
    expect(running).toContain('followup');
    expect(running).toContain('status');
    expect(running).toContain('search');
    expect(running).not.toContain('quit');
    expect(matchingSlashCommands('/f', 'idle').map((command) => command.name)[0]).toBe(
      'followup',
    );
    expect(matchingSlashCommands('/status ', 'idle')).toEqual([]);
    expect(matchingSlashCommands('ask /status', 'idle')).toEqual([]);
  });

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
      expect(view.frame()).not.toContain('coda · ready');

      view.screen.render({ type: 'compaction_start', reason: 'threshold' });
      await view.flush();
      expect(view.interaction.phase).toBe('compacting');
      expect(tuiEnterState(view.interaction.phase)).toBe('idle');
      expect(tuiCanAbort(view.interaction.phase)).toBe(true);
      expect(view.frame()).toContain('Compacting context · Enter queue');

      view.screen.render({ type: 'compaction_end', ok: false, droppedMessages: 0 });
      await view.flush();
      expect(view.interaction.phase).toBe('idle');
      expect(view.frame()).not.toContain('Compacting context · Enter queue');
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
  it('Ctrl+K/Ctrl+R/Ctrl+O 与 stash/restore 共用 per-thread presentation state', async () => {
    const dir = makeTempDir();
    const store = new ThreadPresentationStore({
      root: path.join(dir, 'presentation'),
      workspaceId: 'ws_tui_controller' as WorkspaceId,
      threadId: 'thr_tui_controller' as ThreadId,
    });
    store.setDraft(persistableDraft('restored controller draft'));
    store.flush();
    const prompts: string[] = [];
    const session: CliSession = {
      interactionState: () => 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      prompt: async (text) => { prompts.push(text); },
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const view = await setup(100, 24, () => {}, true, undefined, {
      cwd: dir,
      presentation: { store },
    });
    view.screen.restorePresentation(store.snapshot());
    view.screen.focusInput();
    let resolvePaletteEdit!: (value: string) => void;
    const pendingPaletteEdit = new Promise<string>((resolve) => {
      resolvePaletteEdit = resolve;
    });
    let editCalls = 0;
    const controller = runTuiController(session, undefined, view.screen, view.renderer, {
      interaction: view.interaction,
      cwd: dir,
      presentation: {
        store,
        editDraft: async (draft) => {
          editCalls++;
          return editCalls === 1 ? pendingPaletteEdit : `${draft}\nedited`;
        },
      },
      installSignalHandlers: false,
    });

    expect(view.screen.getInput()).toBe('restored controller draft');
    view.screen.clearInput();
    await view.mockInput.typeText('first prompt');
    view.mockInput.pressEnter();
    await view.mockInput.typeText('second prompt');
    view.mockInput.pressEnter();
    view.mockInput.pressKey('r', { ctrl: true });
    expect(view.screen.getInput()).toBe('second prompt');

    view.screen.clearInput();
    await view.mockInput.typeText('palette survives');
    view.mockInput.pressKey('k', { ctrl: true });
    await view.mockInput.typeText('help');
    view.mockInput.pressEnter();
    expect(view.screen.getInput()).toBe('palette survives');

    view.mockInput.pressKey('k', { ctrl: true });
    await view.mockInput.typeText('edit');
    view.mockInput.pressEnter();
    expect(view.screen.getInput()).toBe('palette survives');
    expect(store.snapshot().draft).toBe('palette survives');
    resolvePaletteEdit('palette survives\npalette edited');
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(view.screen.getInput()).toBe('palette survives\npalette edited');

    view.mockInput.pressKey('o', { ctrl: true });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(view.screen.getInput()).toBe('palette survives\npalette edited\nedited');
    view.mockInput.pressKey('s', { meta: true });
    expect(store.snapshot().stashedDraft).toBe('palette survives\npalette edited\nedited');
    await view.mockInput.typeText('/restore');
    view.mockInput.pressEnter();
    expect(view.screen.getInput()).toBe('palette survives\npalette edited\nedited');

    view.screen.clearInput();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    expect(prompts).toEqual(['first prompt', 'second prompt']);
    await view.destroyHighlighter();
  });

  it('stash 持久化失败时保留 composer，并让退出返回非零', async () => {
    const dir = makeTempDir();
    const blockedRoot = path.join(dir, 'not-a-directory');
    writeFileSync(blockedRoot, 'blocked');
    const store = new ThreadPresentationStore({
      root: blockedRoot,
      workspaceId: 'ws_tui_stash_failure' as WorkspaceId,
      threadId: 'thr_tui_stash_failure' as ThreadId,
    });
    const session: CliSession = {
      interactionState: () => 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const view = await setup(80, 20, () => {}, true, undefined, {
      presentation: { store },
    });
    view.screen.focusInput();
    const controller = runTuiController(session, undefined, view.screen, view.renderer, {
      interaction: view.interaction,
      presentation: { store },
      installSignalHandlers: false,
    });

    await view.mockInput.typeText('draft must remain visible');
    view.mockInput.pressKey('s', { meta: true });
    await view.flush();
    expect(view.screen.getInput()).toBe('draft must remain visible');
    expect(store.snapshot().draft).toBe('draft must remain visible');
    expect(view.frame()).toContain('stash failed');
    expect(view.frame()).not.toContain('Draft stashed for this thread.');

    view.mockInput.pressKey('k', { ctrl: true });
    await view.mockInput.typeText('quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(1);
    await view.destroyHighlighter();
  });

  it('项目规则 warning 经 TUI 单写入者清洗展示，并在关闭后退订', async () => {
    const session = await Session.create({
      dir: makeTempDir(),
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: { ref: MODEL },
        tools: [],
        systemPrompt: 'test',
      },
    });
    const view = await setup(80, 20);
    view.screen.focusInput();
    const println = view.screen.println.bind(view.screen);
    let replayFailureIsolated = false;
    view.screen.println = (text, tone) => {
      if (!replayFailureIsolated && text.includes('REPLAY_WARNING')) {
        replayFailureIsolated = true;
        throw new Error('view not ready');
      }
      println(text, tone);
    };
    let warningListener: ((message: string) => void) | undefined;
    let unsubscribed = false;
    const controller = runTuiController(
      session,
      undefined,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        installSignalHandlers: false,
        projectRuleWarnings: {
          subscribeWarnings(listener) {
            warningListener = listener;
            listener('REPLAY_WARNING');
            return () => {
              unsubscribed = true;
              warningListener = undefined;
            };
          },
        },
      },
    );

    expect(replayFailureIsolated).toBe(true);
    warningListener?.('unsafe\x1b]52;c;clipboard\x07\nSAFE_WARNING');
    await view.flush();
    expect(view.frame()).toContain('SAFE_WARNING');
    expect(view.frame()).not.toContain('clipboard');

    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    expect(unsubscribed).toBe(true);
    await view.destroyHighlighter();
  });

  it('冷启动复用 provider 状态机；palette/普通字段不污染任务 draft，秘密始终掩码', async () => {
    const dir = makeTempDir();
    const taskDraft = 'keep this task draft';
    const store = new ThreadPresentationStore({
      root: path.join(dir, 'presentation'),
      workspaceId: 'ws_tui_provider' as WorkspaceId,
      threadId: 'thr_tui_provider' as ThreadId,
    });
    store.setDraft(persistableDraft(taskDraft));
    store.flush();
    const registry = new ProviderRegistry({
      configPath: path.join(dir, 'providers.json'),
      credentialsPath: path.join(dir, 'credentials.json'),
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'kimi-k3' },
              { id: 'minimax-m3' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    let createCalls = 0;
    const runtime = new InteractiveRuntime({
      createSession: async () => {
        createCalls++;
        throw new Error('/login 不得创建 Session');
      },
    });
    const view = await setup(80, 24, () => {}, true, {}, {
      presentation: { store },
    });
    view.screen.restorePresentation(store.snapshot());
    view.screen.focusInput();
    const controller = runTuiController(
      runtime,
      undefined,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        providerCommands: { registry, runtime },
        presentation: { store },
        installSignalHandlers: false,
      },
    );
    await view.flush();
    expect(view.frame()).toContain('no model selected');
    const waitForFrame = async (text: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await Promise.resolve();
        await view.flush();
        if (view.frame().includes(text)) return;
      }
      throw new Error(`TUI frame did not contain ${text}`);
    };
    const submitPalette = async (command: string, expected: string): Promise<void> => {
      view.mockInput.pressKey('k', { ctrl: true });
      await view.mockInput.typeText(command);
      view.mockInput.pressEnter();
      await waitForFrame(expected);
    };
    const waitForInput = async (expected: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await Promise.resolve();
        await view.flush();
        if (view.screen.getInput() === expected) return;
      }
      throw new Error(`TUI input did not equal ${expected}`);
    };

    expect(view.screen.getInput()).toBe(taskDraft);
    await submitPalette('login', '[步骤 1]');
    expect(view.frame()).toContain('→ OpenCode Go');
    expect(view.frame()).toContain('OpenAI');
    expect(view.frame()).toContain('Anthropic');
    expect(view.frame()).toContain('Custom');
    expect(view.frame()).toContain('OAuth');
    expect(view.frame()).toContain('disabled');
    await view.mockInput.typeText('Custom');
    view.mockInput.pressEnter();
    await waitForFrame('[步骤 2] Custom provider name');
    await view.mockInput.typeText('Draft Safe Provider');
    view.mockInput.pressEnter();
    await waitForFrame('[步骤 3] base URL');
    expect(store.snapshot().draft).toBe(taskDraft);
    await view.mockInput.typeText('https://draft-safe.invalid/v1');
    view.mockInput.pressEnter();
    await waitForFrame('[步骤 4] API key');
    expect(store.snapshot().draft).toBe(taskDraft);
    view.mockInput.pressEscape();
    await waitForFrame('[步骤 3] base URL');
    view.mockInput.pressEscape();
    await waitForFrame('[步骤 2] Custom provider name');
    view.mockInput.pressEscape();
    await waitForFrame('[步骤 1]');
    view.mockInput.pressEscape();
    await waitForInput(taskDraft);
    expect(store.snapshot().draft).toBe(taskDraft);

    await submitPalette('login', '[步骤 1]');
    await view.mockInput.typeText('OAuth');
    view.mockInput.pressEnter();
    await waitForFrame('coming soon');
    await waitForInput(taskDraft);

    await submitPalette('login', '[步骤 1]');
    expect(view.frame()).toContain('→ OpenCode Go');
    expect(view.frame()).toContain('Custom');
    await view.mockInput.typeText('OpenCode Go');
    view.mockInput.pressEnter();
    await waitForFrame('[步骤 2] OpenCode Go API key');
    const backedOutSecret = 'sk-tui-back-never-render';
    await view.mockInput.typeText(backedOutSecret);
    view.mockInput.pressEscape();
    await waitForFrame('[步骤 1]');
    expect(view.frame()).not.toContain(backedOutSecret);
    expect(view.frame()).not.toContain('已取消');

    await view.mockInput.typeText('OpenCode Go');
    view.mockInput.pressEnter();
    await waitForFrame('[步骤 2] OpenCode Go API key');
    const secret = 'sk-tui-controller-never-render';
    await view.mockInput.typeText(secret);
    await view.flush();
    expect(view.screen.getInput()).toBe(secret);
    expect(view.frame()).not.toContain(secret);
    expect(view.frame()).toContain('•'.repeat(secret.length));

    view.mockInput.pressEnter();
    await waitForFrame('已保存 OpenCode Go 的认证配置');
    expect(view.frame()).not.toContain(secret);
    expect(createCalls).toBe(0);
    expect(runtime.currentModel()).toBeUndefined();
    await waitForInput(taskDraft);
    expect(store.snapshot().draft).toBe(taskDraft);

    await submitPalette('auth', '[authenticated] OpenCode Go');
    expect(view.screen.getInput()).toBe(taskDraft);
    await submitPalette('doctor', 'doctor: ready');
    expect(view.screen.getInput()).toBe(taskDraft);

    view.mockInput.pressKey('k', { ctrl: true });
    await view.mockInput.typeText('quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

  it('真实 PageUp/PageDown 按键滚动转录，消费事件且不夺走输入焦点', async () => {
    const session = await Session.create({
      dir: makeTempDir(),
      agentConfig: {
        streamFn: createFauxStreamFn({ turns: [] }),
        model: { ref: MODEL },
        tools: [],
        systemPrompt: 'test',
      },
    });
    const view = await setup(80, 20);
    view.screen.focusInput();
    const pageKeyEvents: KeyEvent[] = [];
    view.renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'pageup' || key.name === 'pagedown') pageKeyEvents.push(key);
    });
    const controller = runTuiController(
      session,
      undefined,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    view.screen.setInput('draft');
    for (let index = 0; index < 20; index++) {
      view.screen.println(`key-row-${String(index).padStart(2, '0')}`);
    }
    await view.flush();
    expect(view.frame()).toContain('key-row-19');

    await view.mockInput.pressKeys(['\x1b[5~']);
    await view.flush();
    const scrolledFrame = view.frame();
    expect(scrolledFrame).toMatch(/key-row-(?:0\d|1[0-8])/);
    expect(scrolledFrame).not.toContain('key-row-19');
    expect(view.screen.getInput()).toBe('draft');
    expect(view.renderer.getCursorState().visible).toBe(true);
    expect(pageKeyEvents).toHaveLength(1);
    expect(pageKeyEvents[0]).toMatchObject({
      name: 'pageup',
      defaultPrevented: true,
      propagationStopped: true,
    });

    view.screen.setInput('one\ntwo\nthree\nfour');
    view.screen.println('key-row-20');
    await view.mockInput.pressKeys(Array.from({ length: 10 }, () => '\x1b[6~'));
    await view.flush();
    expect(view.frame()).toContain('key-row-20');
    expect(view.screen.getInput()).toBe('one\ntwo\nthree\nfour');
    expect(view.renderer.getCursorState().visible).toBe(true);
    expect(pageKeyEvents).toHaveLength(11);
    for (const key of pageKeyEvents) {
      expect(key.defaultPrevented).toBe(true);
      expect(key.propagationStopped).toBe(true);
    }

    view.screen.clearInput();
    await view.mockInput.typeText('/st');
    view.mockInput.pressTab();
    await view.flush();
    expect(view.screen.getInput()).toBe('/status ');
    view.mockInput.pressEnter();
    await view.flush();
    expect(view.screen.getInput()).toBe('');
    expect(view.frame()).toContain('turns: 0');

    view.screen.clearInput();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

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
    expect(view.screen.getInput()).toBe('seed');
    expect(view.frame()).toContain(
      'Approval required · y once · a always · n deny · Esc abort',
    );

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

  it('canonical session approval_request enters TUI approval mode without a side channel', async () => {
    let listener: ((event: SessionEvent) => void | Promise<void>) | undefined;
    const resolutions: Array<{ id: string; decision: string }> = [];
    const session: CliSession = {
      interactionState: () => 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      prompt: async () => {},
      steer: () => {},
      followUp: () => {},
      abort: () => {},
      close: async () => {},
    };
    const approval = {
      broker: {
        resolve: (id: string, decision: 'allow_once' | 'allow_always' | 'deny' | 'abort') => {
          resolutions.push({ id, decision });
        },
      },
      onAbort: (): void => {},
      subscribe: (): (() => void) => () => {},
    };
    const view = await setup();
    view.screen.focusInput();
    const controller = runTuiController(
      session,
      approval,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    const emit = listener;
    if (emit === undefined) throw new Error('primary session listener was not registered');
    await emit({
      type: 'approval_request',
      approvalId: 'canonical-tui-approval',
      toolCallId: 'call-canonical',
      description: 'run canonical command',
    });
    await view.flush();
    expect(view.frame()).toContain('Approval required');

    view.mockInput.pressKey('y');
    expect(resolutions).toEqual([
      { id: 'canonical-tui-approval', decision: 'allow_once' },
    ]);

    view.screen.clearInput();
    view.screen.focusInput();
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
    expect(view.frame()).not.toContain('aborting…');

    await view.resolveHighlights();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });
});
