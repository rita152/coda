// Phase-2 direct Session composition: per-backend lease/isolation and asynchronous cursor pumps.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { SessionEvent } from '../src/session/index.js';
import type { UserMessage } from '../src/protocol/index.js';
import { PROTOCOL_VERSION, Session } from '../src/session/index.js';
import { createFauxStreamFn, createGate } from '../src/providers/faux/index.js';
import { TEST_MODEL } from './helpers/agent-harness.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'coda-standalone-host-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function options(streamFn: ReturnType<typeof createFauxStreamFn>) {
  return {
    dir: root,
    compaction: { enabled: false },
    agentConfig: {
      streamFn,
      model: TEST_MODEL,
      tools: [],
      systemPrompt: 'standalone host test',
      cwd: root,
    },
  };
}

describe('StandaloneSessionHost writer isolation', () => {
  test('different session ids in one cwd run concurrently with independent providers', async () => {
    const gateA = createGate();
    const gateB = createGate();
    let enterA!: () => void;
    let enterB!: () => void;
    const enteredA = new Promise<void>((resolve) => { enterA = resolve; });
    const enteredB = new Promise<void>((resolve) => { enterB = resolve; });
    const streamA = createFauxStreamFn({
      turns: [{ onRequest: () => enterA(), events: [{ kind: 'gate', gate: gateA }, { kind: 'text', text: 'A' }] }],
    });
    const streamB = createFauxStreamFn({
      turns: [{ onRequest: () => enterB(), events: [{ kind: 'gate', gate: gateB }, { kind: 'text', text: 'B' }] }],
    });
    const sessionA = await Session.create(options(streamA));
    const sessionB = await Session.create(options(streamB));

    const runA = sessionA.prompt('alpha');
    const runB = sessionB.prompt('beta');
    await Promise.all([enteredA, enteredB]);
    expect(streamA.calls).toHaveLength(1);
    expect(streamB.calls).toHaveLength(1);

    gateA.open();
    gateB.open();
    await Promise.all([runA, runB]);
    expect(sessionA.messages.at(-1)?.role === 'assistant'
      ? sessionA.messages.at(-1)?.content
      : []).toEqual([{ type: 'text', text: 'A' }]);
    expect(sessionB.messages.at(-1)?.role === 'assistant'
      ? sessionB.messages.at(-1)?.content
      : []).toEqual([{ type: 'text', text: 'B' }]);
    await Promise.all([sessionA.close(), sessionB.close()]);
  });

  test('same backend has one stable writer and releases it on close', async () => {
    const seed = await Session.create(options(createFauxStreamFn({ turns: [] })));
    const id = seed.id;
    await seed.close();

    const first = await Session.resume(id, options(createFauxStreamFn({ turns: [] })));
    await expect(Session.resume(id, options(createFauxStreamFn({ turns: [] })))).rejects.toMatchObject({
      code: 'session_in_use',
    });
    await first.close();
    const successor = await Session.resume(id, options(createFauxStreamFn({ turns: [] })));
    await successor.close();
  });

  test('symlink aliases cannot acquire a second writer for the same physical backend', async () => {
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, 'dir');
    const stream = createFauxStreamFn({ turns: [] });
    const seed = await Session.create({ ...options(stream), dir: actual });
    const id = seed.id;
    await seed.close();
    const owner = await Session.resume(id, { ...options(stream), dir: actual });
    await expect(Session.resume(id, { ...options(stream), dir: alias })).rejects.toMatchObject({
      code: 'session_in_use',
    });
    await owner.close();
  });

  test('synchronous setModel immediately selects the exact full config for the next prompt', async () => {
    const stream = createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'selected' }] }] });
    const session = await Session.create(options(stream));
    const selected = {
      ...TEST_MODEL,
      ref: { provider: 'faux', api: 'faux', model: 'selected-model' },
      baseURL: 'https://example.invalid/v1',
      apiKey: 'attachment-secret',
      headers: { 'x-attachment': 'exact' },
      compat: { dialect: 'selected' },
      defaults: { temperature: 0.25, maxOutputTokens: 321 },
    };

    expect(() => session.setModel(selected)).not.toThrow();
    expect(session.currentModel()).toEqual(selected.ref);
    await session.prompt('use selected config');
    expect(stream.calls[0]?.model).toEqual(selected);
    await session.close();
  });

  test('waitForIdle includes the facade activity boundary after a retry successor settles', async () => {
    const stream = createFauxStreamFn({
      turns: [
        {
          error: {
            message: 'retry once',
            details: { kind: 'http', status: 500, retryable: true },
          },
        },
        { events: [{ kind: 'text', text: 'recovered' }] },
      ],
    });
    const session = await Session.create({
      ...options(stream),
      retry: {
        maxAttempts: 1,
        jitter: () => 0,
        sleep: async () => false,
      },
    });

    const rootRun = session.prompt('go');
    await session.waitForIdle();

    expect(session.interactionState()).toBe('idle');
    expect(stream.calls).toHaveLength(2);
    await rootRun;
    await session.close();
  });

  test('resume repairs a canonical message suffix missing from the v1 mirror', async () => {
    const stream = createFauxStreamFn({ turns: [{ events: [{ kind: 'text', text: 'durable' }] }] });
    const session = await Session.create(options(stream));
    await session.prompt('persist me');
    const id = session.id;
    const expected = session.messages;
    await session.close();

    const mirrorPath = path.join(root, `${id}.jsonl`);
    const records = readFileSync(mirrorPath, 'utf8').trimEnd().split('\n');
    const lastMessage = records.findLastIndex((line) =>
      (JSON.parse(line) as { readonly type?: string }).type === 'message');
    if (lastMessage < 0) throw new Error('test fixture has no v1 message record');
    records.splice(lastMessage, 1);
    writeFileSync(mirrorPath, `${records.join('\n')}\n`);

    const resumed = await Session.resume(id, options(createFauxStreamFn({ turns: [] })));
    expect(resumed.messages).toEqual(expected);
    expect(readFileSync(mirrorPath, 'utf8').split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly type?: string })
      .filter((record) => record.type === 'message')).toHaveLength(expected.length);
    await resumed.close();
  });

  test('compacted resume uses one stable synthetic summary in canonical seed and execution', async () => {
    const id = 'compacted-stable-summary';
    const compactionTimestamp = 1_753_518_800_000;
    const records = [
      {
        type: 'meta',
        version: 1,
        protocolVersion: PROTOCOL_VERSION,
        id,
        createdAt: 1,
        cwd: root,
        model: TEST_MODEL.ref,
      },
      {
        type: 'message',
        message: {
          role: 'user',
          id: 'u_compacted_prefix',
          timestamp: 1,
          content: [{ type: 'text', text: 'prefix' }],
          source: 'prompt',
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          id: 'a_compacted_tail',
          timestamp: 2,
          content: [{ type: 'text', text: 'tail' }],
          model: TEST_MODEL.ref,
          stopReason: 'stop',
          usage: { input: 1, output: 1 },
        },
      },
      {
        type: 'compaction',
        id: 'cmp_stable_summary',
        timestamp: compactionTimestamp,
        tailStartId: 'a_compacted_tail',
        summary: 'stable summary',
      },
    ];
    writeFileSync(
      path.join(root, `${id}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const first = await Session.resume(id, options(createFauxStreamFn({ turns: [] })));
    const firstMessages = first.messages;
    const sidecarFile = readdirSync(path.join(root, '.standalone-runtime'))
      .find((file) => file.endsWith('.jsonl'));
    if (sidecarFile === undefined) throw new Error('test fixture has no standalone sidecar');
    const seed = readFileSync(path.join(root, '.standalone-runtime', sidecarFile), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { readonly type?: string; readonly transcript?: unknown })
      .find((record) => record.type === 'legacy_seed');

    expect(firstMessages[0]).toMatchObject({
      role: 'user',
      id: expect.stringMatching(/^u_summary_[0-9a-f]{64}$/),
      timestamp: compactionTimestamp,
      source: 'synthetic',
    });
    expect(seed?.transcript).toEqual(firstMessages);
    await first.close();

    const second = await Session.resume(id, options(createFauxStreamFn({ turns: [] })));
    expect(second.messages).toEqual(firstMessages);
    await second.close();
  });

  test('back-to-back aborts do not poison the host when the sampled run becomes stale', async () => {
    const providerGate = createGate();
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const session = await Session.create(options(createFauxStreamFn({
      turns: [{
        onRequest: () => entered(),
        events: [{ kind: 'gate', gate: providerGate }, { kind: 'text', text: 'late' }],
      }],
    })));
    const run = session.prompt('abort me');
    await providerEntered;
    session.abort();
    session.abort();
    providerGate.open();
    await run.catch(() => undefined);
    await session.waitForIdle();
    expect(session.interactionState()).toBe('idle');
    await session.close();
  });

  test('close waits for a normal active run instead of aborting it', async () => {
    const providerGate = createGate();
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const session = await Session.create(options(createFauxStreamFn({
      turns: [{
        onRequest: () => entered(),
        events: [{ kind: 'gate', gate: providerGate }, { kind: 'text', text: 'completed naturally' }],
      }],
    })));
    const reasons: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'agent_end') reasons.push(event.reason);
    });
    const run = session.prompt('finish before close');
    await providerEntered;
    let closed = false;
    const closing = session.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    providerGate.open();
    await Promise.all([run, closing]);
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'completed naturally' }],
    });
    expect(reasons).toEqual(['completed']);
  });

  test('steer/followUp preserve complete UserMessage identity and image content', async () => {
    const providerGate = createGate();
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const stream = createFauxStreamFn({
      turns: [
        {
          onRequest: () => entered(),
          events: [{ kind: 'text', text: 'first' }, { kind: 'gate', gate: providerGate }],
        },
        { events: [{ kind: 'text', text: 'second' }] },
        { events: [{ kind: 'text', text: 'third' }] },
      ],
    });
    const base = options(stream);
    const session = await Session.create({
      ...base,
      agentConfig: { ...base.agentConfig, shouldStopAfterTurn: async () => true },
    });
    const steering: UserMessage = {
      role: 'user',
      id: 'u_standalone_image_only',
      timestamp: 123,
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      source: 'prompt',
    };
    const followUp: UserMessage = {
      role: 'user',
      id: 'u_standalone_multipart',
      timestamp: 456,
      content: [
        { type: 'text', text: 'keep text' },
        { type: 'image', data: 'bW9yZS1pbWFnZQ==', mimeType: 'image/jpeg' },
      ],
      source: 'steering',
    };

    const first = session.prompt('start');
    await providerEntered;
    session.steer(steering);
    session.followUp(followUp);
    providerGate.open();
    await first;
    await session.continue();
    await session.continue();

    expect((stream.calls[1]?.context.messages ?? [])
      .find((message) => message.id === steering.id)).toEqual({
      ...steering,
      source: 'steering',
    });
    expect((stream.calls[2]?.context.messages ?? [])
      .find((message) => message.id === followUp.id)).toEqual({
      ...followUp,
      source: 'follow_up',
    });
    await session.close();
  });
});

describe('Session post-commit observer FIFO pump', () => {
  test(
    'slow listener and rejection never backpressure a run; later events remain ordered',
    async () => {
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const listenerGate = createGate();
      const session = await Session.create(options(createFauxStreamFn({
        turns: [{ events: [{ kind: 'text', text: 'x'.repeat(600), chunkSize: 1 }] }],
      })));
      const observed: SessionEvent['type'][] = [];
      let first = true;
      let resolveEnd!: () => void;
      const sawEnd = new Promise<void>((resolve) => { resolveEnd = resolve; });
      session.subscribe(async (event) => {
        observed.push(event.type);
        if (first) {
          first = false;
          await listenerGate.opened;
          throw new Error('observer failure');
        }
        if (event.type === 'agent_end') resolveEnd();
      });

      await session.prompt('go');
      expect(observed).toEqual(['agent_start']);
      expect(existsSync(path.join(root, '.session-events'))).toBe(false);
      listenerGate.open();
      await sawEnd;
      expect(observed.at(-1)).toBe('agent_end');
      expect(observed).toContain('usage_update');
      expect(observed.filter((type) => type === 'message_update').length).toBeGreaterThan(256);
      expect(diagnostic).toHaveBeenCalled();
      await session.close();
    },
    15_000,
  );

  test('close releases observer cursors without waiting for a blocked listener', async () => {
    const listenerGate = createGate();
    let entered!: () => void;
    const listenerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const session = await Session.create(options(createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'done' }] }],
    })));
    session.subscribe(async () => {
      entered();
      await listenerGate.opened;
    });

    await session.prompt('go');
    await listenerEntered;
    await session.close();
    listenerGate.open();
  });
});
