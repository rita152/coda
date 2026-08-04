import { describe, expect, test } from 'bun:test';
import type {
  AssistantMessage,
  EventEnvelope,
  ProviderEvent,
  RunId,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import {
  decodeDurableCommitRecord,
  emptyJournalMessageCodecState,
  encodeDurableJournalRecord,
} from './thread-journal-codec.js';
import type { ThreadCommitRecord } from './thread-journal-records.js';

const WORKSPACE_ID = 'workspace-compact-codec' as WorkspaceId;
const THREAD_ID = 'thread-compact-codec' as ThreadId;
const RUN_ID = 'run-compact-codec' as RunId;
const TURN_ID = 'turn-compact-codec' as TurnId;

describe('v3 compact journal codec', () => {
  test('round-trips every public envelope field for text, reasoning, and tool blocks', () => {
    const messageId = 'assistant-compact-codec';
    const start = assistant(messageId, []);
    const textStart = assistant(messageId, [{ type: 'text', text: '', phase: 'commentary' }]);
    const textDelta = assistant(messageId, [{ type: 'text', text: '你🙂', phase: 'commentary' }]);
    const textEnd = assistant(messageId, [{ type: 'text', text: '你🙂', phase: 'final_answer' }]);
    const reasoningStart = assistant(messageId, [
      textEnd.content[0]!,
      { type: 'reasoning', text: '', kind: 'summary' },
    ]);
    const reasoningDelta = assistant(messageId, [
      textEnd.content[0]!,
      { type: 'reasoning', text: '思考', kind: 'content', signature: 'sig-1' },
    ]);
    const reasoningEnd = assistant(messageId, [
      textEnd.content[0]!,
      { type: 'reasoning', text: '思考', kind: 'summary', signature: 'sig-final' },
    ]);
    const toolStart = assistant(messageId, [
      ...reasoningEnd.content,
      { type: 'tool_call', id: 'call-1', name: 'read', arguments: {}, rawArguments: '' },
    ]);
    const toolDelta = assistant(messageId, [
      ...reasoningEnd.content,
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
        arguments: { path: '你🙂.ts' },
        rawArguments: '{"path":"你🙂.ts"}',
      },
    ]);
    const terminal = { ...toolDelta, stopReason: 'tool_calls' as const, usage: { input: 8, output: 5 } };
    const providerEvents: ProviderEvent[] = [
      { type: 'text_start', contentIndex: 0, partial: textStart },
      { type: 'text_delta', contentIndex: 0, delta: '你🙂', partial: textDelta },
      { type: 'text_end', contentIndex: 0, content: '你🙂', partial: textEnd },
      { type: 'reasoning_start', contentIndex: 1, partial: reasoningStart },
      { type: 'reasoning_delta', contentIndex: 1, delta: '思考', partial: reasoningDelta },
      { type: 'reasoning_end', contentIndex: 1, content: '思考', partial: reasoningEnd },
      { type: 'tool_call_start', contentIndex: 2, partial: toolStart },
      {
        type: 'tool_call_delta',
        contentIndex: 2,
        delta: '{"path":"你🙂.ts"}',
        partial: toolDelta,
      },
      {
        type: 'tool_call_end',
        contentIndex: 2,
        toolCall: toolDelta.content[2] as Extract<typeof toolDelta.content[number], { type: 'tool_call' }>,
        partial: toolDelta,
      },
    ];
    const events = [
      { type: 'message_start' as const, message: start },
      ...providerEvents.map((event) => ({ type: 'message_update' as const, messageId, event })),
      { type: 'message_end' as const, message: terminal },
    ];
    const records = events.map((event, index) => commit(index + 1, event));
    const encodeState = emptyJournalMessageCodecState();
    const durable = records.map((record) => encodeDurableJournalRecord(record, encodeState));

    const physical = JSON.stringify(durable);
    expect(physical).not.toContain('"partial"');
    expect(physical).toContain('"delta":"你🙂"');

    const decodeState = emptyJournalMessageCodecState();
    const decoded = durable.map((record) => {
      if (record.type !== 'commit') throw new Error('expected commit');
      return decodeDurableCommitRecord(record, WORKSPACE_ID, THREAD_ID, decodeState);
    });
    expect(decoded).toEqual(records);
  });

  test('rejects a public partial that is not the fold of its durable delta', () => {
    const messageId = 'assistant-invalid-partial';
    const state = emptyJournalMessageCodecState();
    encodeDurableJournalRecord(commit(1, {
      type: 'message_start',
      message: assistant(messageId, []),
    }), state);
    encodeDurableJournalRecord(commit(2, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_start',
        contentIndex: 0,
        partial: assistant(messageId, [{ type: 'text', text: '' }]),
      },
    }), state);

    expect(() => encodeDurableJournalRecord(commit(3, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'a',
        partial: assistant(messageId, [{ type: 'text', text: 'different' }]),
      },
    }), state)).toThrow(/deterministic delta fold/);
  });

  test('accepts a message_start snapshot that already exposes the first empty provider block', () => {
    const messageId = 'assistant-preseeded-block';
    const empty = assistant(messageId, [{ type: 'text', text: '' }]);
    const updated = assistant(messageId, [{ type: 'text', text: 'live' }]);
    const records = [
      commit(1, { type: 'message_start', message: empty }),
      commit(2, {
        type: 'message_update',
        messageId,
        event: { type: 'text_start', contentIndex: 0, partial: empty },
      }),
      commit(3, {
        type: 'message_update',
        messageId,
        event: { type: 'text_delta', contentIndex: 0, delta: 'live', partial: updated },
      }),
      commit(4, {
        type: 'message_update',
        messageId,
        event: { type: 'text_end', contentIndex: 0, content: 'live', partial: updated },
      }),
      commit(5, { type: 'message_end', message: updated }),
    ];
    const encodeState = emptyJournalMessageCodecState();
    const durable = records.map((record) => encodeDurableJournalRecord(record, encodeState));
    const decodeState = emptyJournalMessageCodecState();
    expect(durable.map((record) => {
      if (record.type !== 'commit') throw new Error('expected commit');
      return decodeDurableCommitRecord(record, WORKSPACE_ID, THREAD_ID, decodeState);
    })).toEqual(records);
  });

  test('rejects an assistant terminal message that disagrees with reconstructed content', () => {
    const messageId = 'assistant-invalid-terminal';
    const state = emptyJournalMessageCodecState();
    encodeDurableJournalRecord(commit(1, {
      type: 'message_start',
      message: assistant(messageId, []),
    }), state);
    encodeDurableJournalRecord(commit(2, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_start',
        contentIndex: 0,
        partial: assistant(messageId, [{ type: 'text', text: '' }]),
      },
    }), state);
    encodeDurableJournalRecord(commit(3, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'durable',
        partial: assistant(messageId, [{ type: 'text', text: 'durable' }]),
      },
    }), state);

    expect(() => encodeDurableJournalRecord(commit(4, {
      type: 'message_end',
      message: assistant(messageId, [{ type: 'text', text: 'different' }]),
    }), state)).toThrow(/does not match reconstructed partial/);
  });

  test('rejects a block end whose public terminal field differs from its partial', () => {
    const messageId = 'assistant-invalid-block-end';
    const state = emptyJournalMessageCodecState();
    encodeDurableJournalRecord(commit(1, {
      type: 'message_start',
      message: assistant(messageId, []),
    }), state);
    encodeDurableJournalRecord(commit(2, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_start',
        contentIndex: 0,
        partial: assistant(messageId, [{ type: 'text', text: '' }]),
      },
    }), state);

    expect(() => encodeDurableJournalRecord(commit(3, {
      type: 'message_update',
      messageId,
      event: {
        type: 'text_end',
        contentIndex: 0,
        content: 'public terminal',
        partial: assistant(messageId, [{ type: 'text', text: 'different partial' }]),
      },
    }), state)).toThrow(/does not match partial|block end content differs/);
  });

  test('rejects message_end while a provider block lifecycle is still open', () => {
    const messageId = 'assistant-open-block';
    const state = emptyJournalMessageCodecState();
    const empty = assistant(messageId, [{ type: 'text', text: '' }]);
    encodeDurableJournalRecord(commit(1, {
      type: 'message_start',
      message: assistant(messageId, []),
    }), state);
    encodeDurableJournalRecord(commit(2, {
      type: 'message_update',
      messageId,
      event: { type: 'text_start', contentIndex: 0, partial: empty },
    }), state);

    expect(() => encodeDurableJournalRecord(commit(3, {
      type: 'message_end',
      message: empty,
    }), state)).toThrow(/incomplete provider block lifecycle/);
  });
});

function commit(
  seq: number,
  event: EventEnvelope['event'],
): ThreadCommitRecord {
  return {
    type: 'commit',
    firstSeq: seq,
    envelopes: [{
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      runId: RUN_ID,
      turnId: TURN_ID,
      seq,
      timestamp: seq,
      event,
    }],
  };
}

function assistant(
  id: string,
  content: AssistantMessage['content'],
): AssistantMessage {
  return {
    role: 'assistant',
    id,
    timestamp: 1,
    content,
    model: { provider: 'faux', api: 'faux', model: 'codec' },
    stopReason: 'stop',
    usage: { input: 0, output: 0 },
  };
}
