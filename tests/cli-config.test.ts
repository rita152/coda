// CLI 配置解析测试(docs/09-cli.md §7,docs/11 M5 验收 4):resolveConfig 是纯函数
// (flags/env/file 全部注入,不碰真实 process.env 与磁盘),对 model/baseURL/apiKey
// 三字段做「flag > 环境变量 > config.json」的独立合并矩阵；model 不设内置默认——M5 对抗核查
// 用 mutation 实证过:优先级反转时原有测试全绿,故此矩阵按「同时给出多来源不同值」
// 构造,任何一层被跳过或反转都必红。另覆盖 parseFlags 的边界文法。

import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { CliFlags, CodaConfigFile } from '../src/cli/config.js';
import type { ModelConfig } from '../src/protocol/index.js';
import {
  getMissingApiKeyMessage,
  isFullScreenTuiEligible,
  parseFlags,
  resolveInteractiveUi,
  resolveConfig,
} from '../src/cli/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 便捷构造:必填布尔字段兜底,测试只声明关心的字段。 */
function flags(o: Partial<CliFlags> = {}): CliFlags {
  return {
    json: false,
    continue_: false,
    noColor: false,
    ui: 'auto',
    theme: 'auto',
    ascii: false,
    finalOnly: false,
    ephemeral: false,
    ...o,
  };
}

function modelConfig(value: { modelConfig?: ModelConfig }): ModelConfig {
  if (value.modelConfig === undefined) throw new Error('expected resolved model config');
  return value.modelConfig;
}

/** 三来源同时给出互不相同的值(优先级反转/漏层的最强判别构型)。 */
const FULL_FLAGS = flags({ model: 'flag-model', baseUrl: 'https://flag.example', apiKey: 'flag-key' });
const FULL_ENV: NodeJS.ProcessEnv = {
  CODA_MODEL: 'env-model',
  CODA_BASE_URL: 'https://env.example',
  CODA_API_KEY: 'env-key',
  OPENAI_API_KEY: 'openai-env-key',
};
const FULL_FILE: CodaConfigFile = { model: 'file-model', baseURL: 'https://file.example', apiKey: 'file-key' };

describe('resolveConfig:flag > env > file 且无默认模型(docs/09 §7.3)', () => {
  it('三来源同时在场:三字段全部取 flag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);   // file.apiKey 明文警告不进测试输出
    const r = resolveConfig(FULL_FLAGS, FULL_ENV, FULL_FILE);
    expect(r.provider).toBe('openai-chat');
    expect(modelConfig(r).ref).toEqual({ provider: 'openai', api: 'openai-chat', model: 'flag-model' });
    expect(modelConfig(r).baseURL).toBe('https://flag.example');
    expect(modelConfig(r).apiKey).toBe('flag-key');
  });

  it('去掉 flag:三字段全部取 env(CODA_* 压过 file)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = resolveConfig(flags(), FULL_ENV, FULL_FILE);
    expect(modelConfig(r).ref.model).toBe('env-model');
    expect(modelConfig(r).baseURL).toBe('https://env.example');
    expect(modelConfig(r).apiKey).toBe('env-key');
  });

  it('只有 file:三字段全部取 file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = resolveConfig(flags(), {}, FULL_FILE);
    expect(modelConfig(r).ref.model).toBe('file-model');
    expect(modelConfig(r).baseURL).toBe('https://file.example');
    expect(modelConfig(r).apiKey).toBe('file-key');
  });

  it('没有显式 model 时保持未选择，不恢复任何硬编码默认', () => {
    const r = resolveConfig(flags(), { OPENAI_API_KEY: 'k' }, {});
    expect(r.modelConfig).toBeUndefined();
    expect(r.provider).toBeUndefined();
  });

  it('逐字段独立:model 来自 flag、baseURL 来自 env、apiKey 来自 file,互不牵连', () => {
    const r = resolveConfig(
      flags({ model: 'flag-model' }),
      { CODA_BASE_URL: 'https://env.example', MY_KEY_VAR: 'indirect-key' },
      { apiKeyEnv: 'MY_KEY_VAR' },
    );
    expect(modelConfig(r).ref.model).toBe('flag-model');
    expect(modelConfig(r).baseURL).toBe('https://env.example');
    expect(modelConfig(r).apiKey).toBe('indirect-key');
  });

  it('CODA_API_KEY 缺席时回退 OPENAI_API_KEY(docs/09 §7.3 表)', () => {
    const r = resolveConfig(
      flags({ model: 'explicit-model' }),
      { OPENAI_API_KEY: 'openai-env-key' },
      {},
    );
    expect(modelConfig(r).apiKey).toBe('openai-env-key');
  });

  it('openai-responses provider 生成对应 ModelRef，并复用 OpenAI key 来源', () => {
    const r = resolveConfig(
      flags({ provider: 'openai-responses', model: 'gpt-responses' }),
      { OPENAI_API_KEY: 'responses-key' },
      {},
    );
    expect(r.provider).toBe('openai-responses');
    expect(modelConfig(r).ref).toEqual({
      provider: 'openai',
      api: 'openai-responses',
      model: 'gpt-responses',
    });
    expect(modelConfig(r).apiKey).toBe('responses-key');
  });

  it('空白 key 等同缺失：高优先级空值不遮蔽 provider 环境变量，生效值去掉首尾空白', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const openai = resolveConfig(
      flags({ model: 'openai-model', apiKey: ' \t ' }),
      { CODA_API_KEY: '\n', OPENAI_API_KEY: '  openai-env-key  ' },
      { apiKey: 'file-key' },
    );
    const anthropic = resolveConfig(
      flags({ provider: 'anthropic-messages', model: 'anthropic-model', apiKey: '' }),
      { CODA_API_KEY: '  ', ANTHROPIC_API_KEY: '\tanthropic-env-key\n' },
      { apiKey: 'file-key' },
    );
    const fileFallback = resolveConfig(
      flags({ model: 'file-model' }),
      { CODA_API_KEY: ' ', OPENAI_API_KEY: '\n' },
      { apiKey: '  file-key  ' },
    );

    expect(modelConfig(openai).apiKey).toBe('openai-env-key');
    expect(modelConfig(anthropic).apiKey).toBe('anthropic-env-key');
    expect(modelConfig(fileFallback).apiKey).toBe('file-key');
  });

  it('所有 key 来源均为空白时仍视为缺失，允许延迟时不把空串传给 provider', () => {
    const blankSources = {
      CODA_API_KEY: '',
      OPENAI_API_KEY: ' \t ',
      BLANK_KEY: '\n',
    };
    const blankFile = { apiKeyEnv: 'BLANK_KEY', apiKey: '  ' };

    expect(() => resolveConfig(flags({ model: 'm', apiKey: ' ' }), blankSources, blankFile)).toThrow(
      /OPENAI_API_KEY/,
    );
    const deferred = resolveConfig(
      flags({ model: 'm', apiKey: ' ' }),
      blankSources,
      blankFile,
      { allowMissingApiKey: true },
    );
    expect(modelConfig(deferred).apiKey).toBeUndefined();
    expect(getMissingApiKeyMessage(deferred)).toContain('OPENAI_API_KEY');
  });

  it('apiKeyEnv 间接引用:key 取 env[file.apiKeyEnv];指向的变量未设置时不回退明文 apiKey(§7.3)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hit = resolveConfig(
      flags({ model: 'm' }),
      { MY_KEY_VAR: 'indirect-key' },
      { apiKeyEnv: 'MY_KEY_VAR', apiKey: 'plain' },
    );
    expect(modelConfig(hit).apiKey).toBe('indirect-key');
    expect(() =>
      resolveConfig(
        flags({ model: 'm' }),
        {},
        { apiKeyEnv: 'UNSET_VAR', apiKey: 'plain' },
      ),
    ).toThrow();
    const deferred = resolveConfig(
      flags({ model: 'm' }),
      {},
      { apiKeyEnv: 'UNSET_VAR', apiKey: 'plain' },
      { allowMissingApiKey: true },
    );
    expect(modelConfig(deferred).apiKey).toBeUndefined();
  });

  it('缺 key:throw 且文案含可执行提示(设哪个变量、改哪个文件——CLI 第一印象)', () => {
    expect(() => resolveConfig(flags({ model: 'm' }), {}, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveConfig(flags({ model: 'm' }), {}, {})).toThrow(/apiKeyEnv/);
    expect(() => resolveConfig(flags({ model: 'm' }), {}, {})).toThrow(/config\.json/);
  });

  it('TTY 交互可把缺 key 保留为待配置状态，TUI 不在解析期阻断', () => {
    const openai = resolveConfig(
      flags({ model: 'openai-model' }),
      {},
      {},
      { allowMissingApiKey: true },
    );
    const anthropic = resolveConfig(
      flags({ provider: 'anthropic-messages', model: 'anthropic-model' }),
      {},
      {},
      { allowMissingApiKey: true },
    );

    expect(modelConfig(openai).apiKey).toBeUndefined();
    expect(getMissingApiKeyMessage(openai)).toContain('OPENAI_API_KEY');
    expect(modelConfig(anthropic).apiKey).toBeUndefined();
    expect(getMissingApiKeyMessage(anthropic)).toContain('ANTHROPIC_API_KEY');
  });

  it('file.apiKey 明文在场:console.error 警告(stderr 纪律,不进 stdout)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resolveConfig(flags(), {}, { apiKey: 'plain' });
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('apiKeyEnv'))).toBe(true);
  });

  it('defaults/compat 从 file 透传进 ModelConfig', () => {
    const file: CodaConfigFile = {
      defaults: { temperature: 0.5, maxOutputTokens: 2048 },
      compat: {},
    };
    const r = resolveConfig(flags({ model: 'm' }), { OPENAI_API_KEY: 'k' }, file);
    expect(modelConfig(r).defaults).toEqual({ temperature: 0.5, maxOutputTokens: 2048 });
    expect(modelConfig(r).compat).toBe(file.compat);
  });

  it('faux provider:免 key/baseURL,model 取 flag(缺省 faux),fauxScript 透传', () => {
    const r = resolveConfig(flags({ provider: 'faux', fauxScript: '/tmp/script.json' }), {}, {});
    expect(r.provider).toBe('faux');
    expect(r.fauxScript).toBe('/tmp/script.json');
    expect(modelConfig(r).ref).toEqual({ provider: 'faux', api: 'faux', model: 'faux' });
    expect(modelConfig(r).apiKey).toBeUndefined();

    const named = resolveConfig(flags({ provider: 'faux', model: 'faux-2' }), {}, {});
    expect(modelConfig(named).ref.model).toBe('faux-2');
  });
});

describe('全屏 TUI eligibility', () => {
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true, term: 'xterm-256color' };

  it('只有无 prompt 的双 TTY 非 dumb 交互启动 eligible', () => {
    expect(isFullScreenTuiEligible(flags(), terminal)).toBe(true);
    expect(isFullScreenTuiEligible(flags({ json: true }), terminal)).toBe(false);
    expect(isFullScreenTuiEligible(flags({ prompt: 'hello' }), terminal)).toBe(false);
    expect(isFullScreenTuiEligible(flags(), { ...terminal, stdinIsTTY: false })).toBe(false);
    expect(isFullScreenTuiEligible(flags(), { ...terminal, stdoutIsTTY: false })).toBe(false);
    expect(isFullScreenTuiEligible(flags(), { ...terminal, term: 'dumb' })).toBe(false);
  });
});

describe('--ui 纯路由', () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true, term: 'xterm-256color' };

  it('auto 与显式 tui 在完整双 TTY 非 dumb 环境选择 TUI', () => {
    expect(resolveInteractiveUi('auto', tty)).toEqual({ ok: true, surface: 'tui' });
    expect(resolveInteractiveUi('tui', tty)).toEqual({ ok: true, surface: 'tui' });
  });

  it('auto 与显式 tui 在不支持的终端明确失败且给出一次性/headless 修复', () => {
    for (const mode of ['auto', 'tui'] as const) {
      for (const terminal of [
        { ...tty, term: 'dumb' },
        { ...tty, stdoutIsTTY: false },
        { ...tty, stdinIsTTY: false },
      ]) {
        const resolution = resolveInteractiveUi(mode, terminal);
        expect(resolution.ok).toBe(false);
        if (!resolution.ok) {
          expect(resolution.message.includes('requires TTY stdin/stdout')).toBe(true);
          expect(resolution.message.includes('use a prompt, pipe stdin, or --json')).toBe(true);
        }
      }
    }
  });
});

describe('parseFlags 边界(docs/09 §2 flag 文法)', () => {
  it('--resume=<thread-id> 使用 canonical identity；不带值进入列表选择', () => {
    const threadId = 'th_11111111-1111-4111-8111-111111111111';
    expect(parseFlags([`--resume=${threadId}`]).resume).toBe(threadId);
    expect(parseFlags(['--resume']).resume).toBe(true);
    // 后随另一个 flag:不吞 flag,resume 仍为 true 且后续 flag 正常解析
    const f = parseFlags(['--resume', '--json']);
    expect(f.resume).toBe(true);
    expect(f.json).toBe(true);
  });

  it('裸参数聚合为 prompt 文本(coda "做点什么" 便利形态)', () => {
    expect(parseFlags(['fix', 'the', 'bug']).prompt).toBe('fix the bug');
    expect(parseFlags(['-p', 'hello', 'world']).prompt).toBe('hello world');
  });

  it('未知 flag throw;取值 flag 缺值 throw', () => {
    expect(() => parseFlags(['--frobnicate'])).toThrow(/unknown flag/);
    expect(() => parseFlags(['--model'])).toThrow(/requires a value/);
    expect(() => parseFlags(['--model', '--json'])).toThrow(/requires a value/);
    expect(() => parseFlags(['--provider', 'bogus'])).toThrow(/unknown provider/);
  });

  it('组合:布尔 flag 与取值 flag 混排互不干扰', () => {
    const f = parseFlags(['--json', '--model', 'm1', '--no-color', '-p', 'do it']);
    expect(f).toMatchObject({ json: true, noColor: true, model: 'm1', prompt: 'do it' });
  });

  it('--provider openai-responses 是合法 provider 值', () => {
    expect(parseFlags(['--provider', 'openai-responses']).provider).toBe('openai-responses');
  });
});
