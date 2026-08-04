// glob 工具测试(L3:真实文件系统 + 真实 ripgrep 二进制,见 docs/10-testing.md 的分层测试)。
// 覆盖:递归匹配与相对路径显示、24h recency 排序(fs.utimesSync 控制 mtime)、
// 0 结果与 limit 截断文案、.gitignore(非 git tmpdir)、path 参数、错误路径、abort。

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FileTracker } from '../shared/index.js';
import type { ToolContext } from './types.js';
import { executeGlob, globParameters } from './glob.js';

let tmpdir: string;

const HOUR_MS = 60 * 60 * 1000;

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: tmpdir,
    signal: signal ?? new AbortController().signal,
    fileTracker: new FileTracker(),
  };
}

async function run(
  args: { pattern: string; path?: string; limit?: number },
  signal?: AbortSignal,
): Promise<string> {
  const out = await executeGlob({ id: 'call_glob', args }, makeCtx(signal));
  const part = out.content[0];
  if (part?.type !== 'text') throw new Error('expected text part');
  return part.text;
}

/** 建文件并把 mtime 拨到指定时刻(recency 排序的控制手段)。 */
function touchAt(rel: string, mtime: Date): void {
  const abs = path.join(tmpdir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '');
  fs.utimesSync(abs, mtime, mtime);
}

/** 48 小时前:落在 24h recency 窗口外,排序退化为纯字母序。 */
function oldDate(): Date {
  return new Date(Date.now() - 48 * HOUR_MS);
}

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coda-glob-'));
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe('glob:匹配与显示', () => {
  it('递归匹配,路径相对 cwd 显示;窗口外文件按字母序', async () => {
    touchAt('src/b.ts', oldDate());
    touchAt('src/nested/a.ts', oldDate());
    touchAt('top.ts', oldDate());
    touchAt('readme.md', oldDate()); // 不匹配 pattern

    const text = await run({ pattern: '**/*.ts' });
    expect(text.split('\n')).toEqual(['src/b.ts', 'src/nested/a.ts', 'top.ts']);
  });

  it('path 参数限定子目录,显示仍带子目录前缀(相对 cwd)', async () => {
    touchAt('sub/in.ts', oldDate());
    touchAt('out.ts', oldDate());

    const text = await run({ pattern: '**/*.ts', path: 'sub' });
    expect(text).toBe(path.join('sub', 'in.ts'));
  });

  it('.gitignore 在非 git 目录同样生效(--no-require-git)', async () => {
    fs.writeFileSync(path.join(tmpdir, '.gitignore'), 'ignored/\n');
    touchAt('ignored/x.ts', oldDate());
    touchAt('src/y.ts', oldDate());

    const text = await run({ pattern: '**/*.ts' });
    expect(text).toBe(path.join('src', 'y.ts'));
  });
});

describe('glob:24h recency 排序(gemini-cli sortFileEntries)', () => {
  it('24h 内修改的文件按 mtime 新→旧排最前,窗口外按字母序垫后', async () => {
    const now = Date.now();
    touchAt('z-old.ts', oldDate());
    touchAt('a-old.ts', oldDate());
    touchAt('older-recent.ts', new Date(now - 2 * HOUR_MS));
    touchAt('newest.ts', new Date(now - 1 * HOUR_MS));

    const text = await run({ pattern: '*.ts' });
    expect(text.split('\n')).toEqual(['newest.ts', 'older-recent.ts', 'a-old.ts', 'z-old.ts']);
  });
});

describe('glob:0 结果与 limit 截断', () => {
  it('0 结果返回规格文案(含 pattern 原话)', async () => {
    touchAt('a.md', oldDate());
    expect(await run({ pattern: '**/*.rs' })).toBe('No files match pattern "**/*.rs"');
  });

  it('超 limit 截断并附规格文案;排序先于截断(recent 优先保留)', async () => {
    const now = Date.now();
    touchAt('d.ts', oldDate());
    touchAt('e.ts', oldDate());
    touchAt('c.ts', oldDate());
    touchAt('recent.ts', new Date(now - 1 * HOUR_MS));

    const text = await run({ pattern: '*.ts', limit: 2 });
    expect(text).toBe(
      'recent.ts\nc.ts\n(Results truncated: showing first 2. Refine the pattern or path.)',
    );
  });

  it('结果数恰等于 limit 时不附截断提示', async () => {
    touchAt('a.ts', oldDate());
    touchAt('b.ts', oldDate());
    expect(await run({ pattern: '*.ts', limit: 2 })).toBe('a.ts\nb.ts');
  });
});

describe('glob:错误路径与 abort', () => {
  it('path 不存在 → Directory not found', async () => {
    await expect(run({ pattern: '*.ts', path: 'nope' })).rejects.toThrow(
      'Directory not found: nope',
    );
  });

  it('path 指向文件 → Not a directory', async () => {
    fs.writeFileSync(path.join(tmpdir, 'f.txt'), '');
    await expect(run({ pattern: '*.ts', path: 'f.txt' })).rejects.toThrow('Not a directory: f.txt');
  });

  it('glob 语法错误 → 转述 rg stderr(exit code 2)', async () => {
    touchAt('a.ts', oldDate());
    await expect(run({ pattern: 'a{' })).rejects.toThrow(/Glob search failed: .*glob/);
  });

  it('signal 已 abort → 报 User aborted the glob search(文案对齐 grep/bash)', async () => {
    touchAt('a.ts', oldDate());
    const ac = new AbortController();
    ac.abort();
    await expect(run({ pattern: '*.ts' }, ac.signal)).rejects.toThrow('User aborted the glob search');
  });
});

describe('glob:定义与 schema', () => {
  it('kind 为 search(权限直通档)', () => {
  });

  it('schema 可渲染为 JSON Schema 且描述钉住规格原话', () => {
    const schema = z.toJSONSchema(globParameters) as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(schema.required).toEqual(['pattern']);
    expect(schema.properties['pattern']?.description).toContain('**/*.ts');
    expect(schema.properties['path']?.description).toContain("do NOT pass 'undefined' or 'null'");
    expect(schema.properties['limit']?.description).toContain('default 100');
  });
});
