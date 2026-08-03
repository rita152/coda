// UX0 terminal-product baseline. These tests intentionally describe the observable
// pre-productization behavior across viewport, terminal-routing, text-width, color,
// classic/plain, and current rendering-cost boundaries. Later UX stages may update
// an assertion only when the corresponding contract and migration note change.

import { describe, expect, test } from 'bun:test';
import {
  BoxRenderable,
  MarkdownRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
} from '@opentui/core';
import { createTestRenderer, MockTreeSitterClient } from '@opentui/core/testing';
import type {
  AssistantMessage,
  UserMessage,
  WorkspaceId,
  WorkspaceRuntimeSnapshot,
} from '../protocol/index.js';
import { isFullScreenTuiEligible, parseFlags } from './config.js';
import type { ThreadPresentationState } from './presentation-state.js';
import { createRenderer } from './renderer.js';
import {
  createTuiScreen,
  TRANSCRIPT_REPLAY_CHUNK_MESSAGES,
} from './tui.js';
import type { TuiScreen } from './tui.js';

const MODEL = {
  provider: 'opencode-go',
  api: 'openai-chat',
  model: 'deepseek-v4-flash',
} as const;
const WORKSPACE_SNAPSHOT = {
  workspaceId: 'ws_ux_characterization' as WorkspaceId,
  permissions: {
    mode: 'interactive',
    policyRevision: 'characterization-policy-v1',
    ceiling: { revision: 'characterization-ceiling-v1', constraints: [] },
  },
} as const satisfies WorkspaceRuntimeSnapshot;

type TestRenderer = Awaited<ReturnType<typeof createTestRenderer>>;

interface View {
  readonly testRenderer: TestRenderer;
  readonly screen: TuiScreen;
  readonly highlighter: MockTreeSitterClient;
  destroy(): Promise<void>;
}

async function createView(
  width: number,
  height: number,
  color = true,
  onStreamFrame?: (taskCount: number) => void,
): Promise<View> {
  const testRenderer = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
    autoFocus: false,
  });
  const highlighter = new MockTreeSitterClient();
  const screen = await createTuiScreen(testRenderer.renderer, {
    cwd: '/工作/项目',
    version: '0.0.1',
    color,
    model: MODEL,
    workspaceSnapshot: WORKSPACE_SNAPSHOT,
    contextLimit: 128_000,
    treeSitterClient: highlighter,
    ...(onStreamFrame === undefined ? {} : { onStreamFrame }),
  });
  return {
    testRenderer,
    screen,
    highlighter,
    async destroy(): Promise<void> {
      highlighter.resolveAllHighlightOnce();
      await testRenderer.waitForVisualIdle();
      await testRenderer.renderer.idle();
      testRenderer.renderer.destroy();
      screen.destroy();
      await highlighter.destroy();
    },
  };
}

function userMessage(text: string, id = 'user-baseline'): UserMessage {
  return {
    role: 'user',
    id,
    timestamp: 1,
    content: [{ type: 'text', text }],
    source: 'prompt',
  };
}

function assistantMessage(id = 'assistant-baseline'): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 2,
    content: [],
    model: MODEL,
    stopReason: 'stop',
    usage: { input: 0, output: 0 },
  };
}

function frameLines(frame: string): string[] {
  const lines = frame.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function textContent(renderable: TextRenderable): string {
  return renderable.content.chunks.map((chunk) => chunk.text).join('');
}

function userPromptContent(renderable: BoxRenderable): string {
  const body = renderable.getChildren().find((child): child is TextRenderable =>
    child instanceof TextRenderable
  );
  if (body === undefined) throw new Error('user prompt body was not rendered');
  return textContent(body);
}

describe('UX0 terminal environment characterization', () => {
  test('40x10, 80x24, and 120x40 preserve task text, draft, footer, and cursor bounds', async () => {
    for (const [width, height] of [[40, 10], [80, 24], [120, 40]] as const) {
      const view = await createView(width, height);
      try {
        view.screen.render({
          type: 'message_start',
          message: userMessage('检查 CJK 中文与 emoji 👩‍💻🙂'),
        });
        view.screen.setInput('草稿👩‍💻🙂');
        view.screen.focusInput();
        await view.testRenderer.flush();

        const frame = view.testRenderer.captureCharFrame();
        const cursor = view.testRenderer.renderer.getCursorState();
        const input = view.testRenderer.renderer.root.findDescendantById('coda-input');
        if (input === undefined) throw new Error('TUI input was not rendered');
        expect(frameLines(frame)).toHaveLength(height);
        expect(frame).toContain('检查 CJK 中文与 emoji 👩‍💻🙂');
        expect(frame).toContain('草稿👩‍💻🙂');
        expect(frame).toContain('/工作/项目');
        expect(frame).toContain('context 0 / 128k · 0%');
        expect(cursor.visible).toBe(true);
        expect(cursor.x).toBeGreaterThanOrEqual(1);
        expect(cursor.x).toBeLessThanOrEqual(width);
        expect(cursor.y).toBeGreaterThanOrEqual(1);
        expect(cursor.y).toBeLessThanOrEqual(height);
        // 0-based cursor column = input origin + 草(2) + 稿(2) + 👩‍💻(2) + 🙂(2).
        expect(cursor.x - 1).toBe(input.screenX + 8);

        expect(frame).not.toContain('▄█▄');
        expect(frame).not.toContain('Tips for getting started');
        if (width === 40) {
          expect(frame).not.toContain('opencode-go/deepseek-v4-flash');
        } else {
          expect(frame).toContain('opencode-go/deepseek-v4-flash');
        }
      } finally {
        await view.destroy();
      }
    }
  });

  test('the main routing predicate rejects TERM=dumb and accepts tmux and SSH TTYs', () => {
    const flags = { json: false, eventFormat: 'legacy' as const, prompt: undefined };
    const terminal = (environment: Readonly<Record<string, string | undefined>>) => ({
      stdinIsTTY: true,
      stdoutIsTTY: true,
      term: environment['TERM'],
    });

    expect(isFullScreenTuiEligible(flags, terminal({ TERM: 'dumb' }))).toBe(false);
    expect(isFullScreenTuiEligible(flags, terminal({ TERM: 'screen-256color' }))).toBe(true);
    expect(isFullScreenTuiEligible(flags, terminal({ TERM: 'tmux-256color' }))).toBe(true);
    expect(
      isFullScreenTuiEligible(
        flags,
        terminal({
          TERM: 'xterm-256color',
          SSH_CONNECTION: '192.0.2.1 12345 192.0.2.2 22',
        }),
      ),
    ).toBe(true);
    expect(
      isFullScreenTuiEligible(flags, {
        stdinIsTTY: true,
        stdoutIsTTY: false,
        term: 'xterm-256color',
      }),
    ).toBe(false);
    expect(
      isFullScreenTuiEligible(
        { ...flags, json: true },
        terminal({ TERM: 'xterm-256color' }),
      ),
    ).toBe(false);
  });

  test('NO_COLOR-equivalent rendering stays transparent and --no-color remains parseable', async () => {
    expect(parseFlags(['--no-color']).noColor).toBe(true);

    // UX0 can inject only the already-resolved renderer option. UX1 adds the process-level
    // probe that proves main.ts maps both NO_COLOR and --no-color to this state.
    const view = await createView(80, 24, false);
    try {
      view.screen.render({
        type: 'message_start',
        message: userMessage('mono 中文 🙂'),
      });
      await view.testRenderer.flush();
      const transparent = RGBA.fromValues(0, 0, 0, 0).toInts();
      const spans = view.testRenderer.captureSpans();
      for (const row of spans.lines) {
        for (const span of row.spans) {
          expect(span.bg.toInts()).toEqual(transparent);
          if (span.text.trim() !== '') expect(span.fg.intent).toBe('default');
        }
      }
    } finally {
      await view.destroy();
    }
  });

  test('plain output is append-only and strips terminal-control injection at the shared boundary', async () => {
    let output = '';
    const renderer = createRenderer(
      {
        enqueue: (chunk) => {
          output += chunk;
        },
        drain: () => Promise.resolve(),
      },
      { color: false, interactive: false },
    );
    const injected = '\x1b]52;c;UX0_BASELINE_SECRET\x07visible';
    renderer.render({
      type: 'message_start',
      message: userMessage(injected),
    });
    await renderer.drain();

    // UX1 migration: classic/plain now consume the same sanitizer contract as OpenTUI.
    expect(output).not.toContain('\x1b]52;c;UX0_BASELINE_SECRET\x07');
    expect(output).not.toContain('UX0_BASELINE_SECRET');
    expect(output).toContain('visible');
    expect(output).not.toContain('\x1b[?1049h');
  });
});

describe('UX4 rendering performance gates', () => {
  test('keeps input under 100ms, coalesces 10k deltas, and segments 1k history', async () => {
    const startedAt = performance.now();
    const interactionView = await createView(80, 24);
    try {
      await interactionView.testRenderer.flush();
      const firstFrameMs = performance.now() - startedAt;

      interactionView.screen.focusInput();
      const inputStartedAt = performance.now();
      await interactionView.testRenderer.mockInput.typeText('输入反馈');
      await interactionView.testRenderer.flush();
      const inputFeedbackMs = performance.now() - inputStartedAt;
      expect(interactionView.testRenderer.captureCharFrame()).toContain('输入反馈');

      expect(firstFrameMs).toBeLessThan(2_000);
      expect(inputFeedbackMs).toBeLessThan(100);
    } finally {
      await interactionView.destroy();
    }

    let streamFrames = 0;
    const deltaView = await createView(80, 24, true, () => {
      streamFrames++;
    });
    try {
      const assistant = assistantMessage('assistant-deltas');
      deltaView.screen.render({ type: 'message_start', message: assistant });
      const partial: AssistantMessage = {
        ...assistant,
        content: [{ type: 'text', text: '' }],
      };
      let expected = '';
      const deltaStartedAt = performance.now();
      for (let index = 0; index < 10_000; index++) {
        const delta = String(index % 10);
        expected += delta;
        deltaView.screen.render({
          type: 'message_update',
          messageId: assistant.id,
          event: {
            type: 'text_delta',
            contentIndex: 0,
            delta,
            partial,
          },
        });
      }
      await deltaView.testRenderer.flush();
      const tenThousandDeltaMs = performance.now() - deltaStartedAt;

      const markdown = deltaView.testRenderer.renderer.root
        .findDescendantById('coda-transcript')
        ?.getChildren()
        .flatMap((child) => child.getChildren())
        .find((child): child is MarkdownRenderable => child instanceof MarkdownRenderable);
      if (markdown === undefined) throw new Error('assistant Markdown was not rendered');
      expect(markdown.content).toBe(expected);
      expect(streamFrames).toBeLessThanOrEqual(2);
      expect(tenThousandDeltaMs).toBeLessThan(1_000);
    } finally {
      await deltaView.destroy();
    }

    const transcriptView = await createView(80, 24);
    try {
      const transcript = Array.from({ length: 1_000 }, (_, index) =>
        userMessage(`历史 ${index} 🙂`, `history-${index}`),
      );
      const transcriptStartedAt = performance.now();
      transcriptView.screen.replayTranscript(transcript);
      await transcriptView.testRenderer.flush();
      const thousandMessageReplayMs = performance.now() - transcriptStartedAt;

      const transcriptRenderable = transcriptView.testRenderer.renderer.root
        .findDescendantById('coda-transcript');
      if (!(transcriptRenderable instanceof ScrollBoxRenderable)) {
        throw new Error('transcript ScrollBox was not rendered');
      }
      const children = transcriptRenderable.getChildren();
      expect(children.length).toBeLessThanOrEqual(TRANSCRIPT_REPLAY_CHUNK_MESSAGES + 1);
      expect(textContent(children[0] as TextRenderable)).toContain(
        `last ${TRANSCRIPT_REPLAY_CHUNK_MESSAGES}/1000`,
      );
      const last = children.at(-1);
      if (!(last instanceof BoxRenderable)) throw new Error('latest history row was not a prompt');
      expect(userPromptContent(last)).toBe('历史 999 🙂');
      expect(transcriptView.testRenderer.captureCharFrame()).toContain('历史 999 🙂');

      for (let page = 0; page < 8; page++) {
        transcriptView.screen.scrollPage(-1);
        await transcriptView.testRenderer.flush();
      }
      const complete = transcriptRenderable.getChildren();
      expect(complete).toHaveLength(1_001);
      for (const [childIndex, messageIndex] of [[1, 0], [501, 500], [1_000, 999]] as const) {
        const child = complete[childIndex];
        if (!(child instanceof BoxRenderable)) throw new Error('history row was not a prompt');
        expect(userPromptContent(child)).toBe(`历史 ${messageIndex} 🙂`);
      }

      // The first interactive tail stays bounded; explicit PageUp proves every segment remains
      // reachable in original order without asking Runtime for a second transcript authority.
      expect(thousandMessageReplayMs).toBeLessThan(5_000);
    } finally {
      await transcriptView.destroy();
    }

    const anchorView = await createView(80, 24);
    try {
      const transcript = Array.from({ length: 1_000 }, (_, index) =>
        userMessage(`anchor history ${index}`, `anchor-history-${index}`),
      );
      anchorView.screen.replayTranscript(transcript);
      await anchorView.testRenderer.flush();
      expect(
        anchorView.testRenderer.renderer.root
          .findDescendantById('coda-transcript')
          ?.getChildren().length,
      ).toBeLessThanOrEqual(TRANSCRIPT_REPLAY_CHUNK_MESSAGES + 1);
      anchorView.screen.restorePresentation({
        workspaceId: 'ws_anchor_performance' as WorkspaceId,
        threadId: 'thread-anchor-performance' as never,
        draft: '',
        scrollAnchor: {
          blockKey: 'message:anchor-history-100',
          logicalOffset: 0,
          fallbackBlockKeys: [],
          observedHighWaterSeq: 0,
        },
        unreadAfterSeq: 0,
        expandedBlocks: [],
        vimEnabled: false,
        updatedAt: 1,
      } satisfies ThreadPresentationState);
      await anchorView.testRenderer.flush();
      await anchorView.testRenderer.flush();
      expect(anchorView.testRenderer.captureCharFrame()).toContain('anchor history 100');
      expect(anchorView.testRenderer.captureCharFrame()).not.toContain(
        'saved scroll anchor was compacted',
      );
    } finally {
      await anchorView.destroy();
    }
  }, 45_000);
});
