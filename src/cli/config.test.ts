// config 解析单测(M5 核查修复面,docs/09 §2/§7):
// (1) --resume 只吞会话 id 形状的值(YYYYMMDD-HHMMSS-…);裸文本不被吞,按裸 prompt 处理;
// (2) readConfigFile:文件不存在静默;JSON 损坏 stderr 警告一行(不静默吞),仍返回 {}。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { parseFlags, readConfigFile } from './config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseFlags --resume(docs/09 §2:--resume [id])', () => {
  it('形如会话 id 的值被吞为 resume id', () => {
    const flags = parseFlags(['--resume', '20260727-123456-ab3f']);
    expect(flags.resume).toBe('20260727-123456-ab3f');
    expect(flags.prompt).toBeUndefined();
  });

  it('Runtime legacy mirror id 同样可用分离参数恢复', () => {
    const id = `runtime-${'a'.repeat(40)}`;
    expect(parseFlags(['--resume', id]).resume).toBe(id);
  });

  it('裸文本不被吞:视为无 id 的 --resume(列表选择),该值按裸 prompt 处理', () => {
    const flags = parseFlags(['--resume', 'fix the login bug']);
    expect(flags.resume).toBe(true);
    expect(flags.prompt).toBe('fix the login bug');
  });

  it('--resume 后跟另一 flag / 结尾:同样是列表选择', () => {
    expect(parseFlags(['--resume']).resume).toBe(true);
    const flags = parseFlags(['--resume', '--no-color']);
    expect(flags.resume).toBe(true);
    expect(flags.noColor).toBe(true);
  });

  it('非 id 形状的时间戳残缺值不被吞', () => {
    const flags = parseFlags(['--resume', '2026-0727']); // 连字符位置不对,不是 id
    expect(flags.resume).toBe(true);
    expect(flags.prompt).toBe('2026-0727');
  });
});

describe('readConfigFile(docs/09 §7)', () => {
  it('文件不存在:静默返回 {}', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'coda-config-')), 'nope.json');
    expect(readConfigFile(file)).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('JSON 损坏:stderr 警告一行(含文件路径),返回 {} 不阻断启动', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'coda-config-')), 'config.json');
    writeFileSync(file, '{ "model": "gpt-5.2", ', 'utf8'); // 截断的 JSON
    expect(readConfigFile(file)).toEqual({});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain(file);
  });

  it('合法 JSON 正常读取,无警告', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'coda-config-')), 'config.json');
    writeFileSync(file, '{ "model": "gpt-5.2" }', 'utf8');
    expect(readConfigFile(file)).toEqual({ model: 'gpt-5.2' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('parseFlags --approval-mode(M6,docs/07 §3 / docs/09 §6.5)', () => {
  it('解析三个合法值', () => {
    expect(parseFlags(['--approval-mode', 'interactive']).approvalMode).toBe('interactive');
    expect(parseFlags(['--approval-mode', 'allow']).approvalMode).toBe('allow');
    expect(parseFlags(['--approval-mode', 'deny']).approvalMode).toBe('deny');
  });

  it('缺省不设值——默认由 main 按形态定(交互 TUI → interactive,headless/-p → allow)', () => {
    expect(parseFlags([]).approvalMode).toBeUndefined();
    expect(parseFlags(['--json']).approvalMode).toBeUndefined();
  });

  it('非法值与缺值报错(fail-fast,不静默降级)', () => {
    expect(() => parseFlags(['--approval-mode', 'yolo'])).toThrow(/unknown approval mode: yolo/);
    expect(() => parseFlags(['--approval-mode'])).toThrow(/requires a value/);
  });
});

describe('parseFlags Phase-1 runtime transport', () => {
  it('legacy 是默认值，envelope 同时支持空格与 equals 文法', () => {
    expect(parseFlags(['--json']).eventFormat).toBe('legacy');
    expect(parseFlags(['--json', '--event-format', 'envelope']).eventFormat).toBe('envelope');
    expect(parseFlags(['--json', '--event-format=envelope']).eventFormat).toBe('envelope');
  });

  it('envelope 只允许 headless，非法/空值 fail-fast', () => {
    expect(() => parseFlags(['--event-format=envelope'])).toThrow(/requires --json/);
    expect(() => parseFlags(['--json', '--event-format=nope'])).toThrow(/unknown event format/);
    expect(() => parseFlags(['--json', '--event-format='])).toThrow(/unknown event format/);
  });

  it('equals-form resume 接受 opaque ThreadId，并可用 workspace 消歧', () => {
    const flags = parseFlags([
      '--resume=opaque-thread',
      '--workspace=opaque-workspace',
    ]);
    expect(flags.resume).toBe('opaque-thread');
    expect(flags.workspace).toBe('opaque-workspace');
    expect(flags.prompt).toBeUndefined();
    expect(() => parseFlags(['--resume='])).toThrow(/non-empty/);
    expect(() => parseFlags(['--workspace='])).toThrow(/non-empty/);
  });
});
