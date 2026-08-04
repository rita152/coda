// grep 工具测试(L3:真实文件系统 + 真实 rg 子进程,见 docs/10-testing.md 的分层测试)。
// 每用例独立 tmpdir 作 ToolContext.cwd,afterEach 清理;FileTracker 每测试新建。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FileTracker } from '../shared/index.js';
import type { ToolContext, ToolOutput } from './types.js';
import {
  GREP_ABORTED_MESSAGE,
  MORE_MATCHES_NOTE,
  executeGrep,
} from './grep.js';
import type { GrepArgs } from './grep.js';

let tmpdir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpdir = mkdtempSync(path.join(os.tmpdir(), 'coda-grep-'));
  ctx = { cwd: tmpdir, signal: new AbortController().signal, fileTracker: new FileTracker() };
});

afterEach(() => {
  rmSync(tmpdir, { recursive: true, force: true });
});

/** 在 tmpdir 下写 fixture 文件(自动建父目录)。 */
function write(rel: string, content: string): void {
  const abs = path.join(tmpdir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function run(args: GrepArgs, context: ToolContext = ctx): ReturnType<typeof executeGrep> {
  return executeGrep({ id: 'call_1', args }, context);
}

function textOf(out: ToolOutput): string {
  const part = out.content[0];
  if (part === undefined || part.type !== 'text') throw new Error('expected a text part');
  return part.text;
}

async function runText(args: GrepArgs): Promise<string> {
  return textOf(await run(args));
}

describe('grep:基本匹配', () => {
  it('正则模式:命中行以 path:line: text 输出,行号 1-indexed', async () => {
    write('a.txt', 'foo1\nbar\nfoo22\n');
    const text = await runText({ pattern: String.raw`foo\d+` });
    expect(text.split('\n')).toEqual(['a.txt:1: foo1', 'a.txt:3: foo22']);
  });

  it('--hidden 下 dotfiles 可搜,但 .git/ 仍被排除', async () => {
    write('.env.example', 'secret_pattern=1\n');
    write('.git/config', 'secret_pattern=2\n');
    write('src/a.ts', 'secret_pattern=3\n');
    const text = await runText({ pattern: 'secret_pattern' });
    expect(text).toContain('.env.example:1:');
    expect(text).toContain('src/a.ts:1:');
    expect(text).not.toContain('.git/config');
  });

  it('literal 模式:pattern 按 fixed string 匹配,正则元字符不生效', async () => {
    write('a.txt', 'f.o\nfoo\n(unclosed\n');
    // 'f.o' 作正则可匹配 foo;literal 下只命中字面 f.o
    const text = await runText({ pattern: 'f.o', literal: true });
    expect(text.split('\n')).toEqual(['a.txt:1: f.o']);
    // 非法正则在 literal 下照常可搜
    const text2 = await runText({ pattern: '(unclosed', literal: true });
    expect(text2.split('\n')).toEqual(['a.txt:3: (unclosed']);
  });

  it('无匹配(rg exit 1)返回 "No matches found",不是错误', async () => {
    write('a.txt', 'hello\n');
    const text = await runText({ pattern: 'zzz-not-there' });
    expect(text).toBe('No matches found');
  });

  it('非法正则(rg exit ≥ 2)throw,错误消息附 stderr', async () => {
    write('a.txt', 'hello\n');
    await expect(run({ pattern: '(unclosed' })).rejects.toThrow(/ripgrep exited with code 2/);
    await expect(run({ pattern: '(unclosed' })).rejects.toThrow(/regex parse error/);
  });

  it('ignoreCase:大小写不敏感开关生效', async () => {
    write('a.txt', 'Hello World\n');
    expect(await runText({ pattern: 'hello' })).toBe('No matches found');
    const text = await runText({ pattern: 'hello', ignoreCase: true });
    expect(text.split('\n')).toEqual(['a.txt:1: Hello World']);
  });

  it('glob 过滤:只搜命中 glob 的文件', async () => {
    write('a.ts', 'needle in ts\n');
    write('b.md', 'needle in md\n');
    const text = await runText({ pattern: 'needle', glob: '*.ts' });
    expect(text.split('\n')).toEqual(['a.ts:1: needle in ts']);
    expect(text).not.toContain('b.md');
  });

  it('path 参数:限定到子目录', async () => {
    write('sub/inner.txt', 'needle here\n');
    write('outer.txt', 'needle there\n');
    const text = await runText({ pattern: 'needle', path: 'sub' });
    expect(text.split('\n')).toEqual(['sub/inner.txt:1: needle here']);
  });

  it('.gitignore 在非 git 目录同样生效(--no-require-git,与 glob 一致)', async () => {
    // tmpdir 不是 git 仓库:没有 --no-require-git 时 rg 会无视 .gitignore,ignored.txt 被搜到 → 用例红
    write('.gitignore', 'ignored.txt\n');
    write('ignored.txt', 'gi-needle in ignored\n');
    write('kept.txt', 'gi-needle in kept\n');
    const text = await runText({ pattern: 'gi-needle' });
    expect(text.split('\n')).toEqual(['kept.txt:1: gi-needle in kept']);
  });

  it('非 UTF-8 行(rg --json 的 bytes 形态):降级解码计为 match,不静默丢弃', async () => {
    // 0xFF 不是任何合法 UTF-8 序列(且非 NUL,rg 不会按二进制跳过该文件):
    // rg --json 对该行输出 {"bytes": "<base64>"} 而非 {"text": ...}
    writeFileSync(
      path.join(tmpdir, 'bin.txt'),
      Buffer.concat([Buffer.from([0xff]), Buffer.from(' NEEDLE tail\n', 'utf8')]),
    );
    const text = await runText({ pattern: 'NEEDLE' });
    expect(text).not.toBe('No matches found');
    expect(text).toContain('bin.txt:1:');
    expect(text).toContain('NEEDLE tail');
    expect(text).toContain('�'); // 不可解码字节 0xFF → 替换符,而非丢整行
  });

  it('多文件命中:输出按文件分组(同文件的行连续)', async () => {
    write('x.txt', 'pin 1\npin 2\n');
    write('y.txt', 'pin 3\npin 4\n');
    const lines = (await runText({ pattern: 'pin' })).split('\n');
    expect(lines).toHaveLength(4);
    // 文件间顺序由 rg 决定,只断言分组连续性
    const files = lines.map((l) => l.split(':')[0]);
    expect(files[0]).toBe(files[1]);
    expect(files[2]).toBe(files[3]);
    expect(files[0]).not.toBe(files[2]);
  });
});

describe('grep:行长截断', () => {
  it('单行截到 500 字符', async () => {
    const long = 'NEEDLE' + 'x'.repeat(600);
    write('long.txt', `${long}\nshort NEEDLE\n`);
    const lines = (await runText({ pattern: 'NEEDLE' })).split('\n');
    expect(lines).toHaveLength(2);
    const first = lines[0] ?? '';
    expect(first.startsWith('long.txt:1: NEEDLE')).toBe(true);
    expect(first.length).toBe('long.txt:1: '.length + 500);
    expect(lines[1]).toBe('long.txt:2: short NEEDLE');
  });
});

describe('grep:context 切片', () => {
  it('context=1:自读文件切片,context 行用 path-line- text 格式', async () => {
    write('ctx.txt', 'L1\nL2\nhit\nL4\nL5\n');
    const text = await runText({ pattern: 'hit', context: 1 });
    expect(text.split('\n')).toEqual(['ctx.txt-2- L2', 'ctx.txt:3: hit', 'ctx.txt-4- L4']);
  });

  it('文件边界:首行命中不产生 0/负数行号,尾行命中不越界', async () => {
    write('edge.txt', 'hit-top\nmid\nhit-bottom\n');
    const text = await runText({ pattern: 'hit', context: 2 });
    expect(text.split('\n')).toEqual([
      'edge.txt:1: hit-top',
      'edge.txt-2- mid',
      'edge.txt:3: hit-bottom',
    ]);
  });

  it('相邻命中 context 区间重叠:合并去重,match 行格式优先', async () => {
    write('ov.txt', 'L1\nL2\nhitA\nL4\nhitB\nL6\nL7\n');
    const text = await runText({ pattern: 'hit', context: 2 });
    expect(text.split('\n')).toEqual([
      'ov.txt-1- L1',
      'ov.txt-2- L2',
      'ov.txt:3: hitA',
      'ov.txt-4- L4',
      'ov.txt:5: hitB',
      'ov.txt-6- L6',
      'ov.txt-7- L7',
    ]);
  });

  it('limit 只数 match,不数 context 行', async () => {
    write('c.txt', 'a1\nhit1\nb1\na2\nhit2\nb2\na3\nhit3\nb3\n');
    const lines = (await runText({ pattern: 'hit', context: 1, limit: 2 })).split('\n');
    // 2 个 match + 各自 context,尾附 more 提示;第三个 match 不出现
    expect(lines.filter((l) => l.includes(':')).length).toBe(2);
    expect(lines).not.toContain('c.txt:8: hit3');
    expect(lines[lines.length - 1]).toBe(MORE_MATCHES_NOTE);
  });
});

describe('grep:limit 与 kill', () => {
  it('大 fixture 下 match 数达 limit 即 kill rg:恰好 limit 条 + more 提示', async () => {
    // 40 文件 × 100 行 = 4000 个潜在 match,limit=25 → 早停
    for (let f = 0; f < 40; f++) {
      write(`big/f${String(f).padStart(2, '0')}.txt`, 'match-line\n'.repeat(100));
    }
    const lines = (await runText({ pattern: 'match-line', limit: 25 })).split('\n');
    // execute resolve 于进程 close 事件之后 → 返回即证明 rg 已退出(而非搜完 4000 条)
    const matchLines = lines.filter((l) => /:\d+: /.test(l));
    expect(matchLines).toHaveLength(25);
    expect(lines[lines.length - 1]).toBe(MORE_MATCHES_NOTE);
  });

  it('默认 limit 100', async () => {
    write('many.txt', 'row\n'.repeat(150));
    const lines = (await runText({ pattern: 'row' })).split('\n');
    expect(lines.filter((l) => /:\d+: /.test(l))).toHaveLength(100);
    expect(lines[lines.length - 1]).toBe(MORE_MATCHES_NOTE);
  });

  it('恰好未达 limit:不附 more 提示,details 报 limitReached/rgKilled 均 false', async () => {
    write('few.txt', 'row\nrow\n');
    const out = await run({ pattern: 'row', limit: 3 });
    expect(textOf(out).split('\n')).toEqual(['few.txt:1: row', 'few.txt:2: row']);
    expect(out.details).toEqual({ limitReached: false, rgKilled: false });
  });

  it('limit 早停可观测:details.rgKilled === true 证明 rg 确实被 kill', async () => {
    // 输出总量:12000 match × 每条 --json 事件约 600B ≈ 7MB,远超 64KB 管道缓冲。
    // limit=5 在首个 chunk 内即命中,此刻 rg 必然仍阻塞在写管道上、不可能已自然退出,
    // 因此 close code === null 只能来自我们的 kill——删掉 kill 则 rg 跑完(code 0),本用例红。
    write('huge.txt', ('X'.repeat(420) + ' kill-needle\n').repeat(12000));
    const out = await run({ pattern: 'kill-needle', limit: 5 });
    expect(out.details).toEqual({ limitReached: true, rgKilled: true });
    expect(textOf(out)).toContain(MORE_MATCHES_NOTE);
  });
});

describe('grep:abort', () => {
  it('signal 已触发:直接 throw,不 spawn', async () => {
    write('a.txt', 'hello\n');
    const controller = new AbortController();
    controller.abort();
    const aborted: ToolContext = { ...ctx, signal: controller.signal };
    await expect(run({ pattern: 'hello' }, aborted)).rejects.toThrow(GREP_ABORTED_MESSAGE);
  });

  it('执行中 abort:kill rg 并 throw', async () => {
    for (let f = 0; f < 20; f++) {
      write(`big/f${f}.txt`, 'match-line\n'.repeat(200));
    }
    const controller = new AbortController();
    const inflight: ToolContext = { ...ctx, signal: controller.signal };
    const p = run({ pattern: 'match-line', limit: 100000 }, inflight);
    controller.abort(); // spawn 与 abort 监听在 execute 首个 await 前同步完成,此刻必已挂上
    await expect(p).rejects.toThrow(GREP_ABORTED_MESSAGE);
  });
});
