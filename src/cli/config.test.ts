// config 解析单测(docs/09 CLI 路由):
// (1) --resume=<ThreadId> 显式选择线程；裸 --resume 打开列表，后续位置参数作为 prompt；
// (2) readConfigFile:文件不存在静默;JSON 损坏 stderr 警告一行(不静默吞),仍返回 {}。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { parseCliInvocation } from './command-catalog.js';
import { readConfigFile } from './config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseFlags --resume[=<ThreadId>]', () => {
  it('裸 --resume 不猜测旧 id 形状，后续位置参数作为 prompt', () => {
    const flags = parseCliInvocation(['--resume', '20260727-123456-ab3f']).flags;
    expect(flags.resume).toBe(true);
    expect(flags.prompt).toBe('20260727-123456-ab3f');
  });

  it('裸文本不被吞:视为无 id 的 --resume(列表选择),该值按裸 prompt 处理', () => {
    const flags = parseCliInvocation(['--resume', 'fix the login bug']).flags;
    expect(flags.resume).toBe(true);
    expect(flags.prompt).toBe('fix the login bug');
  });

  it('--resume 后跟另一 flag / 结尾:同样是列表选择', () => {
    expect(parseCliInvocation(['--resume']).flags.resume).toBe(true);
    const flags = parseCliInvocation(['--resume', '--no-color']).flags;
    expect(flags.resume).toBe(true);
    expect(flags.noColor).toBe(true);
  });

  it('所有分离位置参数都不被当成 ThreadId', () => {
    const flags = parseCliInvocation(['--resume', '2026-0727']).flags; // 连字符位置不对,不是 id
    expect(flags.resume).toBe(true);
    expect(flags.prompt).toBe('2026-0727');
  });
});

describe('readConfigFile(docs/09)', () => {
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

describe('parseFlags --approval-mode(docs/07 §4 / docs/09 §1)', () => {
  it('解析三个合法值', () => {
    expect(parseCliInvocation(['--approval-mode', 'interactive']).flags.approvalMode).toBe('interactive');
    expect(parseCliInvocation(['--approval-mode', 'allow']).flags.approvalMode).toBe('allow');
    expect(parseCliInvocation(['--approval-mode', 'deny']).flags.approvalMode).toBe('deny');
  });

  it('缺省不设值——默认由 main 按形态定(交互 TUI → interactive,headless/-p → allow)', () => {
    expect(parseCliInvocation([]).flags.approvalMode).toBeUndefined();
    expect(parseCliInvocation(['--json']).flags.approvalMode).toBeUndefined();
  });

  it('非法值与缺值报错(fail-fast,不静默降级)', () => {
    expect(() => parseCliInvocation(['--approval-mode', 'yolo'])).toThrow(/unknown approval mode: yolo/);
    expect(() => parseCliInvocation(['--approval-mode'])).toThrow(/requires a value/);
  });
});

describe('parseFlags canonical runtime transport', () => {
  it('rejects the removed event-format protocol selector', () => {
    expect(() => parseCliInvocation(['--event-format=envelope'])).toThrow(/unknown flag/);
    expect(() => parseCliInvocation(['--json', '--event-format=legacy'])).toThrow(/unknown flag/);
  });

  it('equals-form resume 接受 opaque ThreadId，并可用 workspace 消歧', () => {
    const flags = parseCliInvocation([
      '--resume=opaque-thread',
      '--workspace=opaque-workspace',
    ]).flags;
    expect(flags.resume).toBe('opaque-thread');
    expect(flags.workspace).toBe('opaque-workspace');
    expect(flags.prompt).toBeUndefined();
    expect(() => parseCliInvocation(['--resume='])).toThrow(/non-empty/);
    expect(() => parseCliInvocation(['--workspace='])).toThrow(/non-empty/);
  });
});
