import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Context, ModelConfig, UserMessage } from '../protocol/index.js';
import { CompactionCoordinator } from './compaction-coordinator.js';

const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'compact' },
  limits: { context: 1_000, output: 100 },
  defaults: { maxOutputTokens: 100 },
};

const user = (id: string): UserMessage => ({
  role: 'user',
  id,
  timestamp: 0,
  source: 'prompt',
  content: [{ type: 'text', text: id }],
});

const overflow: AssistantMessage = {
  role: 'assistant',
  id: 'overflow',
  timestamp: 0,
  content: [],
  model: MODEL.ref,
  stopReason: 'error',
  usage: { input: 0, output: 0 },
  errorDetails: { kind: 'overflow', retryable: false },
};

describe('CompactionCoordinator', () => {
  test('owns threshold state and applies an immutable folded transcript view', () => {
    const coordinator = new CompactionCoordinator({ threshold: 0.8 });
    expect(coordinator.shouldStopAfterTurn(MODEL, 721)).toBe(true);
    expect(coordinator.decideRunEnd('completed', undefined, MODEL)).toEqual({
      kind: 'compact',
      reason: 'threshold',
      hardTruncate: false,
    });
    expect(coordinator.decideRunEnd('completed', undefined, MODEL)).toEqual({ kind: 'none' });

    coordinator.install({
      id: 'cmp',
      timestamp: 1,
      tailStartId: 'tail',
      summary: 'summary',
    });
    const context: Context = {
      systemPrompt: 'system',
      tools: [],
      messages: [user('prefix'), user('tail')],
    };
    const transformed = coordinator.transform(context);
    expect(transformed.messages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^u_summary_/),
      'tail',
    ]);
    expect(context.messages.map((message) => message.id)).toEqual(['prefix', 'tail']);
  });

  test('escalates repeated overflow to summarize, hard truncate, then fatal and resets on success', () => {
    const coordinator = new CompactionCoordinator();
    expect(coordinator.decideRunEnd('error', overflow, MODEL)).toMatchObject({
      kind: 'compact',
      reason: 'overflow',
      hardTruncate: false,
    });
    expect(coordinator.decideRunEnd('error', overflow, MODEL)).toMatchObject({
      kind: 'compact',
      hardTruncate: true,
    });
    expect(coordinator.decideRunEnd('error', overflow, MODEL).kind).toBe('fatal');
    coordinator.observeSuccessfulTurn();
    expect(coordinator.decideRunEnd('error', overflow, MODEL)).toMatchObject({
      kind: 'compact',
      hardTruncate: false,
    });
  });
});
