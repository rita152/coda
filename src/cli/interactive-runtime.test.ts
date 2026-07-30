// 可空交互运行时：无模型不建 Session；模型切换只影响后续请求与实际 assistant ModelRef。

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelConfig } from '../protocol/index.js';
import {
  createFauxStreamFn,
  createGate,
} from '../providers/faux/index.js';
import {
  loadSession,
  Session,
} from '../session/index.js';
import { InteractiveRuntime } from './interactive-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'coda-interactive-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function model(
  provider: string,
  api: 'openai-chat' | 'openai-responses' | 'anthropic-messages',
  name: string,
  apiKey: string,
): ModelConfig {
  return {
    ref: { provider, api, model: name },
    baseURL: `https://${provider}.example/v1`,
    apiKey,
  };
}

describe('冷启动与显式模型选择', () => {
  it('无 provider/model 时允许启动，/model 前 prompt 拒绝且不创建占位 Session', async () => {
    const dir = tempDir();
    let creates = 0;
    const runtime = new InteractiveRuntime({
      createSession: async (selected) => {
        creates++;
        return Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({ turns: [], onExhausted: 'emptyStop' }),
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        });
      },
    });

    await runtime.initialize();
    expect(creates).toBe(0);
    expect(runtime.currentModel()).toBeUndefined();
    expect(runtime.messages).toEqual([]);
    await expect(runtime.prompt('must not persist')).rejects.toThrow(/\/model/);
    expect(creates).toBe(0);
    expect(await Session.list(dir)).toEqual([]);
    await runtime.close();
  });

  it('第一次 /model 才建 Session；后续切换复用 Session 并按 ModelRef.api 记录实际模型', async () => {
    const dir = tempDir();
    const first = model('custom:first', 'openai-chat', 'chat-a', 'secret-a');
    const second = model(
      'custom:second',
      'anthropic-messages',
      'messages-b',
      'secret-b',
    );
    const stream = createFauxStreamFn({
      turns: [
        { events: [{ kind: 'text', text: 'first answer' }] },
        { events: [{ kind: 'text', text: 'second answer' }] },
      ],
      onExhausted: 'emptyStop',
    });
    let creates = 0;
    const emitted: unknown[] = [];
    const attachments: number[] = [];
    const runtime = new InteractiveRuntime({
      createSession: async (selected) => {
        creates++;
        return Session.create({
          dir,
          agentConfig: {
            streamFn: stream,
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        });
      },
    });
    runtime.subscribe((event) => {
      emitted.push(event);
    });
    runtime.subscribeSessionAttached((messages) => {
      attachments.push(messages.length);
    });

    await runtime.setModel(first);
    expect(creates).toBe(1);
    expect(attachments).toEqual([0]);
    await runtime.prompt('one');
    await runtime.setModel(second);
    await runtime.prompt('two');

    expect(creates).toBe(1);
    expect(
      runtime.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.model),
    ).toEqual([first.ref, second.ref]);
    expect(stream.calls.map((call) => call.model.ref.api)).toEqual([
      'openai-chat',
      'anthropic-messages',
    ]);

    const item = (await Session.list(dir))[0];
    if (item === undefined) throw new Error('expected session');
    const jsonl = readFileSync(path.join(dir, `${item.id}.jsonl`), 'utf8');
    const meta = JSON.parse(jsonl.split('\n')[0] as string) as {
      model: ModelConfig['ref'];
    };
    expect(meta.model).toEqual(first.ref);
    expect(jsonl).not.toContain('secret-a');
    expect(jsonl).not.toContain('secret-b');
    expect(JSON.stringify(emitted)).not.toContain('secret-a');
    expect(JSON.stringify(emitted)).not.toContain('secret-b');
    await runtime.close();
  });

  it('logout/clear 后保留既有 Session 与历史，但新 prompt 必须重新显式选择', async () => {
    const dir = tempDir();
    const first = model('custom:first', 'openai-chat', 'one', 'key-one');
    const second = model('custom:second', 'openai-responses', 'two', 'key-two');
    let creates = 0;
    const runtime = new InteractiveRuntime({
      createSession: async (selected) => {
        creates++;
        return Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [
                { events: [{ kind: 'text', text: 'a' }] },
                { events: [{ kind: 'text', text: 'b' }] },
              ],
              onExhausted: 'emptyStop',
            }),
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        });
      },
    });

    await runtime.setModel(first);
    await runtime.prompt('first');
    const historyLength = runtime.messages.length;
    runtime.clearModel();
    await expect(runtime.prompt('blocked')).rejects.toThrow(/\/model/);
    expect(runtime.messages).toHaveLength(historyLength);
    await runtime.setModel(second);
    await runtime.prompt('second');
    expect(creates).toBe(1);
    expect(runtime.messages.length).toBeGreaterThan(historyLength);
    await runtime.close();
  });
});

describe('恢复与空闲门禁', () => {
  it('恢复时用最近显式选择继续，但历史 assistant 与 meta 的原 ModelRef 不改写', async () => {
    const dir = tempDir();
    const oldModel = model('custom:old', 'openai-chat', 'old-model', 'old-key');
    const newModel = model(
      'custom:new',
      'openai-responses',
      'new-model',
      'new-key',
    );
    const seed = await Session.create({
      dir,
      agentConfig: {
        streamFn: createFauxStreamFn({
          turns: [{ events: [{ kind: 'text', text: 'old answer' }] }],
        }),
        model: oldModel,
        tools: [],
        systemPrompt: 'test',
      },
    });
    await seed.prompt('old question');
    const id = seed.id;
    await seed.close();

    const runtime = new InteractiveRuntime({
      initialModel: newModel,
      createSession: (selected) =>
        Session.resume(id, {
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [{ events: [{ kind: 'text', text: 'new answer' }] }],
            }),
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        }),
    });
    await runtime.initialize();
    expect(
      runtime.messages.find((message) => message.role === 'assistant'),
    ).toMatchObject({ model: oldModel.ref });

    await runtime.prompt('new question');
    const assistantModels = runtime.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.model);
    expect(assistantModels).toEqual([oldModel.ref, newModel.ref]);
    expect(loadSession(dir, id).meta.model).toEqual(oldModel.ref);
    await runtime.close();
  });

  it('运行中拒绝切换并给出完成或 abort 提示；abort 落定后可切换', async () => {
    const dir = tempDir();
    const gate = createGate();
    const first = model('custom:first', 'openai-chat', 'one', 'one-key');
    const second = model('custom:second', 'openai-responses', 'two', 'two-key');
    const runtime = new InteractiveRuntime({
      createSession: (selected) =>
        Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [{ events: [{ kind: 'gate', gate }] }],
              onExhausted: 'emptyStop',
            }),
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        }),
    });
    await runtime.setModel(first);
    let resolveAgentStart!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      resolveAgentStart = resolve;
    });
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'agent_start') resolveAgentStart();
    });
    const running = runtime.prompt('hold');
    await agentStarted;

    await expect(runtime.setModel(second)).rejects.toThrow(/完成或 abort/);
    expect(runtime.currentModel()).toEqual(first.ref);
    runtime.abort();
    await running;
    unsubscribe();
    await runtime.setModel(second);
    expect(runtime.currentModel()).toEqual(second.ref);
    await runtime.close();
  });
});

describe('并发创建与关闭', () => {
  it('并发选择只复用一次在途创建，后一次选择决定后续请求模型', async () => {
    const dir = tempDir();
    const started = createGate();
    const release = createGate();
    const first = model('custom:first', 'openai-chat', 'one', 'one-key');
    const second = model('custom:second', 'openai-responses', 'two', 'two-key');
    const stream = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'answer' }] }],
    });
    const createdWith: ModelConfig[] = [];
    const runtime = new InteractiveRuntime({
      createSession: async (selected) => {
        createdWith.push(selected);
        started.open();
        await release.opened;
        return Session.create({
          dir,
          agentConfig: {
            streamFn: stream,
            model: selected,
            tools: [],
            systemPrompt: 'test',
          },
        });
      },
    });

    const selectFirst = runtime.setModel(first);
    await started.opened;
    const selectSecond = runtime.setModel(second);
    expect(createdWith).toEqual([first]);
    release.open();
    await Promise.all([selectFirst, selectSecond]);

    expect(runtime.currentModel()).toEqual(second.ref);
    await runtime.prompt('use latest');
    expect(stream.calls).toHaveLength(1);
    expect(stream.calls[0]?.model).toEqual(second);
    await runtime.close();
  });

  it('close 等待在途创建，工厂返回的 Session 不会在关闭后 attach 或泄漏', async () => {
    const dir = tempDir();
    const started = createGate();
    const release = createGate();
    const selected = model('custom:first', 'openai-chat', 'one', 'one-key');
    let created: Session | undefined;
    const runtime = new InteractiveRuntime({
      createSession: async (modelConfig) => {
        started.open();
        await release.opened;
        created = await Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [],
              onExhausted: 'emptyStop',
            }),
            model: modelConfig,
            tools: [],
            systemPrompt: 'test',
          },
        });
        return created;
      },
    });

    const selecting = runtime.setModel(selected);
    void selecting.catch(() => undefined);
    await started.opened;
    let closeSettled = false;
    const closing = runtime.close().finally(() => {
      closeSettled = true;
    });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(closeSettled).toBe(false);

    release.open();
    await closing;
    await expect(selecting).rejects.toThrow(/interactive runtime is closed/);
    expect(runtime.currentModel()).toBeUndefined();
    expect(runtime.messages).toEqual([]);
    const session = created;
    if (session === undefined) throw new Error('expected created session');
    await expect(session.prompt('must be closed')).rejects.toThrow(/is closed/);
  });

  it('attach listener 内调用 close 不会反向等待自身', async () => {
    const dir = tempDir();
    const selected = model('custom:first', 'openai-chat', 'one', 'one-key');
    const runtime = new InteractiveRuntime({
      createSession: (modelConfig) =>
        Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [],
              onExhausted: 'emptyStop',
            }),
            model: modelConfig,
            tools: [],
            systemPrompt: 'test',
          },
        }),
    });
    runtime.subscribeSessionAttached(() => runtime.close());

    await expect(runtime.setModel(selected)).rejects.toThrow(
      /interactive runtime is closed/,
    );
  });
});

describe('监听器隔离与 attach 提交', () => {
  it('单个监听器失败不会跳过后续监听器，且 attach 回调观察到已提交状态', async () => {
    const dir = tempDir();
    const selected = model('custom:first', 'openai-chat', 'one', 'one-key');
    const successfulAttachments: number[] = [];
    const attachmentModels: Array<ModelConfig['ref'] | undefined> = [];
    const successfulEvents: string[] = [];
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const runtime = new InteractiveRuntime({
      createSession: (modelConfig) =>
        Session.create({
          dir,
          agentConfig: {
            streamFn: createFauxStreamFn({
              turns: [{ events: [{ kind: 'text', text: 'answer' }] }],
            }),
            model: modelConfig,
            tools: [],
            systemPrompt: 'test',
          },
        }),
    });
    runtime.subscribeSessionAttached(async () => {
      attachmentModels.push(runtime.currentModel());
      throw new Error('broken attachment listener');
    });
    runtime.subscribeSessionAttached((messages) => {
      attachmentModels.push(runtime.currentModel());
      successfulAttachments.push(messages.length);
    });
    runtime.subscribe(async () => {
      throw new Error('broken session listener');
    });
    runtime.subscribe((event) => {
      successfulEvents.push(event.type);
    });

    await runtime.setModel(selected);
    expect(attachmentModels).toEqual([selected.ref, selected.ref]);
    expect(successfulAttachments).toEqual([0]);
    expect(runtime.currentModel()).toEqual(selected.ref);

    await runtime.prompt('hello');
    expect(successfulEvents).toContain('agent_start');
    expect(successfulEvents).toContain('agent_end');
    expect(errorSpy).toHaveBeenCalled();
    await runtime.close();
  });
});
