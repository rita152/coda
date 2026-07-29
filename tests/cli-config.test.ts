// CLI 配置解析测试(docs/09-cli.md §7,docs/11 M5 验收 4):resolveConfig 是纯函数
// (flags/env/file 全部注入,不碰真实 process.env 与磁盘),对 model/baseURL/apiKey
// 三字段做「flag > 环境变量 > config.json > 内置默认」的独立合并矩阵——M5 对抗核查
// 用 mutation 实证过:优先级反转时原有测试全绿,故此矩阵按「同时给出多来源不同值」
// 构造,任何一层被跳过或反转都必红。另覆盖 parseFlags 的边界文法。

import { afterEach, describe, expect, it, vi } from 'bun:test';
import type { CliFlags, CodaConfigFile } from '../src/cli/config.js';
import {
  getMissingApiKeyMessage,
  isFullScreenTuiEligible,
  parseFlags,
  resolveConfig,
} from '../src/cli/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 便捷构造:必填布尔字段兜底,测试只声明关心的字段。 */
function flags(o: Partial<CliFlags> = {}): CliFlags {
  return { json: false, continue_: false, noColor: false, ...o };
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

describe('resolveConfig:flag > env > file > 默认,逐字段独立合并(docs/09 §7.1/§7.2)', () => {
  it('三来源同时在场:三字段全部取 flag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);   // file.apiKey 明文警告不进测试输出
    const r = resolveConfig(FULL_FLAGS, FULL_ENV, FULL_FILE);
    expect(r.provider).toBe('openai-chat');
    expect(r.modelConfig.ref).toEqual({ provider: 'openai', api: 'openai-chat', model: 'flag-model' });
    expect(r.modelConfig.baseURL).toBe('https://flag.example');
    expect(r.modelConfig.apiKey).toBe('flag-key');
  });

  it('去掉 flag:三字段全部取 env(CODA_* 压过 file)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = resolveConfig(flags(), FULL_ENV, FULL_FILE);
    expect(r.modelConfig.ref.model).toBe('env-model');
    expect(r.modelConfig.baseURL).toBe('https://env.example');
    expect(r.modelConfig.apiKey).toBe('env-key');
  });

  it('只有 file:三字段全部取 file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = resolveConfig(flags(), {}, FULL_FILE);
    expect(r.modelConfig.ref.model).toBe('file-model');
    expect(r.modelConfig.baseURL).toBe('https://file.example');
    expect(r.modelConfig.apiKey).toBe('file-key');
  });

  it('全部缺省(仅给 key 免 throw):model 内置默认 gpt-5.2,baseURL undefined', () => {
    const r = resolveConfig(flags(), { OPENAI_API_KEY: 'k' }, {});
    expect(r.modelConfig.ref.model).toBe('gpt-5.2');
    expect(r.modelConfig.baseURL).toBeUndefined();
  });

  it('逐字段独立:model 来自 flag、baseURL 来自 env、apiKey 来自 file,互不牵连', () => {
    const r = resolveConfig(
      flags({ model: 'flag-model' }),
      { CODA_BASE_URL: 'https://env.example', MY_KEY_VAR: 'indirect-key' },
      { apiKeyEnv: 'MY_KEY_VAR' },
    );
    expect(r.modelConfig.ref.model).toBe('flag-model');
    expect(r.modelConfig.baseURL).toBe('https://env.example');
    expect(r.modelConfig.apiKey).toBe('indirect-key');
  });

  it('CODA_API_KEY 缺席时回退 OPENAI_API_KEY(docs/09 §7.1 表)', () => {
    const r = resolveConfig(flags(), { OPENAI_API_KEY: 'openai-env-key' }, {});
    expect(r.modelConfig.apiKey).toBe('openai-env-key');
  });

  it('空白 key 等同缺失：高优先级空值不遮蔽 provider 环境变量，生效值去掉首尾空白', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const openai = resolveConfig(
      flags({ apiKey: ' \t ' }),
      { CODA_API_KEY: '\n', OPENAI_API_KEY: '  openai-env-key  ' },
      { apiKey: 'file-key' },
    );
    const anthropic = resolveConfig(
      flags({ provider: 'anthropic-messages', apiKey: '' }),
      { CODA_API_KEY: '  ', ANTHROPIC_API_KEY: '\tanthropic-env-key\n' },
      { apiKey: 'file-key' },
    );
    const fileFallback = resolveConfig(
      flags(),
      { CODA_API_KEY: ' ', OPENAI_API_KEY: '\n' },
      { apiKey: '  file-key  ' },
    );

    expect(openai.modelConfig.apiKey).toBe('openai-env-key');
    expect(anthropic.modelConfig.apiKey).toBe('anthropic-env-key');
    expect(fileFallback.modelConfig.apiKey).toBe('file-key');
  });

  it('所有 key 来源均为空白时仍视为缺失，允许延迟时不把空串传给 provider', () => {
    const blankSources = {
      CODA_API_KEY: '',
      OPENAI_API_KEY: ' \t ',
      BLANK_KEY: '\n',
    };
    const blankFile = { apiKeyEnv: 'BLANK_KEY', apiKey: '  ' };

    expect(() => resolveConfig(flags({ apiKey: ' ' }), blankSources, blankFile)).toThrow(
      /OPENAI_API_KEY/,
    );
    const deferred = resolveConfig(
      flags({ apiKey: ' ' }),
      blankSources,
      blankFile,
      { allowMissingApiKey: true },
    );
    expect(deferred.modelConfig.apiKey).toBeUndefined();
    expect(getMissingApiKeyMessage(deferred)).toContain('OPENAI_API_KEY');
  });

  it('apiKeyEnv 间接引用:key 取 env[file.apiKeyEnv];指向的变量未设置时不回退明文 apiKey(§7.2 伪码)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hit = resolveConfig(flags(), { MY_KEY_VAR: 'indirect-key' }, { apiKeyEnv: 'MY_KEY_VAR', apiKey: 'plain' });
    expect(hit.modelConfig.apiKey).toBe('indirect-key');
    expect(() => resolveConfig(flags(), {}, { apiKeyEnv: 'UNSET_VAR', apiKey: 'plain' })).toThrow();
    const deferred = resolveConfig(
      flags(),
      {},
      { apiKeyEnv: 'UNSET_VAR', apiKey: 'plain' },
      { allowMissingApiKey: true },
    );
    expect(deferred.modelConfig.apiKey).toBeUndefined();
  });

  it('缺 key:throw 且文案含可执行提示(设哪个变量、改哪个文件——CLI 第一印象)', () => {
    expect(() => resolveConfig(flags(), {}, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveConfig(flags(), {}, {})).toThrow(/apiKeyEnv/);
    expect(() => resolveConfig(flags(), {}, {})).toThrow(/config\.json/);
  });

  it('eligible TUI 可把缺 key 保留为待配置状态，OpenAI/Anthropic 均不在解析期阻断', () => {
    const openai = resolveConfig(flags(), {}, {}, { allowMissingApiKey: true });
    const anthropic = resolveConfig(
      flags({ provider: 'anthropic-messages' }),
      {},
      {},
      { allowMissingApiKey: true },
    );

    expect(openai.modelConfig.apiKey).toBeUndefined();
    expect(getMissingApiKeyMessage(openai)).toContain('OPENAI_API_KEY');
    expect(anthropic.modelConfig.apiKey).toBeUndefined();
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
    const r = resolveConfig(flags(), { OPENAI_API_KEY: 'k' }, file);
    expect(r.modelConfig.defaults).toEqual({ temperature: 0.5, maxOutputTokens: 2048 });
    expect(r.modelConfig.compat).toBe(file.compat);
  });

  it('faux provider:免 key/baseURL,model 取 flag(缺省 faux),fauxScript 透传', () => {
    const r = resolveConfig(flags({ provider: 'faux', fauxScript: '/tmp/script.json' }), {}, {});
    expect(r.provider).toBe('faux');
    expect(r.fauxScript).toBe('/tmp/script.json');
    expect(r.modelConfig.ref).toEqual({ provider: 'faux', api: 'faux', model: 'faux' });
    expect(r.modelConfig.apiKey).toBeUndefined();

    const named = resolveConfig(flags({ provider: 'faux', model: 'faux-2' }), {}, {});
    expect(named.modelConfig.ref.model).toBe('faux-2');
  });
});

describe('全屏 TUI eligibility 与缺 key 延迟策略共用同一判定', () => {
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

describe('parseFlags 边界(docs/09 §2 flag 文法)', () => {
  it('--resume 带值 → id;不带值 → true(进入列表选择)', () => {
    expect(parseFlags(['--resume', '20260101-000000-abcd']).resume).toBe('20260101-000000-abcd');
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
    const f = parseFlags(['--json', '--model', 'm1', '--no-color', '-p', 'do it', '--session-dir', '/tmp/x']);
    expect(f).toMatchObject({ json: true, noColor: true, model: 'm1', prompt: 'do it', sessionDir: '/tmp/x' });
  });
});
