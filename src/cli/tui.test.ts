// OpenTUI 视图回归测试：用内存 TestRenderer 验证全屏分区、顶部向下的转录顺序、
// 固定底部状态、响应式降级与 Enter/Shift+Enter。无需真实 TTY 或网络。

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  BoxRenderable,
  type KeyEvent,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
  TextareaRenderable,
} from '@opentui/core';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentMessage,
  ApprovalPresentation,
  AssistantMessage,
  ProviderEvent,
  RunId,
  ThreadId,
  ToolResultMessage,
  UserMessage,
  WorkspaceRuntimeSnapshot,
  WorkspaceId,
} from '../protocol/index.js';
import type {
  CliControlActions,
  CliRuntimeEvent,
  CliThreadUsage,
} from './frontend-types.js';
import type { CliSession, InteractiveSession } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import type { RuntimeWorkspaceActions } from './runtime-frontend.js';
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
  resolveTuiTheme,
  runTuiController,
  sanitizeTerminalText,
  sanitizeTerminalTitle,
  TRANSCRIPT_REPLAY_CHUNK_MESSAGES,
  TuiInteractionState,
  tuiCanAbort,
  tuiEnterState,
} from './tui.js';
import type { TuiOptions, TuiScreen } from './tui.js';

const MODEL = { provider: 'openai', api: 'openai-chat', model: 'gpt-5.2' };
const RETRY_PREDECESSOR_RUN_ID = 'run-tui-predecessor' as RunId;
const RETRY_SUCCESSOR_RUN_ID = 'run-tui-successor' as RunId;
const COMPACTION_RUN_ID = 'run-tui-compaction' as RunId;
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

function idleCliSession(): CliSession {
  return {
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
  overrides: Partial<TuiOptions> & { workingAnimation?: boolean } = {},
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

describe('TUI themes', () => {
  it('provides distinct light, dark, high-contrast, and color-free mono palettes', () => {
    const light = resolveTuiTheme('light');
    const dark = resolveTuiTheme('dark');
    const highContrast = resolveTuiTheme('high-contrast');
    const mono = resolveTuiTheme('mono');
    expect(light.color).toBe(true);
    expect(dark.color).toBe(true);
    expect(highContrast.color).toBe(true);
    expect(light.palette.accent).not.toBe(dark.palette.accent);
    expect(light.palette.approvalSurface).not.toBe(dark.palette.approvalSurface);
    expect(highContrast.palette.border).toBe('#ffffff');
    expect(mono.color).toBe(false);
  });

  it('mono keeps explicit status words while every rendered text span uses terminal foreground', async () => {
    const view = await setup(80, 24, () => {}, true, undefined, { theme: 'mono' });
    try {
      view.screen.render({ type: 'error', fatal: true, message: 'provider failed' });
      await view.flush();
      expect(view.frame()).toContain('fatal');
      expect(view.frame()).toContain('provider failed');
      for (const row of view.spans().lines) {
        for (const span of row.spans) {
          if (span.text.trim() !== '') expect(span.fg.intent).toBe('default');
        }
      }
    } finally {
      await view.destroy();
    }
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

  it('除临时审批面板外保持透明背景，NO_COLOR 也移除审批表面色', async () => {
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
        view.screen.render(approvalControlRequest(
          'approval-transparent', 'verify transparent background', 'call-transparent',
        ));
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
          'coda-approval-footer',
          'coda-approval-hint',
          'coda-slash-menu',
          'coda-slash-row-0',
          'coda-slash-prefix-0',
          'coda-slash-command-0',
          'coda-slash-description-0',
          'coda-working',
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

        const approvalPanel = view.renderer.root.findDescendantById('coda-approval-panel');
        if (!(approvalPanel instanceof BoxRenderable)) {
          throw new Error('approval panel not found');
        }
        expect(approvalPanel.backgroundColor.toInts()).toEqual(
          color ? [244, 244, 245, 255] : [0, 0, 0, 0],
        );

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
        const userPrompt = transcript.content.getChildren().find((child) =>
          child instanceof BoxRenderable &&
          Array.isArray(child.border) &&
          child.border.includes('top') &&
          child.border.includes('bottom')
        );
        if (!(userPrompt instanceof BoxRenderable)) {
          throw new Error('user prompt with horizontal rules not found');
        }
        expect(userPrompt.backgroundColor.toInts()).toEqual([0, 0, 0, 0]);
        expect(userPrompt.borderColor.intent).toBe(color ? 'rgb' : 'default');
        if (color) expect(userPrompt.borderColor.toInts()).toEqual([160, 32, 94, 255]);

        const allSpans = view.spans().lines.flatMap((line) => line.spans);
        expect(allSpans.length).toBeGreaterThan(0);
        for (const span of allSpans) {
          expect([
            [0, 0, 0, 0],
            ...(color ? [[244, 244, 245, 255]] : []),
          ]).toContainEqual(span.bg.toInts());
        }

        view.screen.resolveApproval();
        await view.flush();

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
      const userRow = lines.findIndex((line) => line.includes('inspect the repository'));
      const assistantRow = lines.findIndex((line) => line.includes('I will start at the top'));
      const workspaceRow = lines.findIndex((line) => line.includes('/Users/test/work/coda'));
      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) {
        throw new Error('transcript ScrollBox not found');
      }
      const userPrompt = transcript.content.getChildren().find((child) =>
        child instanceof BoxRenderable &&
        Array.isArray(child.border) &&
        child.border.includes('top') &&
        child.border.includes('bottom')
      );
      if (!(userPrompt instanceof BoxRenderable)) {
        throw new Error('user prompt with horizontal rules not found');
      }

      expect(headerBottom).toBeGreaterThanOrEqual(0);
      expect(userRow).toBeGreaterThan(headerBottom);
      expect(userRow - headerBottom).toBeLessThanOrEqual(3);
      expect(userPrompt.screenY).toBe(userRow - 1);
      expect(userPrompt.screenY + userPrompt.height - 1).toBe(userRow + 1);
      expect(lines[userRow - 1]?.trim()).toMatch(/^─+$/);
      expect(lines[userRow + 1]?.trim()).toMatch(/^─+$/);
      expect(userPrompt.backgroundColor.toInts()).toEqual([0, 0, 0, 0]);
      expect(userPrompt.borderColor.toInts()).toEqual([160, 32, 94, 255]);
      expect(assistantRow).toBeGreaterThan(userRow);
      expect(assistantRow).toBeLessThan(workspaceRow);
      expect(workspaceRow - assistantRow).toBeGreaterThan(5);
      expect(lines.some((line) => line.trim() === 'you')).toBe(false);
      expect(lines.some((line) => line.trim() === 'coda')).toBe(false);
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
      const usage: CliThreadUsage = {
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

  it('ultra-compact 高度逐级隐藏装饰且普通输入光标不越界', async () => {
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
  });

  it('审批替换底部 composer 而不写入 transcript，决议后恢复 draft 与 workspace', async () => {
    const view = await setup(60, 18);
    try {
      view.screen.focusInput();
      view.screen.setInput(
        Array.from({ length: 8 }, (_, index) => `draft ${index}`).join('\n'),
      );
      view.screen.render(approvalControlRequest(
        'approval-1', 'bash: bun test — Run the test suite', 'call-1',
      ));
      await view.flush();
      const approvalFrame = view.frame();
      const approvalLines = frameLines(approvalFrame);
      const approvalPanel = view.renderer.root.findDescendantById('coda-approval-panel');
      const approvalFooter = view.renderer.root.findDescendantById('coda-approval-footer');
      if (!(approvalPanel instanceof BoxRenderable)) {
        throw new Error('approval panel not found');
      }
      if (!(approvalFooter instanceof BoxRenderable)) {
        throw new Error('approval footer not found');
      }
      expect(approvalPanel.visible).toBe(true);
      expect(approvalPanel.screenY + approvalPanel.height).toBe(approvalFooter.screenY);
      expect(approvalFooter.screenY + approvalFooter.height).toBe(approvalLines.length);
      expect(approvalFooter.backgroundColor.toInts()).toEqual([0, 0, 0, 0]);
      expect(approvalLines[approvalFooter.screenY - 1]?.trim()).toBe('');
      expect(approvalFrame).toContain('Would you like to allow the following action?');
      expect(approvalFrame).toContain('Environment: local');
      expect(approvalFrame).toContain('Reason: bash: bun test — Run the test suite');
      expect(approvalFrame).toContain('› 1. Yes, proceed (y)');
      expect(approvalFrame).toContain('Press enter to confirm or esc to cancel');
      expect(approvalFrame).not.toContain('draft 7');
      expect(approvalFrame).not.toContain('/Users/test/work/coda');
      expect(view.renderer.getCursorState().visible).toBe(false);

      view.resize(80, 30);
      view.screen.toggleApprovalDetails();
      await view.flush();
      expect(view.frame()).toContain('Details');
      expect(view.frame()).not.toContain('draft 7');

      view.screen.resolveApproval();
      await view.flush();
      const resolvedFrame = view.frame();
      const [resolvedTop, resolvedBottom] = promptRuleIndexes(view);
      expect(resolvedFrame).not.toContain('Would you like to run the following command?');
      expect(resolvedFrame).not.toContain('Run the test suite');
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

  it('矮窗口与多行审批内容始终让当前决议项可见', async () => {
    const view = await setup(40, 10);
    try {
      view.screen.render(approvalControlRequest(
        'approval-narrow',
        'bash: printf first\nprintf second\nprintf third\nprintf fourth — ' +
          'A long reason that wraps across several narrow terminal rows',
        'call-narrow',
      ));
      await view.flush();
      expect(view.frame()).toContain('› 1. Yes, proceed (y)');
      expect(view.frame()).toContain('Press enter to confirm or esc to');

      expect(view.screen.handleApprovalPanelKey({ name: 'down' } as KeyEvent))
        .toEqual({ kind: 'handled' });
      await view.flush();
      expect(view.frame()).toContain('› 2. No, and tell Coda what to do');
      expect(view.screen.handleApprovalPanelKey({ name: 'down' } as KeyEvent))
        .toEqual({ kind: 'handled' });
      await view.flush();
      expect(view.frame()).toContain('› 1. Yes, proceed (y)');
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

describe('TUI presentation workflow', () => {
  it('独立工具块恰隔一行，同一调用的结果与 diff 保持紧凑', async () => {
    const view = await setup(120, 55);
    try {
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'write-spacing',
        toolName: 'write',
        args: { path: 'src/a.ts' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'write-spacing',
        result: toolResult('write-spacing', 'write', 'written', {
          details: { diff: '+added\n-removed' },
        }),
      });
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'bash-spacing',
        toolName: 'bash',
        args: { command: 'echo next' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'bash-spacing',
        result: toolResult('bash-spacing', 'bash', 'next'),
      });
      await view.flush();

      const rows = frameLines(view.frame());
      const row = (fragment: string): number => {
        const index = rows.findIndex((line) => line.includes(fragment));
        if (index < 0) throw new Error(`missing ${fragment}`);
        return index;
      };
      const write = row('✓ write src/a.ts');
      const added = row('+added');
      const removed = row('-removed');
      const bash = row('• Ran echo next');
      expect(added).toBe(write + 1);
      expect(removed).toBe(added + 1);
      expect(rows[removed + 1]?.trim()).toBe('');
      expect(bash).toBe(removed + 2);
      expect(view.screen.searchTranscript('+added')).toBe(true);
    } finally {
      await view.destroy();
    }
  });

  it('连续 ls/glob/grep/read 显示为一个 Explored 块，并合并相邻 read', async () => {
    const view = await setup(160, 45);
    try {
      const calls = [
        ['read-1', 'read', { path: 'package.json' }],
        ['read-2', 'read', { path: 'package.json' }],
        ['read-3', 'read', { path: 'bun.lock' }],
        ['ls-1', 'ls', { path: 'docs' }],
        ['glob-1', 'glob', { pattern: '**/*.md', path: 'docs' }],
        ['grep-1', 'grep', { pattern: '^#{1,3}', path: '*.md' }],
      ] as const;
      for (const [toolCallId, toolName, args] of calls) {
        view.screen.render({ type: 'tool_execution_start', toolCallId, toolName, args });
        view.screen.render({
          type: 'tool_execution_end',
          toolCallId,
          result: toolResult(toolCallId, toolName, 'done'),
        });
      }
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'bun test' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'bash-1',
        result: toolResult('bash-1', 'bash', 'tests passed'),
      });
      await view.flush();

      const frame = view.frame();
      expect(frame).toContain('• Explored');
      expect(frame).toContain('└ Read package.json, bun.lock');
      expect(frame).toContain('List docs');
      expect(frame).toContain('List **/*.md in docs');
      expect(frame).toContain('Search ^#{1,3} in *.md');
      expect(frame.match(/Explored/gu)).toHaveLength(1);
      expect(frame).toContain('• Ran bun test');
      expect(frame).toContain('└ tests passed');
      expect(frame).not.toContain('● read package.json');
      expect(frame).not.toContain('✓ read');
    } finally {
      await view.destroy();
    }
  });

  it('探索失败在 live 与 replay 中都保留显式失败摘要', async () => {
    const view = await setup(100, 40);
    try {
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'missing-live',
        toolName: 'read',
        args: { path: 'missing-live.ts' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'missing-live',
        result: toolResult('missing-live', 'read', 'ENOENT live', { isError: true }),
      });
      await view.flush();
      expect(view.frame()).toContain('Explored · 1 failed');
      expect(view.frame()).toContain('✗ read missing-live.ts · ENOENT live');

      view.screen.resetTranscript([
        assistant({
          id: 'missing-replay-assistant',
          content: [{
            type: 'tool_call',
            id: 'missing-replay',
            name: 'read',
            arguments: { path: 'missing-replay.ts' },
          }],
          stopReason: 'tool_calls',
        }),
        toolResult('missing-replay', 'read', 'ENOENT replay', { isError: true }),
      ]);
      await view.flush();
      expect(view.frame()).toContain('Explored · 1 failed');
      expect(view.frame()).toContain('✗ Read missing-replay.ts · ENOENT replay');
    } finally {
      await view.destroy();
    }
  });

  it('bash 以紧凑 Ran 块续行命令，并保留输出首尾而折叠中段', async () => {
    const view = await setup(72, 45);
    try {
      const output = [
        'M docs/09-cli.md',
        'M docs/10-testing.md',
        ...Array.from({ length: 9 }, (_, index) => `middle ${index + 1}`),
        'src/cli/tui.ts',
        'src/cli/ux-characterization.test.ts',
        'exit code 0',
      ].join('\n');
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'bash-preview',
        toolName: 'bash',
        args: {
          command:
            'bun --no-env-file -e "import { mkdtempSync, rmSync } from \'node:fs\'; ' +
            'import os from \'node:os\'; import path from \'node:path\';"',
        },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'bash-preview',
        result: toolResult('bash-preview', 'bash', output),
      });
      await view.flush();

      const frame = view.frame();
      expect(frame).toContain('• Ran bun --no-env-file');
      expect(frame).toContain('│');
      expect(frame).toContain('└ M docs/09-cli.md');
      expect(frame).toContain('… +9 lines (use /review to view output)');
      expect(frame).toContain('src/cli/ux-characterization.test.ts');
      expect(frame).not.toContain('exit code 0');
    } finally {
      await view.destroy();
    }
  });

  it('mono bash 以显式文本区分成功与失败', async () => {
    const view = await setup(80, 30, () => {}, false);
    try {
      for (const [toolCallId, command, isError] of [
        ['bash-ok', 'true', false],
        ['bash-failed', 'false', true],
      ] as const) {
        view.screen.render({
          type: 'tool_execution_start',
          toolCallId,
          toolName: 'bash',
          args: { command },
        });
        view.screen.render({
          type: 'tool_execution_end',
          toolCallId,
          result: toolResult(toolCallId, 'bash', 'exit code 1', { isError }),
        });
      }
      await view.flush();

      expect(view.frame()).toContain('• Ran true');
      expect(view.frame()).toContain('[x] Ran false');
    } finally {
      await view.destroy();
    }
  });

  it('恢复转录沿用 Explored 分组，而不是回退成逐条工具结果', async () => {
    const view = await setup(160, 45);
    try {
      view.screen.replayTranscript([
        assistant({
          id: 'explore-history',
          content: [
            { type: 'tool_call', id: 'history-read-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'tool_call', id: 'history-read-2', name: 'read', arguments: { path: 'b.ts' } },
            { type: 'tool_call', id: 'history-ls', name: 'ls', arguments: { path: 'src' } },
            { type: 'tool_call', id: 'history-grep', name: 'grep', arguments: { pattern: 'TODO', path: 'src' } },
          ],
          stopReason: 'tool_calls',
        }),
        toolResult('history-read-1', 'read', 'first file'),
        toolResult('history-read-2', 'read', 'second file'),
        toolResult('history-ls', 'ls', 'directory'),
        toolResult('history-grep', 'grep', 'matches'),
      ]);
      await view.flush();

      const frame = view.frame();
      expect(frame).toContain('• Explored');
      expect(frame).toContain('└ Read a.ts, b.ts');
      expect(frame).toContain('List src');
      expect(frame).toContain('Search TODO in src');
      expect(frame.match(/Explored/gu)).toHaveLength(1);
      expect(frame).not.toContain('✓ read');
    } finally {
      await view.destroy();
    }
  });

  it('恢复时 tool-only assistant 不产生幽灵块，且探索不会跨 edit 合并', async () => {
    const view = await setup(120, 40);
    try {
      view.screen.replayTranscript([
        assistant({
          id: 'mixed-tools',
          content: [
            { type: 'tool_call', id: 'read-a', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'tool_call', id: 'edit-b', name: 'edit', arguments: { path: 'b.ts', edits: [{}] } },
            { type: 'tool_call', id: 'read-c', name: 'read', arguments: { path: 'c.ts' } },
          ],
          stopReason: 'tool_calls',
        }),
        toolResult('read-a', 'read', 'a'),
        toolResult('edit-b', 'edit', 'edited'),
        toolResult('read-c', 'read', 'c'),
      ]);
      await view.flush();

      const frame = view.frame();
      expect(frame.match(/Explored/gu)).toHaveLength(2);
      expect(frame).not.toContain('Read a.ts, c.ts');
      expect(frame.indexOf('Read a.ts')).toBeLessThan(frame.indexOf('✓ edit b.ts'));
      expect(frame.indexOf('✓ edit b.ts')).toBeLessThan(frame.indexOf('Read c.ts'));
      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      expect(transcript.content.getChildren()).toHaveLength(4); // replay banner + 3 tool blocks
    } finally {
      await view.destroy();
    }
  });

  it('恢复时已完成与未完成探索仍按声明顺序合并', async () => {
    const view = await setup(120, 30);
    try {
      view.screen.replayTranscript([
        assistant({
          id: 'partial-exploration',
          content: [
            { type: 'tool_call', id: 'read-complete', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'tool_call', id: 'read-pending', name: 'read', arguments: { path: 'b.ts' } },
          ],
          stopReason: 'tool_calls',
        }),
        toolResult('read-complete', 'read', 'a'),
      ]);
      await view.flush();

      const frame = view.frame();
      expect(frame).toContain('• Exploring');
      expect(frame).toContain('Read a.ts, b.ts');
      expect(frame).not.toContain('Read b.ts, a.ts');
    } finally {
      await view.destroy();
    }
  });

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

  it('每个独立 wheel-up 帧都持续上移，不从 maximum - 1 回弹到底部', async () => {
    const view = await setup(80, 20);
    try {
      view.screen.focusInput();
      view.screen.setInput('wheel events must not enter the composer');
      for (let index = 0; index < 30; index++) {
        view.screen.println(`single-wheel-row-${String(index).padStart(2, '0')}`);
      }
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      const initialTop = transcript.scrollTop;
      expect(initialTop).toBeGreaterThan(4);
      const eventTops: number[] = [];
      const frameTops: number[] = [];

      for (let index = 0; index < 4; index++) {
        await view.mockMouse.scroll(
          transcript.screenX + 1,
          transcript.screenY + 1,
          'up',
          { delayMs: 0 },
        );
        eventTops.push(transcript.scrollTop);
        await view.flush();
        frameTops.push(transcript.scrollTop);
      }

      const expectedTops = Array.from({ length: 4 }, (_, index) => initialTop - index - 1);
      expect({ eventTops, frameTops, input: view.screen.getInput() }).toEqual({
        eventTops: expectedTops,
        frameTops: expectedTops,
        input: 'wheel events must not enter the composer',
      });
    } finally {
      await view.destroy();
    }
  });

  it('queued Markdown 尚未布局时的 wheel no-op 不建立 manual anchor 或 unread', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-queued-wheel-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_queued_wheel' as WorkspaceId,
      threadId: 'thr_queued_wheel' as ThreadId,
    });
    let highWater = 20;
    const view = await setup(80, 20, () => {}, true, undefined, {
      presentation: { store },
      eventHighWaterSeq: () => highWater,
    });
    try {
      view.screen.focusInput();
      view.screen.setInput('queued wheel draft');
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      const streamingAssistant = assistant({ id: 'a-queued-wheel' });
      highWater++;
      view.screen.render({ type: 'message_start', message: streamingAssistant });
      highWater++;
      view.screen.render({
        type: 'message_update',
        messageId: streamingAssistant.id,
        event: {
          type: 'text_delta',
          contentIndex: 0,
          delta: Array.from({ length: 80 }, (_, index) => `queued-markdown-${index}`).join('\n'),
          partial: { ...streamingAssistant, content: [{ type: 'text', text: '' }] },
        },
      });

      const beforeWheel = transcript.scrollTop;
      await view.mockMouse.scroll(
        transcript.screenX + 1,
        transcript.screenY + 1,
        'up',
        { delayMs: 0 },
      );
      expect(transcript.scrollTop).toBe(beforeWheel);
      await view.flush();

      const stateAfterNoop = store.snapshot();
      const firstMaximum = Math.max(0, transcript.scrollHeight - transcript.viewport.height);
      const topAfterNoop = transcript.scrollTop;

      highWater++;
      view.screen.render({
        type: 'message_update',
        messageId: streamingAssistant.id,
        event: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '\nqueued-markdown-final',
          partial: { ...streamingAssistant, content: [{ type: 'text', text: '' }] },
        },
      });
      await view.flush();

      const stateAfterLiveOutput = store.snapshot();
      expect({
        stateAfterNoop: {
          scrollAnchor: stateAfterNoop.scrollAnchor,
          unreadAfterSeq: stateAfterNoop.unreadAfterSeq,
        },
        topAfterNoop,
        firstMaximum,
        stateAfterLiveOutput: {
          scrollAnchor: stateAfterLiveOutput.scrollAnchor,
          unreadAfterSeq: stateAfterLiveOutput.unreadAfterSeq,
        },
        topAfterLiveOutput: transcript.scrollTop,
        finalMaximum: Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        input: view.screen.getInput(),
      }).toEqual({
        stateAfterNoop: { scrollAnchor: undefined, unreadAfterSeq: 0 },
        topAfterNoop: firstMaximum,
        firstMaximum,
        stateAfterLiveOutput: { scrollAnchor: undefined, unreadAfterSeq: 0 },
        topAfterLiveOutput: Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        finalMaximum: Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        input: 'queued wheel draft',
      });
    } finally {
      await view.destroy();
      store.dispose();
    }
  });

  it('wheel-up 与下一帧之间到达的首批 live output 仍从上滚前累计 unread', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-wheel-frame-unread-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_wheel_frame_unread' as WorkspaceId,
      threadId: 'thr_wheel_frame_unread' as ThreadId,
    });
    let highWater = 40;
    const view = await setup(80, 20, () => {}, true, undefined, {
      presentation: { store },
      eventHighWaterSeq: () => highWater,
    });
    try {
      for (let index = 0; index < 30; index++) {
        view.screen.println(`wheel-frame-row-${String(index).padStart(2, '0')}`);
      }
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      const beforeWheel = transcript.scrollTop;
      await view.mockMouse.scroll(
        transcript.screenX + 1,
        transcript.screenY + 1,
        'up',
        { delayMs: 0 },
      );
      expect(transcript.scrollTop).toBe(beforeWheel - 1);

      // Runtime output can arrive after the physical wheel event but before Coda's frame callback
      // commits manual mode. It belongs to the unread interval started by that wheel event.
      highWater++;
      view.screen.render({
        type: 'message_start',
        message: { ...user('same-frame live output'), id: 'same-frame-live-output' },
      });
      await view.flush();

      expect({
        unreadAfterSeq: store.snapshot().unreadAfterSeq,
        heldAboveLatest: transcript.scrollTop <
          Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        frame: view.frame(),
      }).toEqual({
        unreadAfterSeq: 40,
        heldAboveLatest: true,
        frame: expect.stringContaining('1 new'),
      });
    } finally {
      await view.destroy();
      store.dispose();
    }
  });

  it('durable anchor 恢复与下一帧之间到达的 live output 不清 unread', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-restore-frame-unread-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_restore_frame_unread' as WorkspaceId,
      threadId: 'thr_restore_frame_unread' as ThreadId,
    });
    store.setScrollState({
      blockKey: 'message:restore-frame-20',
      logicalOffset: 0,
      fallbackBlockKeys: ['message:restore-frame-19'],
      observedHighWaterSeq: 40,
    }, 40);
    store.flush();
    const durableState = store.snapshot();
    let highWater = 41;
    const view = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => highWater,
    });
    try {
      const messages = Array.from({ length: 30 }, (_, index): UserMessage => ({
        ...user(`restore-frame-${String(index).padStart(2, '0')}`),
        id: `restore-frame-${index}`,
      }));
      view.screen.replayTranscript(messages);
      await view.flush();
      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');

      view.screen.restorePresentation(durableState);
      highWater++;
      view.screen.render({
        type: 'message_start',
        message: { ...user('restore same-frame output'), id: 'restore-same-frame-output' },
      });
      await view.flush();

      expect({
        unreadAfterSeq: store.snapshot().unreadAfterSeq,
        heldAboveLatest: transcript.scrollTop <
          Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        frame: view.frame(),
      }).toEqual({
        unreadAfterSeq: 40,
        heldAboveLatest: true,
        frame: expect.stringContaining('2 new'),
      });
    } finally {
      await view.destroy();
      store.dispose();
    }
  });

  it('manual live output 复用已提交锚点且不按 delta 重扫整棵 transcript', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-manual-live-anchor-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_manual_live_anchor' as WorkspaceId,
      threadId: 'thr_manual_live_anchor' as ThreadId,
    });
    const scrollWrites = spyOn(store, 'setScrollState');
    let highWater = 80;
    const view = await setup(80, 20, () => {}, true, undefined, {
      presentation: { store },
      eventHighWaterSeq: () => highWater,
    });
    try {
      const messages = Array.from({ length: 30 }, (_, index): UserMessage => ({
        ...user(`manual-live-${String(index).padStart(2, '0')}`),
        id: `manual-live-${index}`,
      }));
      view.screen.replayTranscript(messages);
      await view.flush();
      view.screen.scrollPage(-1);
      await view.flush();

      const stableAnchor = store.snapshot().scrollAnchor;
      if (stableAnchor === undefined) throw new Error('manual anchor was not persisted');
      const writesBeforeOutput = scrollWrites.mock.calls.length;
      const streamingAssistant = assistant({ id: 'manual-live-assistant' });
      highWater++;
      view.screen.render({ type: 'message_start', message: streamingAssistant });

      // The new block has not received a layout coordinate yet. It must never replace the
      // already committed viewport anchor merely because output arrived between frames.
      const anchorBeforeLayout = store.snapshot().scrollAnchor;
      for (let index = 0; index < 1_000; index++) {
        highWater++;
        view.screen.render({
          type: 'message_update',
          messageId: streamingAssistant.id,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta: String(index % 10),
            partial: { ...streamingAssistant, content: [{ type: 'text', text: '' }] },
          },
        });
      }

      expect({
        stableBlockKey: stableAnchor.blockKey,
        blockKeyBeforeLayout: anchorBeforeLayout?.blockKey,
        outputScrollWrites: scrollWrites.mock.calls.length - writesBeforeOutput,
        unreadAfterSeq: store.snapshot().unreadAfterSeq,
      }).toEqual({
        stableBlockKey: stableAnchor.blockKey,
        blockKeyBeforeLayout: stableAnchor.blockKey,
        outputScrollWrites: 1,
        unreadAfterSeq: 80,
      });
    } finally {
      scrollWrites.mockRestore();
      await view.destroy();
      store.dispose();
    }
  });

  it('分段历史的首次 PageUp 可见上移，wheel 到当前段顶部会加载更早历史', async () => {
    const view = await setup(80, 20);
    try {
      const messages = Array.from({ length: 300 }, (_, index): UserMessage => ({
        ...user(`segmented-history-${String(index).padStart(3, '0')}`),
        id: `segmented-history-${index}`,
      }));
      view.screen.replayTranscript(messages);
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      const beforeFrame = view.frame();
      expect(transcript.getChildren()).toHaveLength(TRANSCRIPT_REPLAY_CHUNK_MESSAGES + 1);
      expect(transcript.scrollTop).toBe(
        Math.max(0, transcript.scrollHeight - transcript.viewport.height),
      );

      view.screen.scrollPage(-1);
      await view.flush();
      await view.flush();

      const afterPageUpFrame = view.frame();
      const loadedAfterPageUp = transcript.getChildren().length;
      const topAfterPageUp = transcript.scrollTop;
      const maximumAfterPageUp = Math.max(
        0,
        transcript.scrollHeight - transcript.viewport.height,
      );
      const pageUpDistance = maximumAfterPageUp - topAfterPageUp;
      expect(pageUpDistance).toBeGreaterThanOrEqual(
        Math.max(1, Math.round(transcript.viewport.height * 0.8) - 1),
      );
      transcript.scrollTop = 1;
      await view.flush();
      await view.mockMouse.scroll(
        transcript.screenX + 1,
        transcript.screenY + 1,
        'up',
        { delayMs: 0 },
      );
      await view.flush();
      await view.flush();

      expect({
        pageUpLoadedEarlier: loadedAfterPageUp > TRANSCRIPT_REPLAY_CHUNK_MESSAGES + 1,
        pageUpChangedFrame: afterPageUpFrame !== beforeFrame,
        pageUpLeftStickyBottom: topAfterPageUp < maximumAfterPageUp,
        wheelLoadedEarlier: transcript.getChildren().length > loadedAfterPageUp,
        finalChildCount: transcript.getChildren().length,
      }).toEqual({
        pageUpLoadedEarlier: true,
        pageUpChangedFrame: true,
        pageUpLeftStickyBottom: true,
        wheelLoadedEarlier: true,
        finalChildCount: messages.length + 1,
      });
    } finally {
      await view.destroy();
    }
  });

  it('resetTranscript 会隔离旧 segment/anchor 的 queued frame callback', async () => {
    const view = await setup(80, 20);
    try {
      const sourceMessages = Array.from({ length: 300 }, (_, index): UserMessage => ({
        ...user(`source-history-${String(index).padStart(3, '0')}`),
        id: `source-history-${index}`,
      }));
      const targetMessages = Array.from({ length: 300 }, (_, index): UserMessage => ({
        ...user(`target-history-${String(index).padStart(3, '0')}`),
        id: `target-history-${index}`,
      }));
      view.screen.replayTranscript(sourceMessages);
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      view.screen.scrollPage(-1);
      // Deliberately reset before the segment's anchor-restore/PageUp callbacks receive a frame.
      view.screen.resetTranscript(targetMessages, 300);
      const expectedTailChildren = TRANSCRIPT_REPLAY_CHUNK_MESSAGES + 1;
      await view.flush();
      await view.flush();

      expect({
        childCount: transcript.getChildren().length,
        atLatest: transcript.scrollTop ===
          Math.max(0, transcript.scrollHeight - transcript.viewport.height),
        frame: view.frame(),
      }).toEqual({
        childCount: expectedTailChildren,
        atLatest: true,
        frame: expect.stringContaining('target-history-299'),
      });
      expect(view.frame()).not.toContain('source-history-');
    } finally {
      await view.destroy();
    }
  });

  it('resetTranscript 会隔离旧 wheel 的 queued frame callback 与 manual state', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-wheel-reset-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_wheel_reset' as WorkspaceId,
      threadId: 'thr_wheel_source' as ThreadId,
    });
    const view = await setup(80, 20, () => {}, true, undefined, {
      presentation: { store },
      eventHighWaterSeq: () => 30,
    });
    try {
      const sourceMessages = Array.from({ length: 30 }, (_, index): UserMessage => ({
        ...user(`wheel-source-${String(index).padStart(2, '0')}`),
        id: `wheel-source-${index}`,
      }));
      const targetMessages = Array.from({ length: 10 }, (_, index): UserMessage => ({
        ...user(`wheel-target-${String(index).padStart(2, '0')}`),
        id: `wheel-target-${index}`,
      }));
      view.screen.replayTranscript(sourceMessages);
      await view.flush();
      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');

      await view.mockMouse.scroll(
        transcript.screenX + 1,
        transcript.screenY + 1,
        'up',
        { delayMs: 0 },
      );
      store.switchToThread('thr_wheel_target' as ThreadId);
      view.screen.resetTranscript(targetMessages, 30);
      await view.flush();

      expect({
        scrollAnchor: store.snapshot().scrollAnchor,
        unreadAfterSeq: store.snapshot().unreadAfterSeq,
        atLatest: transcript.scrollTop ===
          Math.max(0, transcript.scrollHeight - transcript.viewport.height),
      }).toEqual({
        scrollAnchor: undefined,
        unreadAfterSeq: 0,
        atLatest: true,
      });
    } finally {
      await view.destroy();
      store.dispose();
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

  it('live tool 锚点持久化后能按同一 toolCallId 在折叠回放中恢复', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-tool-anchor-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_tui_tool_anchor' as WorkspaceId,
      threadId: 'thr_tui_tool_anchor' as ThreadId,
    });
    const first = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 40,
    });
    try {
      first.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'call-anchor-stable',
        toolName: 'bash',
        args: { command: 'bun test' },
      });
      first.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'call-anchor-stable',
        result: toolResult('call-anchor-stable', 'bash', 'tests passed'),
      });
      for (let index = 0; index < 30; index++) first.screen.println(`live filler ${index}`);
      await first.flush();
      first.screen.scrollPage(-1);
      await first.flush();
      store.flush();
      expect(store.snapshot().scrollAnchor?.blockKey).toBe('tool:call-anchor-stable');
    } finally {
      await first.destroy();
    }

    const replay: AgentMessage[] = [
      assistant({
        id: 'assistant-tool-anchor',
        content: [{
          type: 'tool_call',
          id: 'call-anchor-stable',
          name: 'bash',
          arguments: { command: 'bun test' },
        }],
        stopReason: 'tool_calls',
      }),
      toolResult('call-anchor-stable', 'bash', 'tests passed'),
      ...Array.from({ length: 30 }, (_, index): UserMessage => ({
        ...user(`replay filler ${index}`),
        id: `replay-filler-${index}`,
      })),
    ];
    const reopened = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 40,
    });
    try {
      reopened.screen.replayTranscript(replay);
      reopened.screen.restorePresentation(store.snapshot());
      await reopened.flush();
      await reopened.flush();
      expect(reopened.frame()).not.toContain('saved scroll anchor was compacted');
      expect(store.snapshot().scrollAnchor?.blockKey).toBe('tool:call-anchor-stable');
    } finally {
      await reopened.destroy();
      store.dispose();
    }
  });

  it('跨 turn 重复 toolCallId 使用确定 occurrence 锚点并精确恢复第二次调用', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-reused-tool-anchor-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_tui_reused_tool_anchor' as WorkspaceId,
      threadId: 'thr_tui_reused_tool_anchor' as ThreadId,
    });
    const first = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 80,
    });
    try {
      for (const command of ['bun test first', 'bun test second']) {
        first.screen.render({
          type: 'tool_execution_start',
          toolCallId: 'call-reused-across-turns',
          toolName: 'bash',
          args: { command },
        });
        first.screen.render({
          type: 'tool_execution_end',
          toolCallId: 'call-reused-across-turns',
          result: toolResult('call-reused-across-turns', 'bash', `${command} passed`),
        });
        const fillerCount = command.endsWith('first') ? 10 : 30;
        for (let index = 0; index < fillerCount; index++) {
          first.screen.println(`${command} filler ${index}`);
        }
      }
      await first.flush();
      first.screen.jumpToLatest();
      await first.flush();
      first.screen.scrollPage(-1);
      await first.flush();
      store.flush();
      expect(store.snapshot().scrollAnchor?.blockKey).toBe(
        'tool:call-reused-across-turns:occurrence:2',
      );
    } finally {
      await first.destroy();
    }

    const replay: AgentMessage[] = [
      assistant({
        id: 'assistant-reused-tool-first',
        content: [{
          type: 'tool_call',
          id: 'call-reused-across-turns',
          name: 'bash',
          arguments: { command: 'bun test first' },
        }],
        stopReason: 'tool_calls',
      }),
      toolResult('call-reused-across-turns', 'bash', 'bun test first passed'),
      ...Array.from({ length: 10 }, (_, index): UserMessage => ({
        ...user(`first replay filler ${index}`),
        id: `first-reused-tool-filler-${index}`,
      })),
      assistant({
        id: 'assistant-reused-tool-second',
        content: [{
          type: 'tool_call',
          id: 'call-reused-across-turns',
          name: 'bash',
          arguments: { command: 'bun test second' },
        }],
        stopReason: 'tool_calls',
      }),
      toolResult('call-reused-across-turns', 'bash', 'bun test second passed'),
      ...Array.from({ length: 30 }, (_, index): UserMessage => ({
        ...user(`second replay filler ${index}`),
        id: `second-reused-tool-filler-${index}`,
      })),
    ];
    const reopened = await setup(80, 20, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
      eventHighWaterSeq: () => 80,
    });
    try {
      reopened.screen.replayTranscript(replay);
      reopened.screen.restorePresentation(store.snapshot());
      await reopened.flush();
      await reopened.flush();
      expect(reopened.frame()).not.toContain('saved scroll anchor was compacted');
      expect(store.snapshot().scrollAnchor?.blockKey).toBe(
        'tool:call-reused-across-turns:occurrence:2',
      );
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

describe('TUI review and recovery workflow', () => {
  it('diff viewer keeps complete grouped patches and supports file/scope navigation', async () => {
    const view = await setup(100, 30);
    try {
      const longPatch = Array.from(
        { length: 40 },
        (_, index) => `+ complete patch line ${index}`,
      ).join('\n');
      view.screen.openDiffViewer({
        workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
        threadId: 'thread-diff' as ThreadId,
        scope: 'turn',
        generatedAt: 8,
        files: [
          {
            path: 'src/staged.ts',
            group: 'staged',
            status: 'M',
            patch: longPatch,
          },
          {
            path: 'src/unstaged.ts\u001b]0;hidden\u0007',
            group: 'unstaged',
            status: 'M',
            patch: '+ second file',
          },
        ],
      });
      await view.flush();
      expect(view.frame()).toContain('turn diff · 1/2');
      expect(view.frame()).toContain('[staged] M src/staged.ts');
      const body = view.renderer.root.findDescendantById('coda-diff-body');
      expect((body as unknown as { content: { chunks: { text: string }[] } })
        .content.chunks.map((chunk) => chunk.text).join(''))
        .toContain('+ complete patch line 39');

      expect(view.screen.handleDiffViewerKey({ name: 'right' } as KeyEvent)).toBe('handled');
      await view.flush();
      expect(view.frame()).toContain('turn diff · 2/2');
      expect(view.frame()).toContain('+ second file');
      expect(view.frame()).not.toContain('\u001b');
      expect(view.screen.handleDiffViewerKey({ name: 'tab' } as KeyEvent)).toBe('toggle-scope');
      expect(view.screen.handleDiffViewerKey({ name: 'escape' } as KeyEvent)).toBe('handled');
      await view.flush();
      expect(view.frame()).not.toContain('turn diff · 2/2');
    } finally {
      await view.destroy();
    }
  });

  it('session picker searches the full catalog live and returns only the selected thread', async () => {
    const view = await setup(100, 30);
    try {
      view.screen.openSessionPicker([
        {
          workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
          cwd: '/workspace/alpha',
          updatedAt: 1,
          preview: 'alpha preview',
          thread: {
            threadId: 'thread-alpha' as ThreadId,
            createdAt: 1,
            state: 'idle',
            title: 'Alpha',
          },
        },
        {
          workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
          cwd: '/workspace/beta',
          updatedAt: 2,
          preview: 'beta preview',
          thread: {
            threadId: 'thread-beta' as ThreadId,
            createdAt: 1,
            state: 'running',
            title: 'Beta',
          },
        },
      ], '');
      expect(view.screen.handleSessionPickerKey({
        name: 'b',
        sequence: 'b',
        ctrl: false,
        meta: false,
        option: false,
        super: false,
        hyper: false,
      } as KeyEvent)).toEqual({ kind: 'handled' });
      await view.flush();
      expect(view.frame()).toContain('1 match(es)');
      expect(view.frame()).toContain('Beta');
      expect(view.frame()).not.toContain('Alpha');

      expect(view.screen.handleSessionPickerKey({ name: 'backspace' } as KeyEvent))
        .toEqual({ kind: 'handled' });
      expect(view.screen.handleSessionPickerKey({ name: 'down' } as KeyEvent))
        .toEqual({ kind: 'handled' });
      expect(view.screen.handleSessionPickerKey({ name: 'enter' } as KeyEvent)).toEqual({
        kind: 'select',
        threadId: 'thread-alpha' as ThreadId,
      });
    } finally {
      await view.destroy();
    }
  });

  it('restorePresentation 对不可独立恢复的 panel 明确回退 transcript 并同步 store', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'coda-tui-panel-restore-fallback-'));
    tempDirs.push(root);
    const store = new ThreadPresentationStore({
      root,
      workspaceId: 'ws_panel_restore_fallback' as WorkspaceId,
      threadId: 'thr_panel_restore_fallback' as ThreadId,
    });
    store.setActivePanel('diff');
    store.flush();
    const state = store.snapshot();
    const view = await setup(100, 30, () => {}, true, undefined, {
      resumed: true,
      presentation: { store },
    });
    try {
      view.screen.resetTranscript([{
        ...user('panel restore transcript'),
        id: 'panel-restore-transcript',
      }], 1);
      view.screen.restorePresentation(state);
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      const diffPanel = view.renderer.root.findDescendantById('coda-diff-panel');
      const sessionPanel = view.renderer.root.findDescendantById('coda-session-panel');
      if (transcript === undefined || diffPanel === undefined || sessionPanel === undefined) {
        throw new Error('panel not found');
      }
      // Diff/session payloads are Runtime queries and are not durable presentation data. Until the
      // controller explicitly re-queries one, recovery must normalize both view and store to the
      // transcript instead of retaining an impossible activePanel value.
      expect({
        storePanel: store.snapshot().activePanel,
        transcriptVisible: transcript.visible,
        diffVisible: diffPanel.visible,
        sessionsVisible: sessionPanel.visible,
      }).toEqual({
        storePanel: 'transcript',
        transcriptVisible: true,
        diffVisible: false,
        sessionsVisible: false,
      });
    } finally {
      await view.destroy();
      store.dispose();
    }
  });

  it('diff 与 sessions 在 live/status/composer/resize 刷新中保持独占，输入只路由到 active panel', async () => {
    const view = await setup(100, 30);
    try {
      for (let index = 0; index < 30; index++) {
        view.screen.println(`panel-transcript-${String(index).padStart(2, '0')}`);
      }
      await view.flush();

      const transcript = view.renderer.root.findDescendantById('coda-transcript');
      const diffPanel = view.renderer.root.findDescendantById('coda-diff-panel');
      const diffScroll = view.renderer.root.findDescendantById('coda-diff-scroll');
      const sessionPanel = view.renderer.root.findDescendantById('coda-session-panel');
      if (!(transcript instanceof ScrollBoxRenderable)) throw new Error('transcript not found');
      if (!(diffScroll instanceof ScrollBoxRenderable)) throw new Error('diff scroll not found');
      if (diffPanel === undefined || sessionPanel === undefined) throw new Error('panel not found');

      const diffSnapshot = {
        workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
        threadId: 'thread-exclusive-panel' as ThreadId,
        scope: 'turn' as const,
        generatedAt: 9,
        files: [{
          path: 'src/panel.ts',
          group: 'unstaged' as const,
          status: 'M',
          patch: Array.from(
            { length: 80 },
            (_, index) => `+ active-diff-line-${String(index).padStart(2, '0')}`,
          ).join('\n'),
        }],
      };
      const sessions = [
        {
          workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
          cwd: '/workspace/one',
          updatedAt: 2,
          preview: 'first session',
          thread: {
            threadId: 'thread-panel-one' as ThreadId,
            createdAt: 1,
            state: 'idle' as const,
            title: 'Panel One',
          },
        },
        {
          workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
          cwd: '/workspace/two',
          updatedAt: 3,
          preview: 'second session',
          thread: {
            threadId: 'thread-panel-two' as ThreadId,
            createdAt: 1,
            state: 'running' as const,
            title: 'Panel Two',
          },
        },
      ];

      const diffRefreshStates: Array<{
        readonly trigger: string;
        readonly transcriptVisible: boolean;
        readonly diffVisible: boolean;
      }> = [];
      const diffTriggers: ReadonlyArray<readonly [string, () => void]> = [
        ['live event', () => view.screen.render({
          type: 'message_start',
          message: { ...user('hidden diff live event'), id: 'hidden-diff-live' },
        })],
        ['status refresh', () => view.screen.setUsage({
          cumulative: { input: 2, output: 3 },
          turns: 1,
          contextTokens: 4,
        })],
        ['composer refresh', () => view.screen.setInput('diff panel keeps this draft')],
        ['resize', () => view.resize(96, 28)],
      ];
      for (const [trigger, refresh] of diffTriggers) {
        view.screen.openDiffViewer(diffSnapshot);
        await view.flush();
        refresh();
        await view.flush();
        diffRefreshStates.push({
          trigger,
          transcriptVisible: transcript.visible,
          diffVisible: diffPanel.visible,
        });
      }
      const sessionRefreshStates: Array<{
        readonly trigger: string;
        readonly transcriptVisible: boolean;
        readonly sessionsVisible: boolean;
      }> = [];
      const sessionTriggers: ReadonlyArray<readonly [string, () => void]> = [
        ['live event', () => view.screen.render({
          type: 'message_start',
          message: { ...user('hidden sessions live event'), id: 'hidden-sessions-live' },
        })],
        ['status refresh', () => view.screen.setTransientStatus('session status refresh')],
        ['composer refresh', () => view.screen.setInput('sessions panel keeps this draft')],
        ['resize', () => view.resize(92, 26)],
      ];
      for (const [trigger, refresh] of sessionTriggers) {
        view.screen.openSessionPicker(sessions, '');
        await view.flush();
        refresh();
        await view.flush();
        sessionRefreshStates.push({
          trigger,
          transcriptVisible: transcript.visible,
          sessionsVisible: sessionPanel.visible,
        });
      }
      view.screen.openDiffViewer(diffSnapshot);
      await view.flush();
      const transcriptTopDuringDiff = transcript.scrollTop;
      const diffTopBeforeWheel = diffScroll.scrollTop;
      await view.mockMouse.scroll(
        diffScroll.screenX + 1,
        diffScroll.screenY + 1,
        'down',
        { delayMs: 0 },
      );
      await view.flush();
      expect(diffScroll.scrollTop).toBeGreaterThan(diffTopBeforeWheel);
      expect(transcript.scrollTop).toBe(transcriptTopDuringDiff);
      const diffTopBeforeKey = diffScroll.scrollTop;
      expect(view.screen.handleDiffViewerKey({ name: 'pagedown' } as KeyEvent)).toBe('handled');
      await view.flush();
      expect(diffScroll.scrollTop).toBeGreaterThan(diffTopBeforeKey);
      expect(transcript.scrollTop).toBe(transcriptTopDuringDiff);

      view.screen.openSessionPicker(sessions, '');
      await view.flush();
      const transcriptTopDuringSessions = transcript.scrollTop;
      expect(view.screen.handleSessionPickerKey({ name: 'pageup' } as KeyEvent))
        .toEqual({ kind: 'handled' });
      await view.mockMouse.scroll(
        sessionPanel.screenX + 1,
        sessionPanel.screenY + 2,
        'up',
        { delayMs: 0 },
      );
      await view.flush();
      expect(transcript.scrollTop).toBe(transcriptTopDuringSessions);
      expect({
        diffRefreshStates,
        sessionRefreshStates,
        finalTranscriptVisible: transcript.visible,
        finalSessionPanelVisible: sessionPanel.visible,
      }).toEqual({
        diffRefreshStates: diffTriggers.map(([trigger]) => ({
          trigger,
          transcriptVisible: false,
          diffVisible: true,
        })),
        sessionRefreshStates: sessionTriggers.map(([trigger]) => ({
          trigger,
          transcriptVisible: false,
          sessionsVisible: true,
        })),
        finalTranscriptVisible: false,
        finalSessionPanelVisible: true,
      });
    } finally {
      await view.destroy();
    }
  });
});

describe('TUI plan 展示', () => {
  it('以标题、完成进度、树状缩进和当前步骤强调展示整表快照', async () => {
    const view = await setup(100, 42);
    try {
      view.screen.render({
        type: 'plan_update',
        steps: [
          { step: 'Inspect current plan styling', status: 'completed' },
          { step: 'Implement the highlighted plan row with wrapping', status: 'in_progress' },
          { step: 'Verify the complete terminal layout', status: 'pending' },
        ],
      });
      await view.flush();

      const frame = view.frame();
      expect(frame).toContain('• Updated Plan · 1/3 complete');
      expect(frame).toContain('  └ ✔ Inspect current plan styling');
      expect(frame).toContain('    □ Implement the highlighted plan row with wrapping');
      expect(frame).toContain('    □ Verify the complete terminal layout');

      const planSpans = view.spans().lines.flatMap((line) => line.spans);
      const completed = planSpans.find((span) => span.text.includes('Inspect current plan styling'));
      const active = planSpans.find((span) => span.text.includes('Implement the highlighted plan row'));
      const pending = planSpans.find((span) => span.text.includes('Verify the complete terminal layout'));
      expect(completed?.fg.toInts()).toEqual([99, 104, 115, 255]);
      expect(active?.fg.toInts()).toEqual([39, 106, 122, 255]);
      expect(pending?.fg.toInts()).toEqual([99, 104, 115, 255]);

      view.resize(32, 42);
      await view.flush();
      expect(view.frame()).toContain('        with wrapping');
    } finally {
      await view.destroy();
    }
  });

  it('mono 用可辨别的 ASCII 状态替代颜色焦点', async () => {
    const view = await setup(80, 30, () => {}, true, undefined, { theme: 'mono' });
    try {
      view.screen.render({
        type: 'plan_update',
        steps: [
          { step: 'done', status: 'completed' },
          { step: 'now', status: 'in_progress' },
          { step: 'next', status: 'pending' },
        ],
      });
      await view.flush();
      expect(view.frame()).toContain('Updated Plan | 1/3 complete');
      expect(view.frame()).toContain('  \\ [x] done');
      expect(view.frame()).toContain('    [>] now');
      expect(view.frame()).toContain('    [ ] next');
      for (const line of view.spans().lines) {
        for (const span of line.spans) {
          if (span.text.trim() !== '') expect(span.fg.intent).toBe('default');
        }
      }
    } finally {
      await view.destroy();
    }
  });

  it('整表替换同步更新可搜索的 plan 文本投影', async () => {
    const view = await setup(80, 30);
    try {
      view.screen.render({
        type: 'plan_update',
        steps: [{ step: 'obsolete plan step', status: 'in_progress' }],
      });
      view.screen.render({
        type: 'plan_update',
        steps: [{ step: 'current plan step', status: 'in_progress' }],
      });
      await view.flush();
      expect(view.screen.searchTranscript('obsolete plan step')).toBe(false);
      expect(view.screen.searchTranscript('current plan step')).toBe(true);
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
      view.screen.render(approvalControlRequest('approval-1', `run${osc}safe`, 'tool-1'));
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

  it('流式文本保持块边界，reasoning summary 只替换 prompt 上方的 Working 行', async () => {
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
          { type: 'reasoning', kind: 'summary', text: '' },
        ],
      });
      const reasoningTwo = assistant({
        content: [
          { type: 'text', text: 'FIRST' },
          { type: 'text', text: 'SECOND' },
          { type: 'reasoning', kind: 'summary', text: 'THINK-ONE' },
          { type: 'reasoning', kind: 'summary', text: '' },
        ],
      });

      view.screen.render({ type: 'agent_start', reason: 'prompt' });
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
      const working = view.renderer.root.findDescendantById('coda-working');
      const prompt = view.renderer.root.findDescendantById('coda-prompt-box');
      if (!(working instanceof TextRenderable) || !(prompt instanceof BoxRenderable)) {
        throw new Error('Working line or prompt box not found');
      }
      expect(streaming).not.toContain('FIRSTSECOND');
      expect(streaming).not.toContain('THINK-ONE');
      expect(streaming).toContain('THINK-TWO');
      expect(streaming.indexOf('SECOND')).toBeGreaterThan(streaming.indexOf('FIRST'));
      expect(working.visible).toBe(true);
      expect(working.height).toBe(1);
      expect(working.screenY + working.height).toBe(prompt.screenY);
      expect(streaming).not.toContain('thinking ·');

      view.screen.render({
        type: 'message_end',
        message: assistant({
          content: [
            { type: 'text', text: 'FIRST' },
            { type: 'text', text: 'SECOND' },
            { type: 'reasoning', kind: 'summary', text: 'THINK-ONE' },
            { type: 'reasoning', kind: 'summary', text: 'THINK-TWO' },
          ],
        }),
      });
      view.screen.render({ type: 'agent_end', reason: 'completed', messages: [] });
      await view.flush();
      await view.resolveHighlights();
      const finalFrame = view.frame();
      expect(finalFrame).not.toContain('FIRSTSECOND');
      expect(finalFrame).not.toContain('THINK-ONE');
      expect(finalFrame).not.toContain('THINK-TWO');
      expect(finalFrame).not.toContain('thinking ·');
      expect(working.visible).toBe(false);
    } finally {
      await view.destroy();
    }
  });

  it('原始 reasoning/content 不进入 Working，也不封口连续探索', async () => {
    const view = await setup(100, 35);
    try {
      const rawReasoning = assistant({
        id: 'raw-reasoning',
        content: [{ type: 'reasoning', kind: 'content', text: 'PRIVATE_CHAIN' }],
      });
      view.screen.render({ type: 'agent_start', reason: 'prompt' });
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'raw-read-a',
        toolName: 'read',
        args: { path: 'a.ts' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'raw-read-a',
        result: toolResult('raw-read-a', 'read', 'a'),
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'raw-reasoning',
        event: { type: 'reasoning_start', contentIndex: 0, partial: rawReasoning },
      });
      view.screen.render({
        type: 'message_update',
        messageId: 'raw-reasoning',
        event: {
          type: 'reasoning_delta',
          contentIndex: 0,
          delta: 'PRIVATE_CHAIN',
          partial: rawReasoning,
        },
      });
      view.screen.render({
        type: 'tool_execution_start',
        toolCallId: 'raw-read-b',
        toolName: 'read',
        args: { path: 'b.ts' },
      });
      view.screen.render({
        type: 'tool_execution_end',
        toolCallId: 'raw-read-b',
        result: toolResult('raw-read-b', 'read', 'b'),
      });
      view.screen.render({ type: 'agent_end', reason: 'completed', messages: [] });
      await view.flush();

      expect(view.frame()).not.toContain('PRIVATE_CHAIN');
      expect(view.frame().match(/Explored/gu)).toHaveLength(1);
      expect(view.frame()).toContain('Read a.ts, b.ts');
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
      expect(frame).toContain('• Ran bun test');
      expect(frame).toContain('tests passed');
      expect(frame.match(/Ran bun test/gu)).toHaveLength(1);
      expect(frame).toContain('new step');
      expect(frame).not.toContain('old step');
      expect(frame).toContain('invalid plan arguments');
      expect(frame).toContain('✗ plan');
      expect(frame).toContain('malformed plan details');
    } finally {
      await view.destroy();
    }
  });

  it('分段回放加载旧 plan 后仍保持全量历史中的最新成功 plan', async () => {
    const messages: AgentMessage[] = [
      assistant({
        id: 'assistant-old-plan',
        content: [{
          type: 'tool_call',
          id: 'old-plan-call',
          name: 'plan',
          arguments: { steps: [{ step: 'old segmented plan', status: 'in_progress' }] },
        }],
        stopReason: 'tool_calls',
      }),
      toolResult('old-plan-call', 'plan', 'old segmented plan', {
        details: { steps: [{ step: 'old segmented plan', status: 'in_progress' }] },
      }),
      ...Array.from({ length: 10 }, (_, index): UserMessage => ({
        ...user(`before latest plan ${index}`),
        id: `before-latest-plan-${index}`,
      })),
      assistant({
        id: 'assistant-latest-plan',
        content: [{
          type: 'tool_call',
          id: 'latest-plan-call',
          name: 'plan',
          arguments: { steps: [{ step: 'latest segmented plan', status: 'completed' }] },
        }],
        stopReason: 'tool_calls',
      }),
      toolResult('latest-plan-call', 'plan', 'latest segmented plan', {
        details: { steps: [{ step: 'latest segmented plan', status: 'completed' }] },
      }),
      ...Array.from({ length: 118 }, (_, index): UserMessage => ({
        ...user(`after latest plan ${index}`),
        id: `after-latest-plan-${index}`,
      })),
    ];
    const view = await setup(100, 50);
    try {
      view.screen.replayTranscript(messages);
      await view.flush();
      expect(view.frame()).toContain('latest segmented plan');
      expect(view.frame()).not.toContain('old segmented plan');

      view.screen.scrollPage(-1);
      await view.flush();
      await view.flush();
      // A real PageUp now moves a viewport page after loading the segment, so the footer plan
      // may be outside the visible window. Returning to latest proves that replaying the older
      // plan did not replace the canonical latest successful plan.
      expect(view.frame()).not.toContain('old segmented plan');
      view.screen.jumpToLatest();
      await view.flush();
      expect(view.frame()).toContain('latest segmented plan');
      expect(view.frame()).not.toContain('old segmented plan');
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
        predecessorRunId: RETRY_PREDECESSOR_RUN_ID,
        successorRunId: RETRY_SUCCESSOR_RUN_ID,
      });
      expect(view.interaction.phase).toBe('retrying');
      expect(tuiEnterState(view.interaction.phase)).toBe('running');
      expect(tuiCanAbort(view.interaction.phase)).toBe(true);

      view.screen.render({ type: 'error', fatal: false, message: 'retry cancelled by abort' });
      await view.flush();
      expect(view.interaction.phase).toBe('idle');
      expect(view.frame()).not.toContain('coda · ready');

      view.screen.render({
        type: 'compaction_start',
        reason: 'threshold',
        predecessorRunId: RETRY_PREDECESSOR_RUN_ID,
        activityRunId: COMPACTION_RUN_ID,
      });
      await view.flush();
      expect(view.interaction.phase).toBe('compacting');
      expect(tuiEnterState(view.interaction.phase)).toBe('idle');
      expect(tuiCanAbort(view.interaction.phase)).toBe(true);
      expect(view.frame()).toContain('Compacting context · Enter queue');

      view.screen.render({
        type: 'compaction_end',
        activityRunId: COMPACTION_RUN_ID,
        ok: false,
        droppedMessages: 0,
      });
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
  it('diff active panel 经 controller 消费普通键与鼠标，不改写隐藏的 composer draft', async () => {
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
    const view = await setup(100, 30);
    const controller = runTuiController(session, undefined, view.screen, view.renderer, {
      interaction: view.interaction,
      installSignalHandlers: false,
    });
    view.screen.focusInput();
    view.screen.setInput('held composer draft');
    view.screen.openDiffViewer({
      workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
      threadId: 'thread-controller-diff' as ThreadId,
      scope: 'turn',
      generatedAt: 10,
      files: [{
        path: 'src/controller-diff.ts',
        group: 'unstaged',
        status: 'M',
        patch: Array.from({ length: 80 }, (_, index) => `+ diff-row-${index}`).join('\n'),
      }],
    });
    await view.flush();
    const diffScroll = view.renderer.root.findDescendantById('coda-diff-scroll');
    if (!(diffScroll instanceof ScrollBoxRenderable)) throw new Error('diff scroll not found');

    await view.mockInput.typeText('x');
    await view.mockMouse.scroll(
      diffScroll.screenX + 1,
      diffScroll.screenY + 1,
      'down',
      { delayMs: 0 },
    );
    await view.flush();
    const draftAfterDiffInput = view.screen.getInput();

    view.mockInput.pressEscape();
    await view.flush();
    view.screen.setInput('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
    expect(draftAfterDiffInput).toBe('held composer draft');
  });

  it('审批队列抢占背景 panel，并按队首逐张展示和决议', async () => {
    let listener: (event: CliRuntimeEvent) => void = () => {};
    const resolved: Array<{ id: string; decision: string }> = [];
    const session: CliSession = {
      interactionState: () => 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      prompt: async () => undefined,
      steer: () => undefined,
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const approval: CliControlActions = {
      resolveApproval: (id, decision) => resolved.push({ id, decision }),
    };
    const view = await setup(90, 30);
    const controller = runTuiController(session, approval, view.screen, view.renderer, {
      interaction: view.interaction,
      installSignalHandlers: false,
    });
    view.screen.openDiffViewer({
      workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
      threadId: 'approval-panel-thread' as ThreadId,
      scope: 'turn',
      generatedAt: 10,
      files: [{ path: 'a.ts', group: 'unstaged', status: 'M', patch: '+change' }],
    });
    listener(approvalControlRequest('approval-first', 'first dangerous command', 'call-first'));
    listener(approvalControlRequest('approval-second', 'second dangerous command', 'call-second'));
    await view.flush();
    expect(view.frame()).toContain('first dangerous command');
    expect(view.frame()).not.toContain('second dangerous command');

    view.mockInput.pressKey('y');
    await view.flush();
    expect(resolved).toEqual([{ id: 'approval-first', decision: 'allow_once' }]);
    expect(view.frame()).not.toContain('first dangerous command');
    expect(view.frame()).toContain('second dangerous command');

    listener({
      type: 'tool_execution_start',
      toolCallId: 'call-first',
      toolName: 'bash',
      args: { command: 'first' },
    });
    await view.flush();
    expect(view.frame()).toContain('second dangerous command');

    view.mockInput.pressKey('n');
    await view.flush();
    expect(resolved).toEqual([
      { id: 'approval-first', decision: 'allow_once' },
      { id: 'approval-second', decision: 'deny' },
    ]);
    view.mockInput.pressEscape();
    view.screen.setInput('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

  it('活跃 Working 动画退出时先销毁 screen 再等待 renderer idle', async () => {
    const order: string[] = [];
    const session: CliSession = {
      interactionState: () => 'running',
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
    const view = await setup(90, 30, () => {}, true, undefined, {
      workingAnimation: true,
    });
    const controllerScreen: TuiScreen = {
      ...view.screen,
      destroy: () => {
        order.push('screen.destroy');
        view.screen.destroy();
      },
    };
    const controllerRenderer = {
      keyInput: view.renderer.keyInput,
      idle: async () => {
        order.push('renderer.idle');
      },
      destroy: () => {
        order.push('renderer.destroy');
      },
    };
    view.screen.render({ type: 'agent_start', reason: 'prompt' });
    const controller = runTuiController(
      session,
      undefined,
      controllerScreen,
      controllerRenderer,
      { interaction: view.interaction, installSignalHandlers: false },
    );

    view.mockInput.pressKey('c', { ctrl: true });
    view.mockInput.pressKey('c', { ctrl: true });
    expect(await controller).toBe(0);
    expect(order).toEqual(['screen.destroy', 'renderer.idle', 'renderer.destroy']);
    await view.destroyHighlighter();
    view.renderer.destroy();
  });

  it('陈旧 async diff scope 结果不会从已切换的 sessions panel 抢回 active panel', async () => {
    const threadId = 'thread-stale-diff' as ThreadId;
    const staleDiffSnapshot = {
      workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
      threadId,
      scope: 'workspace' as const,
      generatedAt: 12,
      files: [{
        path: 'src/stale-diff.ts',
        group: 'unstaged' as const,
        status: 'M',
        patch: '+ stale diff result',
      }],
    };
    let resolveDiff!: (snapshot: typeof staleDiffSnapshot | undefined) => void;
    const pendingDiff = new Promise<typeof staleDiffSnapshot | undefined>((resolve) => {
      resolveDiff = resolve;
    });
    let diffRequests = 0;
    const sessions = [{
      workspaceId: WORKSPACE_SNAPSHOT.workspaceId,
      cwd: '/workspace/stale-diff',
      updatedAt: 2,
      preview: 'session remains active',
      thread: {
        threadId,
        createdAt: 1,
        state: 'idle' as const,
        title: 'Stale Diff Thread',
      },
    }];
    const workspace: RuntimeWorkspaceActions = {
      get currentThreadId() { return threadId; },
      eventHighWaterSeq: () => 0,
      listSessions: async () => sessions,
      workspaceSnapshot: async () => WORKSPACE_SNAPSHOT,
      switchSession: async () => undefined,
      newSession: async () => threadId,
      renameSession: async () => undefined,
      archiveSession: async () => undefined,
      compactConversation: async () => undefined,
      forkConversation: async () => threadId,
      retryConversation: async () => threadId,
      reviewSnapshot: async () => undefined,
      diffSnapshot: async () => {
        diffRequests++;
        return pendingDiff;
      },
      pendingApprovals: () => [],
      subscribePendingApprovals: () => () => {},
    };
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
    const view = await setup(100, 30, () => {}, true, undefined, { workspace });
    const controller = runTuiController(session, undefined, view.screen, view.renderer, {
      interaction: view.interaction,
      workspace,
      installSignalHandlers: false,
    });
    view.screen.focusInput();
    view.screen.openDiffViewer({ ...staleDiffSnapshot, scope: 'turn' });
    await view.flush();

    view.mockInput.pressTab();
    expect(diffRequests).toBe(1);
    view.mockInput.pressEscape();
    view.screen.openSessionPicker(sessions, '');
    await view.flush();
    resolveDiff(staleDiffSnapshot);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    await view.flush();

    const transcript = view.renderer.root.findDescendantById('coda-transcript');
    const diffPanel = view.renderer.root.findDescendantById('coda-diff-panel');
    const sessionPanel = view.renderer.root.findDescendantById('coda-session-panel');
    if (transcript === undefined || diffPanel === undefined || sessionPanel === undefined) {
      throw new Error('panel not found');
    }
    const staleResultState = {
      transcriptVisible: transcript.visible,
      diffVisible: diffPanel.visible,
      sessionsVisible: sessionPanel.visible,
    };

    view.mockInput.pressEscape();
    await view.flush();
    view.screen.setInput('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
    expect(staleResultState).toEqual({
      transcriptVisible: false,
      diffVisible: false,
      sessionsVisible: true,
    });
  });

  it('切换 thread 后重建交互状态并且审批只作用于新的当前目标', async () => {
    let currentThreadId = 'thread-running-a' as ThreadId;
    let pendingOnTarget = true;
    const resolved: Array<{ readonly id: string; readonly decision: string }> = [];
    const prompts: string[] = [];
    const steers: string[] = [];
    const workspace: RuntimeWorkspaceActions = {
      get currentThreadId() { return currentThreadId; },
      eventHighWaterSeq: () => currentThreadId === 'thread-idle-b' ? 4 : 8,
      listSessions: async () => [],
      workspaceSnapshot: async () => WORKSPACE_SNAPSHOT,
      switchSession: async (threadId) => { currentThreadId = threadId; },
      newSession: async () => currentThreadId,
      renameSession: async () => undefined,
      archiveSession: async () => undefined,
      compactConversation: async () => undefined,
      forkConversation: async () => currentThreadId,
      retryConversation: async () => currentThreadId,
      reviewSnapshot: async () => undefined,
      diffSnapshot: async () => undefined,
      pendingApprovals: () => currentThreadId === 'thread-idle-b' && pendingOnTarget
        ? [{
            requestId: 'approval-thread-b',
            toolCallId: 'call-thread-b',
            description: 'approve thread B only',
            presentation: approvalPresentationWithoutAlways(
              'approval-thread-b',
              'approve thread B only',
            ),
        }]
        : [],
      subscribePendingApprovals: () => () => {},
    };
    const session: CliSession = {
      interactionState: () => currentThreadId === 'thread-running-a' ? 'running' : 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      get messages() { return []; },
      subscribe: () => () => undefined,
      prompt: async (text) => { prompts.push(text); },
      steer: (text) => {
        steers.push(typeof text === 'string' ? text : '');
      },
      followUp: () => undefined,
      abort: () => undefined,
      close: async () => undefined,
    };
    const approval: CliControlActions = {
      resolveApproval: (id, decision) => {
        resolved.push({ id, decision });
        pendingOnTarget = false;
      },
    };
    const view = await setup(
      90,
      28,
      () => {},
      true,
      { model: MODEL, contextLimit: 128_000 },
      { workspace },
    );
    view.screen.render({ type: 'agent_start', reason: 'prompt' });
    const controller = runTuiController(
      session,
      approval,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        workspace,
        installSignalHandlers: false,
      },
    );

    view.screen.focusInput();
    view.screen.setInput('/switch thread-idle-b');
    await view.flush();
    view.mockInput.pressEnter();
    for (let index = 0; index < 8 && currentThreadId !== 'thread-idle-b'; index++) {
      await Promise.resolve();
    }
    await view.flush();
    expect(currentThreadId).toBe('thread-idle-b' as ThreadId);
    expect(view.interaction.phase).toBe('idle');
    expect(view.frame()).toContain('approve thread B only');

    view.mockInput.pressKey('y');
    expect(resolved).toEqual([{
      id: 'approval-thread-b',
      decision: 'allow_once',
    }]);
    view.screen.setInput('new target prompt');
    view.mockInput.pressEnter();
    expect(prompts).toEqual(['new target prompt']);
    expect(steers).toEqual([]);

    view.screen.setInput('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

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
    const session = idleCliSession();
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
    let currentModel: ReturnType<InteractiveSession['currentModel']>;
    const runtime: InteractiveSession = {
      ...idleCliSession(),
      currentModel: () => currentModel,
      setModel: (model) => {
        currentModel = model.ref;
      },
      clearModel: () => {
        currentModel = undefined;
      },
      subscribeSessionAttached: () => () => undefined,
    };
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
    const session = idleCliSession();
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
    const session = idleCliSession();
    let listener: ((event: CliRuntimeEvent) => void | Promise<void>) | undefined;
    const decisions: Array<{ id: string; decision: string }> = [];
    const approval: CliControlActions = {
      resolveApproval: (id, decision) => decisions.push({ id, decision }),
    };
    const view = await setup();
    view.screen.focusInput();
    const controller = runTuiController(
      {
        ...session,
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      approval,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        installSignalHandlers: false,
      },
    );

    view.screen.setInput('seed');
    const emit = listener;
    if (emit === undefined) throw new Error('primary session listener was not registered');
    await emit(approvalControlRequest('approval-input-freeze', 'run tests', 'call-1'));
    await view.flush();
    expect(view.screen.getInput()).toBe('seed');
    expect(view.frame()).toContain('Would you like to allow the following action?');
    expect(view.frame()).toContain('› 1. Yes, proceed (y)');
    expect(view.frame()).not.toContain("don't ask again");

    view.mockInput.pressKey('v');
    await view.flush();
    expect(view.frame()).toContain('Details');

    await view.mockInput.pasteBracketedText('PASTED\nTEXT');
    view.mockInput.pressKey('a', { meta: true });
    view.mockInput.pressKey('a', { super: true });
    await view.flush();
    expect(view.screen.getInput()).toBe('seed');

    view.mockInput.pressKey('y');
    expect(decisions).toEqual([{ id: 'approval-input-freeze', decision: 'allow_once' }]);
    await view.mockInput.pasteBracketedText('AFTER\nTEXT');
    await view.flush();
    expect(view.screen.getInput()).toBe('seedAFTER\nTEXT');

    view.screen.clearInput();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

  it('canonical control_request enters TUI approval mode on the primary event stream', async () => {
    let listener: ((event: CliRuntimeEvent) => void | Promise<void>) | undefined;
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
      resolveApproval: (id: string, decision: 'allow_once' | 'allow_always' | 'deny' | 'abort') => {
        resolutions.push({ id, decision });
      },
    };
    const presentation = approvalPresentationWithoutAlways('canonical-tui-approval');
    const workspace: RuntimeWorkspaceActions = {
      currentThreadId: presentation.target.threadId,
      eventHighWaterSeq: () => 0,
      listSessions: async () => [],
      workspaceSnapshot: async () => WORKSPACE_SNAPSHOT,
      switchSession: async () => undefined,
      newSession: async () => presentation.target.threadId,
      renameSession: async () => undefined,
      archiveSession: async () => undefined,
      compactConversation: async () => undefined,
      forkConversation: async () => presentation.target.threadId,
      retryConversation: async () => presentation.target.threadId,
      reviewSnapshot: async () => undefined,
      diffSnapshot: async () => undefined,
      pendingApprovals: () => [],
      subscribePendingApprovals: () => () => {},
    };
    const view = await setup(
      100,
      30,
      () => {},
      true,
      { model: MODEL, contextLimit: 128_000 },
      { workspace },
    );
    view.screen.focusInput();
    const controller = runTuiController(
      session,
      approval,
      view.screen,
      view.renderer,
      {
        interaction: view.interaction,
        installSignalHandlers: false,
        workspace,
      },
    );

    const emit = listener;
    if (emit === undefined) throw new Error('primary session listener was not registered');
    await emit(approvalControlRequest('canonical-tui-approval', 'run canonical command', 'call-canonical'));
    await view.flush();
    expect(view.frame()).toContain('Would you like to allow the following action?');
    expect(view.frame()).not.toContain("don't ask again");

    view.mockInput.pressKey('a');
    await view.flush();
    expect(resolutions).toEqual([]);
    expect(view.frame()).toContain('Runtime provided no frozen scope');
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

  it('审批快照恢复初始队列，并在外部决议后原子切换当前卡片', async () => {
    const threadId = 'thread-approval-sync' as ThreadId;
    let pending = [
      {
        requestId: 'approval-first',
        toolCallId: 'call-first',
        description: 'first command',
        presentation: approvalPresentationWithoutAlways('approval-first', 'first command'),
      },
      {
        requestId: 'approval-second',
        toolCallId: 'call-second',
        description: 'second command',
        presentation: approvalPresentationWithoutAlways('approval-second', 'second command'),
      },
    ];
    let pendingListener:
      | Parameters<RuntimeWorkspaceActions['subscribePendingApprovals']>[0]
      | undefined;
    const workspace: RuntimeWorkspaceActions = {
      currentThreadId: threadId,
      eventHighWaterSeq: () => 0,
      listSessions: async () => [],
      workspaceSnapshot: async () => WORKSPACE_SNAPSHOT,
      switchSession: async () => undefined,
      newSession: async () => threadId,
      renameSession: async () => undefined,
      archiveSession: async () => undefined,
      compactConversation: async () => undefined,
      forkConversation: async () => threadId,
      retryConversation: async () => threadId,
      reviewSnapshot: async () => undefined,
      diffSnapshot: async () => undefined,
      pendingApprovals: () => pending,
      subscribePendingApprovals: (listener) => {
        pendingListener = listener;
        void listener({ threadId, approvals: pending });
        return () => {
          pendingListener = undefined;
        };
      },
    };
    const session: CliSession = {
      interactionState: () => 'idle',
      currentModel: () => MODEL,
      usage: () => ({ cumulative: { input: 0, output: 0 }, turns: 0, contextTokens: 0 }),
      messages: [],
      subscribe: () => () => {},
      prompt: async () => {},
      steer: () => {},
      followUp: () => {},
      abort: () => {},
      close: async () => {},
    };
    const view = await setup(
      100,
      30,
      () => {},
      true,
      { model: MODEL, contextLimit: 128_000 },
      { workspace },
    );
    view.screen.focusInput();
    view.screen.setInput('preserved draft');
    const controller = runTuiController(
      session,
      { resolveApproval: () => {} },
      view.screen,
      view.renderer,
      { interaction: view.interaction, installSignalHandlers: false, workspace },
    );

    await view.flush();
    expect(view.frame()).toContain('first command');
    expect(view.frame()).not.toContain('second command');

    pending = [pending[1]!];
    await pendingListener?.({ threadId, approvals: pending });
    await view.flush();
    expect(view.frame()).not.toContain('first command');
    expect(view.frame()).toContain('second command');

    pending = [];
    await pendingListener?.({ threadId, approvals: pending });
    await view.flush();
    expect(view.frame()).not.toContain('Would you like to allow the following action?');
    expect(view.frame()).toContain('preserved draft');

    view.screen.clearInput();
    await view.mockInput.typeText('/quit');
    view.mockInput.pressEnter();
    expect(await controller).toBe(0);
    await view.destroyHighlighter();
  });

});

function approvalPresentationWithoutAlways(
  requestId: string,
  description = 'Run canonical command',
): ApprovalPresentation {
  return {
    requestId,
    target: {
      workspaceId: 'ws_tui_test' as WorkspaceId,
      threadId: 'thread-approval' as ThreadId,
      runId: 'run-approval' as never,
      turnId: 'turn-approval' as never,
    },
    capability: { id: 'shell', version: '1', registrationDigest: 'digest' },
    normalizedResources: [],
    risk: { code: 'ask', reason: 'execute', description },
    allowOnce: { invocationId: 'invocation-approval', toolCallId: 'call-canonical' },
    revisions: {
      catalog: 1,
      effectivePolicy: 'effective',
      policyBasis: 'basis',
      ceiling: 'ceiling',
      grants: 'grants',
    },
  };
}

function approvalControlRequest(
  requestId: string,
  description: string,
  toolCallId = 'call-canonical',
): Extract<CliRuntimeEvent, { type: 'control_request'; kind: 'approval' }> {
  const presentation = approvalPresentationWithoutAlways(requestId);
  return {
    type: 'control_request',
    requestId,
    kind: 'approval',
    owningRunId: presentation.target.runId,
    owningTurnId: presentation.target.turnId,
    policyRevision: presentation.revisions.effectivePolicy,
    payload: {
      toolCallId,
      description,
      presentation: {
        ...presentation,
        allowOnce: {
          ...presentation.allowOnce,
          toolCallId,
        },
        risk: {
          ...presentation.risk,
          description,
        },
      },
    },
  };
}
