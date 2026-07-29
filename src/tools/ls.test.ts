// ls 工具测试(L3:真实文件系统 + tmpdir 隔离,docs/10-testing.md §6)。
// 覆盖:字母序/目录后缀/dotfiles/不递归、limit 截断文案、非目录与不存在报错、
// .gitignore 忽略目录仍列名、空目录、schema 描述钉住规格原话(docs/07 §2.2)。

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FileTracker } from '../shared/index.js';
import type { ToolContext } from './types.js';
import { lsTool } from './ls.js';

let tmpdir: string;

function makeCtx(): ToolContext {
  return { cwd: tmpdir, signal: new AbortController().signal, fileTracker: new FileTracker() };
}

async function run(args: { path?: string; limit?: number }): Promise<string> {
  const out = await lsTool.execute({ id: 'call_ls', args }, makeCtx());
  const part = out.content[0];
  if (part?.type !== 'text') throw new Error('expected text part');
  return part.text;
}

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coda-ls-'));
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe('ls:基本列举', () => {
  it('字母序、目录加 / 后缀、含 dotfiles、不递归', async () => {
    fs.writeFileSync(path.join(tmpdir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(tmpdir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpdir, '.hidden'), 'h');
    fs.mkdirSync(path.join(tmpdir, 'sub'));
    fs.writeFileSync(path.join(tmpdir, 'sub', 'inner.txt'), 'i'); // 不递归:不应出现

    const text = await run({});
    expect(text).toBe('.hidden\na.txt\nb.txt\nsub/');
  });

  it('path 省略时列 cwd;显式相对 path 相对 cwd 解析', async () => {
    fs.mkdirSync(path.join(tmpdir, 'sub'));
    fs.writeFileSync(path.join(tmpdir, 'sub', 'only.txt'), 'x');

    expect(await run({ path: 'sub' })).toBe('only.txt');
  });

  it('空目录返回占位文案而非空串', async () => {
    expect(await run({})).toBe('(empty directory)');
  });

  it('.gitignore 忽略的目录仍列出名字(ls 不做过滤)', async () => {
    fs.writeFileSync(path.join(tmpdir, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(tmpdir, 'node_modules'));
    fs.writeFileSync(path.join(tmpdir, 'index.ts'), '');

    expect(await run({})).toBe('.gitignore\nindex.ts\nnode_modules/');
  });
});

describe('ls:limit 截断', () => {
  it('超 limit 截断并附规格文案', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      fs.writeFileSync(path.join(tmpdir, `${name}.txt`), '');
    }
    const text = await run({ limit: 3 });
    expect(text).toBe(
      'a.txt\nb.txt\nc.txt\n(Showing first 3 of 7 entries. Use glob for targeted listing.)',
    );
  });

  it('默认 limit 500:505 个条目只显示前 500', async () => {
    for (let i = 0; i < 505; i++) {
      fs.writeFileSync(path.join(tmpdir, `f${String(i).padStart(4, '0')}.txt`), '');
    }
    const text = await run({});
    const lines = text.split('\n');
    expect(lines).toHaveLength(501); // 500 条目 + 1 行提示
    expect(lines[0]).toBe('f0000.txt');
    expect(lines[499]).toBe('f0499.txt');
    expect(lines[500]).toBe('(Showing first 500 of 505 entries. Use glob for targeted listing.)');
  });

  it('条目数恰等于 limit 时不附截断提示', async () => {
    fs.writeFileSync(path.join(tmpdir, 'a.txt'), '');
    fs.writeFileSync(path.join(tmpdir, 'b.txt'), '');
    expect(await run({ limit: 2 })).toBe('a.txt\nb.txt');
  });
});

describe('ls:错误路径', () => {
  it('path 指向文件 → Not a directory 文案引导 read', async () => {
    fs.writeFileSync(path.join(tmpdir, 'file.txt'), 'x');
    await expect(run({ path: 'file.txt' })).rejects.toThrow(
      'Not a directory: file.txt (did you mean the read tool?)',
    );
  });

  it('path 不存在 → Directory not found', async () => {
    await expect(run({ path: 'nope' })).rejects.toThrow('Directory not found: nope');
  });

  it('signal 已 abort → 报 User aborted the directory listing(文案对齐 grep/bash)', async () => {
    fs.writeFileSync(path.join(tmpdir, 'a.txt'), '');
    const ac = new AbortController();
    ac.abort();
    const ctx: ToolContext = { cwd: tmpdir, signal: ac.signal, fileTracker: new FileTracker() };
    await expect(lsTool.execute({ id: 'call_ls', args: {} }, ctx)).rejects.toThrow(
      'User aborted the directory listing',
    );
  });
});

describe('ls:定义与 schema', () => {
  it('kind 为 read(权限直通档)', () => {
    expect(lsTool.kind).toBe('read');
    expect(lsTool.name).toBe('ls');
    expect(lsTool.executionMode).toBeUndefined();
  });

  it('schema 可渲染为 JSON Schema 且 path 描述含 opencode 实战原话', () => {
    const schema = z.toJSONSchema(lsTool.parameters) as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties['path']?.description).toContain("do NOT pass 'undefined' or 'null'");
    expect(schema.properties['limit']?.description).toContain('default 500');
  });
});
