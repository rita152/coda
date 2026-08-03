import { describe, expect, test } from 'bun:test';
import { ProviderEventStream } from '../protocol/index.js';
import type { AssistantMessage, ModelConfig, StreamFn, ThreadUsage } from '../protocol/index.js';
import type { ThreadDriverCheckpoint } from './thread-runtime-ports.js';
import { RuntimeThreadExecution } from './runtime-thread-execution.js';
import type { RuntimeThreadExecutionEvent } from './runtime-thread-execution.js';

const MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'checkpoint-usage' },
};

const TRANSCRIPT_MESSAGE: AssistantMessage = {
  role: 'assistant',
  id: 'assistant-from-transcript',
  timestamp: 1,
  content: [{ type: 'text', text: 'committed' }],
  model: MODEL.ref,
  stopReason: 'stop',
  usage: { input: 1, output: 2 },
};

const CHECKPOINT_USAGE: ThreadUsage = {
  lastTurn: { input: 7, output: 8, reasoning: 3 },
  cumulative: { input: 100, output: 50, reasoning: 9, costUSD: 1.25 },
  turns: 9,
  contextTokens: 77,
};

const UNUSED_STREAM: StreamFn = () => new ProviderEventStream();

describe('RuntimeThreadExecution checkpoint recovery', () => {
  test('restores usage only from the canonical checkpoint projection', async () => {
    const checkpoint: ThreadDriverCheckpoint = {
      frontend: {
        model: MODEL.ref,
        transcript: [TRANSCRIPT_MESSAGE],
        usage: CHECKPOINT_USAGE,
        queues: { steering: [], followUp: [] },
        plan: [],
        pendingControls: [],
      },
      execution: {},
    };
    const execution = new RuntimeThreadExecution({
      model: MODEL,
      checkpoint,
      runtimeTurnProvider: {
        capture: async () => { throw new Error('unused runtime turn'); },
      },
      compactionStreamFn: UNUSED_STREAM,
      eventSink: async () => {},
      truncationScope: 'checkpoint-usage-test',
    });

    expect(execution.usage()).toEqual(CHECKPOINT_USAGE);
    await execution.close();
  });

  test('uses one priced assistant payload across message, turn, and agent terminal events', async () => {
    const assistant: AssistantMessage = {
      role: 'assistant',
      id: 'assistant-priced',
      timestamp: 2,
      content: [{ type: 'text', text: 'priced response' }],
      model: MODEL.ref,
      stopReason: 'stop',
      usage: { input: 1_000, output: 2_000 },
    };
    const streamFn: StreamFn = () => {
      const stream = new ProviderEventStream();
      stream.push({ type: 'start', partial: assistant });
      stream.push({ type: 'done', message: assistant });
      stream.end(assistant);
      return stream;
    };
    const events: RuntimeThreadExecutionEvent[] = [];
    const execution = new RuntimeThreadExecution({
      model: MODEL,
      checkpoint: {
        frontend: {
          model: MODEL.ref,
          transcript: [],
          usage: {
            cumulative: { input: 0, output: 0 },
            turns: 0,
            contextTokens: 0,
          },
          queues: { steering: [], followUp: [] },
          plan: [],
          pendingControls: [],
        },
        execution: {},
      },
      runtimeTurnProvider: {
        capture: async () => ({
          streamFn,
          assemble: (messages) => ({
            ok: true as const,
            context: { systemPrompt: 'test', messages: [...messages], tools: [] },
          }),
          prepareToolCall: async () => { throw new Error('unexpected tool call'); },
        }),
      },
      compactionStreamFn: UNUSED_STREAM,
      eventSink: async (batch) => { events.push(...batch); },
      truncationScope: 'assistant-pricing-test',
      pricing: { inputPer1M: 1, outputPer1M: 2 },
    });

    try {
      await execution.prompt('price this');
      const messageEnd = events.find((event) =>
        event.type === 'message_end' && event.message.role === 'assistant');
      const turnEnd = events.find((event) => event.type === 'turn_end');
      const agentEnd = events.find((event) => event.type === 'agent_end');
      if (messageEnd?.type !== 'message_end' || messageEnd.message.role !== 'assistant') {
        throw new Error('assistant message_end missing');
      }
      if (turnEnd?.type !== 'turn_end') throw new Error('turn_end missing');
      if (agentEnd?.type !== 'agent_end') throw new Error('agent_end missing');
      const terminalAssistant = agentEnd.messages.find((message) => message.role === 'assistant');
      if (terminalAssistant?.role !== 'assistant') throw new Error('agent_end assistant missing');

      expect(messageEnd.message.usage.costUSD).toBe(0.005);
      expect(turnEnd.message).toEqual(messageEnd.message);
      expect(terminalAssistant).toEqual(messageEnd.message);
      expect(execution.usage()).toMatchObject({
        cumulative: { input: 1_000, output: 2_000, costUSD: 0.005 },
        turns: 1,
      });
      expect(events.filter((event) => event.type === 'usage_update')).toHaveLength(1);
    } finally {
      await execution.close();
    }
  });
});
