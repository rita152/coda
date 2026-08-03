// read 工具 L3 测试:真实文件系统 + tmpdir 隔离
// (docs/10-testing.md §6.3 read 行;docs/07-tools.md §5 read 验收行:
// 行号前缀/三态结尾/二进制拒读/图片 ImagePart/相似候选/offset 越界/FileTracker 登记/单行截断)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { FileTracker, MAX_OUTPUT_LINES } from '../shared/index.js';
import {
  READ_PROMPT_SNIPPET,
  executeRead,
  readParameters,
} from './read.js';
import type { ToolContext } from './types.js';

// String.prototype.isWellFormed 是 ES2024 API(Node ≥ 20 运行时可用);
// tsconfig lib 钉在 ES2023,此处补类型声明供代理对测试使用。
declare global {
  interface String {
    isWellFormed(): boolean;
  }
}

let tmpdir: string;
let fileTracker: FileTracker;
let ctx: ToolContext;

beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), 'coda-read-test-'));
  fileTracker = new FileTracker();
  ctx = { cwd: tmpdir, signal: new AbortController().signal, fileTracker };
});

afterEach(() => {
  rmSync(tmpdir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const abs = path.join(tmpdir, name);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

async function run(args: { path: string; offset?: number; limit?: number }) {
  return executeRead({ id: 'call_1', args }, ctx);
}

function textOf(out: Awaited<ReturnType<typeof run>>): string {
  const part = out.content[0];
  if (part?.type !== 'text') throw new Error('expected TextPart');
  return part.text;
}

describe('read:schema 与元数据', () => {
  it('zod schema 渲染 JSON Schema 无报错,每个字段有 description(docs/07 §5 框架验收)', () => {
    const js = z.toJSONSchema(readParameters) as {
      properties: Record<string, { description?: string }>;
    };
    expect(Object.keys(js.properties).sort()).toEqual(['limit', 'offset', 'path']);
    for (const prop of Object.values(js.properties)) {
      expect(prop.description).toBeTruthy();
    }
    expect(READ_PROMPT_SNIPPET).toMatch(/line-number prefix/);
  });
});

describe('read:行号与三态结尾', () => {
  it('行号前缀 N: text + 读完态文案', async () => {
    write('a.ts', "import { z } from 'zod';\n\nexport const config = {\n");
    const out = await run({ path: 'a.ts' });
    expect(textOf(out)).toBe(
      [
        "1: import { z } from 'zod';",
        '2: ',
        '3: export const config = {',
        '(End of file - total 3 lines)',
      ].join('\n'),
    );
    expect(out.details?.truncated).toBe(false);
    expect(out.details?.totalLines).toBe(3);
  });

  it('offset/limit 1-indexed:中段读取 + 行数截断态含下一步 offset', async () => {
    write('ten.txt', Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'));
    const out = await run({ path: 'ten.txt', offset: 3, limit: 2 });
    expect(textOf(out)).toBe(
      ['3: L3', '4: L4', '[Showing lines 3-4 of 10. Use offset=5 to continue.]'].join('\n'),
    );
    expect(out.details?.truncated).toBe(true);
  });

  it('limit 恰到文件末尾:是读完态而非截断态', async () => {
    write('five.txt', Array.from({ length: 5 }, (_, i) => `L${i + 1}`).join('\n'));
    const out = await run({ path: 'five.txt', offset: 4, limit: 2 });
    expect(textOf(out)).toBe(['4: L4', '5: L5', '(End of file - total 5 lines)'].join('\n'));
    expect(out.details?.truncated).toBe(false);
  });

  it('默认 2000 行上限:超长文件行数截断', async () => {
    write('big.txt', Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join('\n'));
    const out = await run({ path: 'big.txt' });
    const lines = textOf(out).split('\n');
    expect(lines).toHaveLength(MAX_OUTPUT_LINES + 1); // 2000 行 + 结尾提示
    expect(lines[0]).toBe('1: L1');
    expect(lines[1999]).toBe('2000: L2000');
    expect(lines[2000]).toBe('[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]');
    expect(out.details?.truncated).toBe(true);
    expect(out.details?.totalLines).toBe(2500);
  });

  it('字节截断:命中 48KB 上限即停,文案给出下一步 offset', async () => {
    // 每行 1000 字符 + '\n' = 1001 字节;48*1024/1001 → 恰好保留 49 行
    write('wide.txt', Array.from({ length: 100 }, () => 'a'.repeat(1000)).join('\n'));
    const out = await run({ path: 'wide.txt' });
    const lines = textOf(out).split('\n');
    expect(lines).toHaveLength(50); // 49 行内容 + 结尾提示
    expect(lines[48]).toBe(`49: ${'a'.repeat(1000)}`);
    expect(lines[49]).toBe('[Output capped at 50KB at line 49. Use offset=50 to continue.]');
    expect(out.details?.truncated).toBe(true);
    expect(out.details?.totalLines).toBeUndefined(); // 提前收流,总行数未知
  });

  it('单行 2000 字符截断', async () => {
    write('long-line.txt', `${'x'.repeat(2500)}\nshort`);
    const out = await run({ path: 'long-line.txt' });
    const lines = textOf(out).split('\n');
    expect(lines[0]).toBe(`1: ${'x'.repeat(2000)}...`);
    expect(lines[1]).toBe('2: short');
  });

  it('单行截断不劈开代理对:emoji 跨 2000 边界时整个字符留在截断线外', async () => {
    // emoji 占 2 个 code unit(位置 1999-2000):按 code unit 硬切会留下孤立高位代理
    write('emoji.txt', `${'x'.repeat(1999)}😀${'y'.repeat(50)}`);
    const out = await run({ path: 'emoji.txt' });
    const line = textOf(out).split('\n')[0] as string;
    expect(line.isWellFormed()).toBe(true);
    expect(line).toBe(`1: ${'x'.repeat(1999)}...`);
  });

  it('单行截断:代理对完整落在边界内时不误删(emoji 恰在 1999-2000 之内)', async () => {
    write('emoji-fit.txt', `${'x'.repeat(1998)}😀${'y'.repeat(50)}`);
    const out = await run({ path: 'emoji-fit.txt' });
    const line = textOf(out).split('\n')[0] as string;
    expect(line.isWellFormed()).toBe(true);
    expect(line).toBe(`1: ${'x'.repeat(1998)}😀...`);
  });

  it('空文件:读完态 total 0 lines', async () => {
    write('empty.txt', '');
    expect(textOf(await run({ path: 'empty.txt' }))).toBe('(End of file - total 0 lines)');
  });

  it('空文件 + 显式 offset=1:与省略 offset 一致返回读完态,offset=2 仍越界', async () => {
    write('empty2.txt', '');
    expect(textOf(await run({ path: 'empty2.txt', offset: 1 }))).toBe('(End of file - total 0 lines)');
    await expect(run({ path: 'empty2.txt', offset: 2 })).rejects.toThrow(
      'Offset 2 is out of range for this file (0 lines).',
    );
  });
});

describe('read:二进制与图片', () => {
  it('4KB 采样含 NUL:拒读', async () => {
    write('nul.txt', Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    await expect(run({ path: 'nul.txt' })).rejects.toThrow('Cannot read binary file: nul.txt');
  });

  it('不可打印占比 > 30%:拒读', async () => {
    // 一半字节是控制字符(0x01),无 NUL
    const buf = Buffer.alloc(200);
    for (let i = 0; i < 200; i++) buf[i] = i % 2 === 0 ? 0x01 : 0x61;
    write('ctrl.txt', buf);
    await expect(run({ path: 'ctrl.txt' })).rejects.toThrow('Cannot read binary file: ctrl.txt');
  });

  it('扩展名黑名单:内容为纯文本也拒读', async () => {
    write('a.zip', 'plain text inside');
    await expect(run({ path: 'a.zip' })).rejects.toThrow('Cannot read binary file: a.zip');
  });

  it('图片转 base64 ImagePart 返回,且登记 FileTracker', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const abs = write('pixel.png', png);
    const out = await run({ path: 'pixel.png' });
    expect(out.content).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(fileTracker.hasRead(abs)).toBe(true);
  });
});

describe('read:错误路径', () => {
  it('文件不存在:同目录互为子串候选,最多 3 个', async () => {
    write('foo.ts', 'a');
    write('foo.test.ts', 'a');
    write('foo.spec.ts', 'a');
    write('utils-foo.ts', 'a');
    write('bar.md', 'a');
    const err = await run({ path: 'foo' }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('File not found: foo');
    expect(msg).toContain('Did you mean one of these?');
    const suggested = msg.split('\n').filter((l) => l.startsWith('  '));
    expect(suggested).toHaveLength(3); // 4 个匹配名截到 3
    expect(msg).not.toContain('bar.md');
  });

  it('文件不存在且无候选:仅 File not found', async () => {
    const err = await run({ path: 'nope.txt' }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe('File not found: nope.txt');
  });

  it('offset 越界:显式报错并带总行数', async () => {
    write('five.txt', 'a\nb\nc\nd\ne');
    await expect(run({ path: 'five.txt', offset: 10 })).rejects.toThrow(
      'Offset 10 is out of range for this file (5 lines).',
    );
  });

  it('路径是目录:报错并指向 ls', async () => {
    mkdirSync(path.join(tmpdir, 'sub'));
    await expect(run({ path: 'sub' })).rejects.toThrow(/directory/);
  });

  it('>20MB 文件:直接拒读', async () => {
    // 21MB 的纯文本(写入很快,只是占磁盘;afterEach 会清理)
    write('huge.txt', 'a'.repeat(21 * 1024 * 1024));
    await expect(run({ path: 'huge.txt' })).rejects.toThrow(/too large/);
  });

  it('signal 已 abort:读取中断报错', async () => {
    write('a.txt', 'hello');
    const ac = new AbortController();
    ac.abort();
    const aborted: ToolContext = { cwd: tmpdir, signal: ac.signal, fileTracker };
    await expect(executeRead({ id: 'call_1', args: { path: 'a.txt' } }, aborted)).rejects.toThrow(
      /aborted/i,
    );
  });

  it('异步读取期间 abort:图片与空文件均不返回、不登记 FileTracker', async () => {
    const cases: [string, string | Buffer][] = [
      ['empty.txt', ''],
      [
        'pixel.png',
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ],
    ];

    for (const [name, content] of cases) {
      const abs = write(name, content);
      const ac = new AbortController();
      const aborting: ToolContext = { cwd: tmpdir, signal: ac.signal, fileTracker };
      queueMicrotask(() => ac.abort());

      await expect(executeRead({ id: 'call_1', args: { path: name } }, aborting)).rejects.toThrow(/aborted/i);
      expect(fileTracker.hasRead(abs)).toBe(false);
    }
  });
});

describe('read:FileTracker 登记', () => {
  it('读取成功后按 resolve 后绝对路径登记,assertFresh 通过', async () => {
    const abs = write('sub/file.txt', 'content');
    await run({ path: 'sub/file.txt' }); // 相对 cwd 的路径
    expect(fileTracker.hasRead(abs)).toBe(true);
    const { statSync } = await import('node:fs');
    expect(fileTracker.assertFresh(abs, statSync(abs).mtimeMs)).toEqual({ ok: true });
  });

  it('读取失败(二进制拒读)不登记', async () => {
    const abs = write('nul.txt', Buffer.from([0x00, 0x01]));
    await run({ path: 'nul.txt' }).catch(() => undefined);
    expect(fileTracker.hasRead(abs)).toBe(false);
  });
});
