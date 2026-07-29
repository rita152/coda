// resume 选择器单测(规格见 docs/09-cli.md §2):TTY 下编号选择;非 TTY 或空列表
// 返回 undefined,列表打到 stderr(stdout 是内容通道,选择器绝不污染)。

import { PassThrough } from 'node:stream';
import { expect, test } from 'bun:test';
import { pickSessionInteractive } from '../src/cli/resume-picker.js';
import type { SessionListItem } from '../src/session/index.js';

const MODEL = { provider: 'faux', api: 'faux', model: 'test' };

function items(...titles: string[]): SessionListItem[] {
  return titles.map((title, i) => ({
    id: `20260727-10000${i}-ab${i}d`,
    createdAt: 1753600000000 + i * 1000,
    cwd: '/tmp/x',
    model: MODEL,
    title,
  }));
}

/** 可注入的假终端:input 可标记 isTTY,output 收集写入内容。 */
function fakeIO(opts: { tty: boolean }): {
  input: PassThrough & { isTTY?: boolean };
  output: PassThrough;
  written: () => string;
} {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = opts.tty;
  const output = new PassThrough();
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
  });
  return { input, output, written: () => buf };
}

test('空列表:返回 undefined,提示走 stderr 通道', async () => {
  const io = fakeIO({ tty: true });
  await expect(pickSessionInteractive([], io)).resolves.toBeUndefined();
  expect(io.written()).toContain('no sessions found');
});

test('非 TTY:打印列表后返回 undefined,不等待输入', async () => {
  const io = fakeIO({ tty: false });
  const list = items('first session', 'second session');
  await expect(pickSessionInteractive(list, io)).resolves.toBeUndefined();
  const out = io.written();
  expect(out).toContain('[1]');
  expect(out).toContain(list[0]?.id ?? '');
  expect(out).toContain('first session');
});

test('TTY:编号选择返回对应会话 id;列表含 id + 标题 + 时间', async () => {
  const io = fakeIO({ tty: true });
  const list = items('first session', 'second session');
  const picked = pickSessionInteractive(list, io);
  io.input.write('2\n');
  await expect(picked).resolves.toBe(list[1]?.id);
  const out = io.written();
  expect(out).toContain(`[2] ${list[1]?.id ?? ''}`);
  expect(out).toContain('second session');
  expect(out).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // 时间列
});

test('TTY:直接输入 id 亦可;空输入与无匹配输入取消(undefined)', async () => {
  const list = items('a', 'b');

  const byId = fakeIO({ tty: true });
  const p1 = pickSessionInteractive(list, byId);
  byId.input.write(`${list[0]?.id ?? ''}\n`);
  await expect(p1).resolves.toBe(list[0]?.id);

  const empty = fakeIO({ tty: true });
  const p2 = pickSessionInteractive(list, empty);
  empty.input.write('\n');
  await expect(p2).resolves.toBeUndefined();

  const bogus = fakeIO({ tty: true });
  const p3 = pickSessionInteractive(list, bogus);
  bogus.input.write('99\n');
  await expect(p3).resolves.toBeUndefined();
});
