// clipHead/clipTail 单元测试:行/字节双上限(谁先命中算谁)、行边界切割、
// 多字节安全、首行即超限的至少一行保证(规格见 docs/07-tools.md §1.6)。

import { describe, expect, it } from 'vitest';
import { clipHead, clipTail, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './truncate.js';

describe('clipHead', () => {
  it('行维度:超 maxLines 截到行数上限', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const r = clipHead(text, { maxLines: 3, maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('l1\nl2\nl3');
    expect(r.keptLines).toBe(3);
    expect(r.totalLines).toBe(5);
    expect(r.boundaryLine).toBe(3);
  });

  it('字节维度:行数未超但字节超限,按字节截(谁先命中算谁)', () => {
    // 每行 'aaaa' = 4 字节 + '\n' = 5 字节;maxBytes 12 → 保留 2 行(10 字节)
    const text = Array.from({ length: 10 }, () => 'aaaa').join('\n');
    const r = clipHead(text, { maxLines: 100, maxBytes: 12 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('aaaa\naaaa');
    expect(r.keptLines).toBe(2);
    expect(r.totalLines).toBe(10);
    expect(r.totalBytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('默认上限:100 行 × 1KB(<2000 行、>48KB)由字节维度触发截断,保留 ≤48KB', () => {
    const text = Array.from({ length: 100 }, () => 'x'.repeat(1023)).join('\n');
    const r = clipHead(text);   // 走默认 MAX_OUTPUT_LINES / MAX_OUTPUT_BYTES
    expect(r.truncated).toBe(true);
    expect(r.keptLines).toBeLessThan(100);
    expect(r.keptLines).toBeLessThan(MAX_OUTPUT_LINES);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('默认上限:3000 短行由行维度触发,保留 2000 行', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    const r = clipHead(text);
    expect(r.truncated).toBe(true);
    expect(r.keptLines).toBe(MAX_OUTPUT_LINES);
    expect(r.boundaryLine).toBe(MAX_OUTPUT_LINES);
  });

  it('多字节:切割落在行边界,不产出半个字符', () => {
    // 每行 4 个『好』= 12 字节 + '\n' = 13 字节;maxBytes 20 → 只保留第 1 行
    const line = '好'.repeat(4);
    const text = [line, line, line].join('\n');
    const r = clipHead(text, { maxLines: 100, maxBytes: 20 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(line);   // 完整的一行,无字节级劈开
    expect(r.keptLines).toBe(1);
  });

  it('首行即超限:仍保留该行(至少产出一行)', () => {
    const text = ['x'.repeat(50), 'rest'].join('\n');
    const r = clipHead(text, { maxLines: 100, maxBytes: 10 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('x'.repeat(50));
    expect(r.keptLines).toBe(1);
  });

  it('未超限:原文原样返回(含结尾换行),truncated=false', () => {
    const text = 'a\nb\n';
    const r = clipHead(text, { maxLines: 10, maxBytes: 1024 });
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);      // 不是 join 重组,是原文
    expect(r.totalLines).toBe(2);   // 结尾换行不多算一行
  });
});

describe('clipTail', () => {
  it('行维度:保留末尾 maxLines 行,boundaryLine 为保留区首行行号', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const r = clipTail(text, { maxLines: 2, maxBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('l4\nl5');
    expect(r.keptLines).toBe(2);
    expect(r.boundaryLine).toBe(4);
  });

  it('字节维度:保留末尾 ≤maxBytes 的整行', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `lin${i}`);   // 每行 4 字节 + '\n' = 5 字节
    const r = clipTail(lines.join('\n'), { maxLines: 100, maxBytes: 12 });
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('lin8\nlin9');
    expect(r.keptLines).toBe(2);
    expect(r.boundaryLine).toBe(9);
  });

  it('未超限:原文原样返回,truncated=false', () => {
    const text = 'a\nb';
    const r = clipTail(text, { maxLines: 10, maxBytes: 1024 });
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(text);
  });
});
