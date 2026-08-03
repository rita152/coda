// edit 工具测试:docs/10-testing.md §6.1 矩阵 1–16 行 + prepareArguments 修补
// (docs/07-tools.md §1.4/§2.6)。真实文件系统,每用例独立 tmpdir,FileTracker 每测试新建。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { FileTracker } from '../shared/index.js';
import type { ToolContext } from './types.js';
import {
  editParameters,
  executeEdit,
  prepareEditArguments,
} from './edit.js';
import type { EditArgs, EditDetails } from './edit.js';

let tmpdir: string;
let ctx: ToolContext;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coda-edit-'));
  ctx = { cwd: tmpdir, signal: new AbortController().signal, fileTracker: new FileTracker() };
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

/** 建文件并模拟「本会话已 read」:登记当前 mtime(read 工具成功后的动作)。 */
function seed(rel: string, content: string | Buffer): string {
  const abs = path.join(tmpdir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  ctx.fileTracker.markRead(abs, fs.statSync(abs).mtimeMs);
  return abs;
}

function run(args: EditArgs) {
  return executeEdit({ id: 'call_1', args }, ctx);
}

function textOf(out: { content: { type: string; text?: string }[] }): string {
  return out.content.map((p) => ('text' in p ? p.text : '')).join('');
}

describe('edit:精确匹配层(矩阵 1–5)', () => {
  it('1. 精确匹配单处命中:替换成功,details 含合法 unified diff 与增删统计', async () => {
    const abs = seed('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const out = await run({ path: 'a.ts', edits: [{ oldText: 'const b = 2;', newText: 'const b = 42;' }] });

    expect(textOf(out)).toBe('Applied 1 edit(s) to a.ts');
    expect(fs.readFileSync(abs, 'utf8')).toBe('const a = 1;\nconst b = 42;\nconst c = 3;\n');
    const details = out.details as EditDetails;
    expect(details.diff).toContain('@@');
    expect(details.diff).toContain('-const b = 2;');
    expect(details.diff).toContain('+const b = 42;');
    expect(details.additions).toBe(1);
    expect(details.deletions).toBe(1);
    // diff 不回喂模型:content 只有一行确认文本
    expect(out.content).toHaveLength(1);
    expect(textOf(out)).not.toContain('@@');
  });

  it('2. oldText 出现 2 次且无 replaceAll:报错含次数与消歧建议,文件不动', async () => {
    const abs = seed('a.txt', 'x\ndup\ny\ndup\n');
    await expect(run({ path: 'a.txt', edits: [{ oldText: 'dup', newText: 'D' }] })).rejects.toThrow(
      /Found 2 occurrences of the text in a\.txt.*replaceAll: true/s,
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe('x\ndup\ny\ndup\n');
  });

  it('3. replaceAll: true 多处命中:全部替换', async () => {
    const abs = seed('a.txt', 'x\ndup\ny\ndup\n');
    const out = await run({ path: 'a.txt', edits: [{ oldText: 'dup', newText: 'D', replaceAll: true }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('x\nD\ny\nD\n');
    expect(textOf(out)).toBe('Applied 1 edit(s) to a.txt');
  });

  it('4. oldText === newText:无意义编辑报错', async () => {
    seed('a.txt', 'const a = 1;\n');
    await expect(
      run({ path: 'a.txt', edits: [{ oldText: 'const a = 1;', newText: 'const a = 1;' }] }),
    ).rejects.toThrow('No changes to apply: oldText and newText are identical.');
  });

  it('5. oldText 为空串:引导 write 工具', async () => {
    seed('a.txt', 'x\n');
    await expect(run({ path: 'a.txt', edits: [{ oldText: '', newText: 'y' }] })).rejects.toThrow(
      /write tool/,
    );
  });
});

describe('edit:文件形态(矩阵 6–7 + CRLF/BOM 往返)', () => {
  it('6. CRLF 文件 + LF 风格 oldText:剥离-匹配-还原,输出保持 CRLF', async () => {
    const abs = seed('win.txt', 'a\r\nb\r\nc\r\n');
    await run({ path: 'win.txt', edits: [{ oldText: 'b', newText: 'B' }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('7. UTF-8 BOM 文件:BOM 保留在输出首部', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const abs = seed('bom.txt', Buffer.concat([bom, Buffer.from('a\nb\n', 'utf8')]));
    await run({ path: 'bom.txt', edits: [{ oldText: 'a', newText: 'A' }] });
    const bytes = fs.readFileSync(abs);
    expect(bytes.subarray(0, 3)).toEqual(bom);
    expect(bytes.subarray(3).toString('utf8')).toBe('A\nb\n');
  });

  it('CRLF + BOM 组合:编辑一行,BOM/CRLF 双双保留,未触碰行不变', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const abs = seed('both.txt', Buffer.concat([bom, Buffer.from('a\r\nb\r\nc\r\n', 'utf8')]));
    await run({ path: 'both.txt', edits: [{ oldText: 'b', newText: 'B' }] });
    const bytes = fs.readFileSync(abs);
    expect(bytes.subarray(0, 3)).toEqual(bom);
    expect(bytes.subarray(3).toString('utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('混合行尾:只触碰一个 LF 行,其余行(含 CRLF 行)逐字节保留,不做全文统一', async () => {
    const abs = seed('mixed.txt', 'alpha\nbeta\r\ngamma\ndelta\n');
    await run({ path: 'mixed.txt', edits: [{ oldText: 'gamma', newText: 'GAMMA' }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('alpha\nbeta\r\nGAMMA\ndelta\n');
  });

  it('混合行尾:触碰 CRLF 行本身,该行行尾与未触碰的 LF 行都保留', async () => {
    const abs = seed('mixed2.txt', 'alpha\nbeta\r\ngamma\n');
    await run({ path: 'mixed2.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('alpha\nBETA\r\ngamma\n');
  });

  it('混合行尾 CRLF 多数:替换文本内部换行取多数风格,未触碰 LF 行原样保留', async () => {
    // 跨两个 CRLF 行的替换:新文本的内部换行应写成 CRLF,后面的 'c\n' 保持 LF
    const abs = seed('mixed3.txt', 'a\r\nb\r\nc\nd\r\n');
    await run({ path: 'mixed3.txt', edits: [{ oldText: 'a\nb', newText: 'X\nY' }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('X\r\nY\r\nc\nd\r\n');
  });
});

describe('edit:归一化 fuzzy 层(矩阵 8–11)', () => {
  it('8. 智能引号/em-dash:精确失败 → fuzzy 命中,未触碰行逐字节与原文件相等', async () => {
    const line1 = 'const other = “untouched”;'; // 未触碰行也含智能引号
    const line2 = 'const msg = “hello — world”;';
    const line3 = 'const done = true;';
    const abs = seed('smart.ts', `${line1}\n${line2}\n${line3}\n`);
    await run({
      path: 'smart.ts',
      edits: [{ oldText: 'const msg = "hello - world";', newText: 'const msg = "hi";' }],
    });
    // 行 overlay 断言:被触及行替换为 newText,其余行原始字节保留
    expect(fs.readFileSync(abs, 'utf8')).toBe(`${line1}\nconst msg = "hi";\n${line3}\n`);
  });

  it('9. NFKC 全角字符差异:fuzzy 命中且未触碰行保留原字节', async () => {
    const line1 = 'const label = 　"ｗｉｄｅ";'; // 未触碰行含全角
    const line2 = 'value ＝ fn(１２３);'; // ＝ 与全角数字/括号
    const abs = seed('wide.ts', `${line1}\n${line2}\n`);
    await run({ path: 'wide.ts', edits: [{ oldText: 'value = fn(123);', newText: 'value = fn(9);' }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe(`${line1}\nvalue = fn(9);\n`);
  });

  it('10. 行尾空白差异(trailing spaces):多行 oldText fuzzy 命中', async () => {
    const abs = seed('trail.ts', 'const a = 1;  \nconst b = 2;\nconst c = 3;\n');
    await run({
      path: 'trail.ts',
      edits: [{ oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 10;\nconst b = 20;' }],
    });
    expect(fs.readFileSync(abs, 'utf8')).toBe('const a = 10;\nconst b = 20;\nconst c = 3;\n');
  });

  it('11. 真实内容差异(改了词):fuzzy 不得命中,报错引导重读', async () => {
    const abs = seed('real.ts', 'const total = price * quantity;\n');
    await expect(
      run({ path: 'real.ts', edits: [{ oldText: 'const total = price * qty;', newText: 'x' }] }),
    ).rejects.toThrow(/Could not find the text to replace in real\.ts.*Re-read the file/s);
    expect(fs.readFileSync(abs, 'utf8')).toBe('const total = price * quantity;\n');
  });

  it('oldText 归一化后全空白(纯空格):不进 fuzzy,报标准未找到而非命中空行', async () => {
    const abs = seed('blank.txt', 'a\n\nb\n');
    await expect(run({ path: 'blank.txt', edits: [{ oldText: '   ', newText: 'X' }] })).rejects.toThrow(
      /Could not find the text to replace in blank\.txt/,
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe('a\n\nb\n');
  });

  it('oldText 为多个空白行:连续空行区不得被 fuzzy 命中(replaceAll 也一样)', async () => {
    const abs = seed('blanks.txt', 'a\n\n\nb\n');
    await expect(
      run({ path: 'blanks.txt', edits: [{ oldText: '  \n  ', newText: 'X', replaceAll: true }] }),
    ).rejects.toThrow(/Could not find the text to replace in blanks\.txt/);
    expect(fs.readFileSync(abs, 'utf8')).toBe('a\n\n\nb\n');
  });

  it('fuzzy 空间同样做唯一性检查:两处归一化命中报次数,replaceAll 则全部替换', async () => {
    const content = 'a  \nb\nc\na  \nb\nd\n'; // 'a\nb' 精确失败(行尾空格),fuzzy 命中两处
    const abs = seed('multi.txt', content);
    await expect(run({ path: 'multi.txt', edits: [{ oldText: 'a\nb', newText: 'X' }] })).rejects.toThrow(
      /Found 2 occurrences/,
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe(content);
    await run({ path: 'multi.txt', edits: [{ oldText: 'a\nb', newText: 'X', replaceAll: true }] });
    expect(fs.readFileSync(abs, 'utf8')).toBe('X\nc\nX\nd\n');
  });
});

describe('edit:read-before-edit 硬约束(矩阵 12–14)', () => {
  it('12. 未 read 直接 edit:never_read 报错', async () => {
    const abs = path.join(tmpdir, 'unread.txt');
    fs.writeFileSync(abs, 'x\n'); // 不登记 FileTracker
    await expect(run({ path: 'unread.txt', edits: [{ oldText: 'x', newText: 'y' }] })).rejects.toThrow(
      'File has not been read in this session. Use the read tool first.',
    );
  });

  it('13. read 后文件被外部修改再 edit:stale 报错,文件不动', async () => {
    const abs = seed('stale.txt', 'original\n');
    // 外部重写并把 mtime 拨新 10 秒,规避文件系统 mtime 粒度
    fs.writeFileSync(abs, 'externally changed\n');
    const now = fs.statSync(abs);
    fs.utimesSync(abs, now.atime, new Date(now.mtimeMs + 10_000));
    await expect(run({ path: 'stale.txt', edits: [{ oldText: 'original', newText: 'x' }] })).rejects.toThrow(
      'File has been modified since it was last read. Re-read it to see the current content.',
    );
    expect(fs.readFileSync(abs, 'utf8')).toBe('externally changed\n');
  });

  it('14. read → edit 成功 → 再 edit:成功写入后自动刷新登记', async () => {
    const abs = seed('twice.txt', 'v1\n');
    await run({ path: 'twice.txt', edits: [{ oldText: 'v1', newText: 'v2' }] });
    await run({ path: 'twice.txt', edits: [{ oldText: 'v2', newText: 'v3' }] }); // 未重新 read
    expect(fs.readFileSync(abs, 'utf8')).toBe('v3\n');
  });
});

describe('edit:多 edit 语义(矩阵 15)', () => {
  it('15a. 多 edits 全部对原始内容匹配,逆序应用互不干扰偏移', async () => {
    const abs = seed('multi.ts', 'alpha beta gamma\n');
    // 前一条 edit 拉长文本;若按顺序+失效偏移应用,后一条会错位
    const out = await run({
      path: 'multi.ts',
      edits: [
        { oldText: 'alpha', newText: 'ALPHA_MUCH_LONGER' },
        { oldText: 'gamma', newText: 'G' },
      ],
    });
    expect(fs.readFileSync(abs, 'utf8')).toBe('ALPHA_MUCH_LONGER beta G\n');
    expect(textOf(out)).toBe('Applied 2 edit(s) to multi.ts');
  });

  it('15b. 原子性:任一条匹配失败,整体不落盘', async () => {
    const abs = seed('atomic.ts', 'alpha beta\n');
    await expect(
      run({
        path: 'atomic.ts',
        edits: [
          { oldText: 'alpha', newText: 'A' },
          { oldText: 'missing', newText: 'x' },
        ],
      }),
    ).rejects.toThrow(/Could not find the text to replace/);
    expect(fs.readFileSync(abs, 'utf8')).toBe('alpha beta\n');
  });

  it('15c. 重叠 edits 报错,整体不落盘', async () => {
    const abs = seed('overlap.ts', 'abc def ghi\n');
    await expect(
      run({
        path: 'overlap.ts',
        edits: [
          { oldText: 'abc def', newText: 'x' },
          { oldText: 'def ghi', newText: 'y' },
        ],
      }),
    ).rejects.toThrow(/overlap/i);
    expect(fs.readFileSync(abs, 'utf8')).toBe('abc def ghi\n');
  });
});

describe('edit:并发串行化(矩阵 16)', () => {
  it('16. 同路径两个 execute 并发:per-path 锁串行执行,结果无交错', async () => {
    const abs = seed('race.txt', 'count = 0\n');
    // 两个调用同时瞄准同一段原文:串行化下先到者成功,后到者对新内容匹配失败;
    // 若未串行(同时读到原文),两者都会「成功」并以后写覆盖前写
    const p1 = run({ path: 'race.txt', edits: [{ oldText: 'count = 0', newText: 'count = 1' }] });
    const p2 = run({ path: 'race.txt', edits: [{ oldText: 'count = 0', newText: 'count = 2' }] });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(String((r2.reason as Error).message)).toMatch(/Could not find the text to replace/);
    }
    expect(fs.readFileSync(abs, 'utf8')).toBe('count = 1\n');
  });
});

describe('edit:prepareArguments 修补(docs/07 §1.4)', () => {
  const prepare = prepareEditArguments;

  it('edits 为 JSON 字符串:解析为数组后过 zod', () => {
    const prepared = prepare({
      path: 'a.ts',
      edits: '[{"oldText":"a","newText":"b"}]',
    });
    const parsed = editParameters.parse(prepared) as EditArgs;
    expect(parsed.edits).toEqual([{ oldText: 'a', newText: 'b' }]);
  });

  it('平铺 oldText/newText:包成 edits 数组', () => {
    const prepared = prepare({ path: 'a.ts', oldText: 'a', newText: 'b', replaceAll: true });
    const parsed = editParameters.parse(prepared) as EditArgs;
    expect(parsed.path).toBe('a.ts');
    expect(parsed.edits).toEqual([{ oldText: 'a', newText: 'b', replaceAll: true }]);
  });

  it('不可解析的 edits 字符串:保留原样,交给 zod 报错(不猜语义)', () => {
    const prepared = prepare({ path: 'a.ts', edits: 'not-json' });
    expect(() => editParameters.parse(prepared)).toThrow();
  });
});

describe('edit:框架契约与边界', () => {
  it('schema 可渲染为 JSON Schema 且字段带 description', () => {
    const schema = z.toJSONSchema(editParameters) as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.path?.description).toBeTruthy();
    expect(schema.properties.edits?.description).toBeTruthy();
  });

  it('文件不存在:File not found 并引导 write', async () => {
    await expect(run({ path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] })).rejects.toThrow(
      /File not found: nope\.txt.*write tool/,
    );
  });

  it('signal 已 abort:立即失败,不落盘', async () => {
    const abs = seed('abort.txt', 'x\n');
    const controller = new AbortController();
    controller.abort();
    const aborted: ToolContext = { ...ctx, signal: controller.signal };
    await expect(
      executeEdit(
        { id: 'call_1', args: { path: 'abort.txt', edits: [{ oldText: 'x', newText: 'y' }] } },
        aborted,
      ),
    ).rejects.toThrow(/aborted/);
    expect(fs.readFileSync(abs, 'utf8')).toBe('x\n');
  });
});
