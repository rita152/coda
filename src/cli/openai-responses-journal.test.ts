import { expect, test } from 'bun:test';
import type {
  AssistantMessage,
  EventEnvelope,
  ModelRef,
  ProviderEvent,
  RunId,
  RuntimeEvent,
  ThreadId,
  TurnId,
  WorkspaceId,
} from '../protocol/index.js';
import { consumeResponsesStreamForTest } from '../providers/openai-responses/index.js';
import {
  decodeDurableEventEnvelope,
  emptyJournalMessageCodecState,
  encodeDurableEventEnvelope,
} from '../session/thread-journal-codec.js';

const REF: ModelRef = {
  provider: 'openai',
  api: 'openai-responses',
  model: 'gpt-test',
};
const WORKSPACE_ID = 'workspace-responses-codec' as WorkspaceId;
const THREAD_ID = 'thread-responses-codec' as ThreadId;
const RUN_ID = 'run-responses-codec' as RunId;
const TURN_ID = 'turn-responses-codec' as TurnId;

async function* fixtureEvents(): AsyncIterable<unknown> {
  const fixture = new URL(
    '../providers/openai-responses/__fixtures__/reasoning.jsonl',
    import.meta.url,
  );
  const lines = (await Bun.file(fixture).text()).split('\n').filter((line) => line.trim() !== '');
  for (const line of lines) yield JSON.parse(line) as unknown;
}

function isBlockEvent(
  event: ProviderEvent,
): event is Extract<ProviderEvent, { contentIndex: number }> {
  return 'contentIndex' in event;
}

async function collectResponsesFixture(): Promise<{
  events: ProviderEvent[];
  final: AssistantMessage;
}> {
  const stream = consumeResponsesStreamForTest(REF, () => Promise.resolve(fixtureEvents()));
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
}

test('OpenAI Responses reasoning stream round-trips through the compact journal codec', async () => {
  const { events, final } = await collectResponsesFixture();
  const start = events[0];
  if (start?.type !== 'start') throw new Error('expected provider start event');

  const runtimeEvents: RuntimeEvent[] = [
    { type: 'message_start', message: start.partial },
    ...events.filter(isBlockEvent).map((event) => ({
      type: 'message_update' as const,
      messageId: start.partial.id,
      event,
    })),
    { type: 'message_end', message: final },
  ];
  const envelopes: EventEnvelope[] = runtimeEvents.map((event, index) => ({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    seq: index + 1,
    timestamp: index + 1,
    event,
  }));

  const encodeState = emptyJournalMessageCodecState();
  const durable = envelopes.map((envelope) => encodeDurableEventEnvelope(envelope, encodeState));
  const decodeState = emptyJournalMessageCodecState();
  expect(durable.map((envelope) => decodeDurableEventEnvelope(
    envelope,
    WORKSPACE_ID,
    THREAD_ID,
    decodeState,
  ))).toEqual(envelopes);
});
