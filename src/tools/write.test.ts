// write 工具测试(工具 Executor 与分层测试契约见 docs/07-tools.md、docs/10-testing.md)。
// L3:真实文件系统,每用例独立 tmpdir,FileTracker 每测试新建。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { FileTracker } from '../shared/index.js';
import type { ToolContext } from './types.js';
import {
  WRITE_DESCRIPTION,
  executeWrite,
  writeParameters,
  type WriteDetails,
} from './write.js';

let tmpdir: string;
let fileTracker: FileTracker;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coda-write-'));
  fileTracker = new FileTracker();
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: tmpdir, signal: new AbortController().signal, fileTracker, ...overrides };
}

function run(args: { path: string; content: string }, c: ToolContext = ctx()) {
  return executeWrite({ id: 'call_1', args }, c);
}

/** 模拟 read 工具的登记(read 工具单独交付,这里直接操作 FileTracker)。 */
function markReadNow(absPath: string): void {
  fileTracker.markRead(absPath, fs.statSync(absPath).mtimeMs);
}

function text(out: { content: { type: string; text?: string }[] }): string {
  return out.content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('');
}

describe('write:新建', () => {
  it('新文件自动创建多级父目录,内容逐字节写入', async () => {
    const out = await run({ path: 'a/b/c.txt', content: 'hello\nworld\n' });
    const abs = path.resolve(tmpdir, 'a/b/c.txt');
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello\nworld\n');
    expect(text(out)).toBe('Wrote 2 lines (0.0 KB) to a/b/c.txt');
  });

  it('新文件不受 read-before-edit 约束,成功后 FileTracker 已登记', async () => {
    await run({ path: 'new.txt', content: 'x\n' });
    const abs = path.resolve(tmpdir, 'new.txt');
    expect(fileTracker.hasRead(abs)).toBe(true);
    // 登记的 mtime 与磁盘一致 → 后续 edit/write 无需重新 read
    expect(fileTracker.assertFresh(abs, fs.statSync(abs).mtimeMs)).toEqual({ ok: true });
  });

  it('新文件的 diff:旧内容为空串,additions = 行数,deletions = 0', async () => {
    const out = await run({ path: 'n.txt', content: 'one\ntwo\nthree\n' });
    const details = out.details as WriteDetails;
    expect(details.diff).toContain('+one');
    expect(details.diff).toContain('+three');
    expect(details.additions).toBe(3);
    expect(details.deletions).toBe(0);
  });

  it('绝对路径参数同样生效,输出回显模型给的路径形态', async () => {
    const abs = path.join(tmpdir, 'abs.txt');
    const out = await run({ path: abs, content: 'a\n' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('a\n');
    expect(text(out)).toBe(`Wrote 1 lines (0.0 KB) to ${abs}`);
  });
});

describe('write:覆盖与 read-before-edit 硬约束', () => {
  it('覆盖未读文件 → throw never_read 文案,文件内容不变', async () => {
    const abs = path.join(tmpdir, 'f.txt');
    fs.writeFileSync(abs, 'original\n');
    await expect(run({ path: 'f.txt', content: 'clobber\n' })).rejects.toThrow(
      'File has not been read in this session. Use the read tool first.',
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe('original\n');
  });

  it('read 后覆盖成功,输出确认行', async () => {
    const abs = path.join(tmpdir, 'f.txt');
    fs.writeFileSync(abs, 'old\n');
    markReadNow(abs);
    const out = await run({ path: 'f.txt', content: 'new content\n' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('new content\n');
    expect(text(out)).toBe('Wrote 1 lines (0.0 KB) to f.txt');
  });

  it('read 后被外部改动(mtime 变新)再覆盖 → throw stale 文案', async () => {
    const abs = path.join(tmpdir, 'f.txt');
    fs.writeFileSync(abs, 'v1\n');
    markReadNow(abs);
    // 外部修改:显式把 mtime 拨快 5 秒,不依赖文件系统时间粒度
    const later = new Date(Date.now() + 5_000);
    fs.writeFileSync(abs, 'v2 external\n');
    fs.utimesSync(abs, later, later);
    await expect(run({ path: 'f.txt', content: 'clobber\n' })).rejects.toThrow(
      'File has been modified since it was last read. Re-read it to see the current content.',
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe('v2 external\n');
  });

  it('write 后不重新 read 直接再次写同一文件 → 成功(markRead 生效,同 edit 约束路径)', async () => {
    await run({ path: 'f.txt', content: 'first\n' });
    // 第二次覆盖走的正是 assertFresh 硬约束分支——未重新 read 仍应放行
    await run({ path: 'f.txt', content: 'second\n' });
    const abs = path.join(tmpdir, 'f.txt');
    expect(fs.readFileSync(abs, 'utf8')).toBe('second\n');
    expect(fileTracker.assertFresh(abs, fs.statSync(abs).mtimeMs)).toEqual({ ok: true });
  });

  it('目标是目录 → throw,不误报 read-before-edit', async () => {
    fs.mkdirSync(path.join(tmpdir, 'd'));
    await expect(run({ path: 'd', content: 'x\n' })).rejects.toThrow('Cannot write to d: it is a directory.');
  });
});

describe('write:BOM / CRLF 风格保留', () => {
  it('原文件 CRLF:content 的 LF 全部转回 CRLF', async () => {
    const abs = path.join(tmpdir, 'crlf.txt');
    fs.writeFileSync(abs, 'a\r\nb\r\n');
    markReadNow(abs);
    await run({ path: 'crlf.txt', content: 'x\ny\nz\n' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('x\r\ny\r\nz\r\n');
  });

  it('原文件带 UTF-8 BOM:覆盖后 BOM 保留在首部', async () => {
    const abs = path.join(tmpdir, 'bom.txt');
    fs.writeFileSync(abs, '\uFEFFhello\n');
    markReadNow(abs);
    await run({ path: 'bom.txt', content: 'world\n' });
    const bytes = fs.readFileSync(abs);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toBe('\uFEFFworld\n');
  });

  it('BOM + CRLF 同时存在:两种风格都保留', async () => {
    const abs = path.join(tmpdir, 'both.txt');
    fs.writeFileSync(abs, '\uFEFFa\r\nb\r\n');
    markReadNow(abs);
    await run({ path: 'both.txt', content: 'p\nq\n' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('\uFEFFp\r\nq\r\n');
  });

  it('原文件 LF、新文件:不做任何风格改写', async () => {
    const abs = path.join(tmpdir, 'lf.txt');
    fs.writeFileSync(abs, 'a\n');
    markReadNow(abs);
    await run({ path: 'lf.txt', content: 'b\nc\n' });
    expect(fs.readFileSync(abs, 'utf8')).toBe('b\nc\n');
  });
});

describe('write:details diff', () => {
  it('覆盖时 diff 含旧行(-)与新行(+),additions/deletions 统计正确', async () => {
    const abs = path.join(tmpdir, 'f.ts');
    fs.writeFileSync(abs, 'keep\nold line\n');
    markReadNow(abs);
    const out = await run({ path: 'f.ts', content: 'keep\nnew line\nadded\n' });
    const details = out.details as WriteDetails;
    expect(details.diff).toContain('-old line');
    expect(details.diff).toContain('+new line');
    expect(details.diff).toContain('+added');
    expect(details.additions).toBe(2);
    expect(details.deletions).toBe(1);
  });

  it("内容行以 '++'/'--' 开头不被误判为 diff 文件头:additions/deletions 精确", async () => {
    // 新建:'+++x' 是内容行 '++x' 的增行,不是文件头,必须计入 additions
    const out1 = await run({ path: 'plus.txt', content: 'normal\n++x\n--y\n' });
    const d1 = out1.details as WriteDetails;
    expect(d1.additions).toBe(3);
    expect(d1.deletions).toBe(0);

    // 覆盖删除 '--y' 行:'---y' 同样是内容删行,必须计入 deletions
    const out2 = await run({ path: 'plus.txt', content: 'normal\n++x\n' });
    const d2 = out2.details as WriteDetails;
    expect(d2.additions).toBe(0);
    expect(d2.deletions).toBe(1);
  });

  it('CRLF 原文件的 diff 在 LF 空间生成(未变行不因行尾差异出现在 diff)', async () => {
    const abs = path.join(tmpdir, 'f.txt');
    fs.writeFileSync(abs, 'same\r\nchange me\r\n');
    markReadNow(abs);
    const out = await run({ path: 'f.txt', content: 'same\nchanged\n' });
    const details = out.details as WriteDetails;
    expect(details.additions).toBe(1);
    expect(details.deletions).toBe(1);
    expect(details.diff).not.toContain('-same');
  });
});

describe('write:abort 与 schema', () => {
  it('signal 已 abort → throw,文件不落盘', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run({ path: 'f.txt', content: 'x\n' }, ctx({ signal: ac.signal }))).rejects.toThrow(
      'User aborted the write; the file was not modified.',
    );
    expect(fs.existsSync(path.join(tmpdir, 'f.txt'))).toBe(false);
  });

  it('description 引导 edit 优先', () => {
    expect(WRITE_DESCRIPTION).toContain(
      'Prefer the edit tool for modifying existing files; use write only for new files or intentional full rewrites',
    );
  });

  it('参数 schema 可渲染为 JSON Schema 且每个字段带 description', () => {
    const schema = z.toJSONSchema(writeParameters) as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['content', 'path']);
    expect(schema.properties['path']?.description).toContain('Parent directories are created automatically');
    expect(schema.properties['content']?.description).toContain('replaces the entire file');
  });

  it('空内容:0 lines,写出空文件', async () => {
    const out = await run({ path: 'empty.txt', content: '' });
    expect(fs.readFileSync(path.join(tmpdir, 'empty.txt'), 'utf8')).toBe('');
    expect(text(out)).toBe('Wrote 0 lines (0.0 KB) to empty.txt');
  });
});
