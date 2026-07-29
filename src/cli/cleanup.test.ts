// cleanup 单测(docs/07-tools.md §1.6):截断落盘 7 天保留的启动清理。
// 纪律:禁计时器——旧文件用 utimesSync 伪造 mtime,now 经参数注入,零真实等待。

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { cleanupTruncated, TRUNCATED_RETENTION_MS } from './cleanup.js';

/** 固定 now(整毫秒),边界数学不受时钟影响。 */
const NOW = 1_800_000_000_000;

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'coda-truncated-'));
}

function touch(file: string, mtimeMs: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'spilled output', 'utf8');
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe('cleanupTruncated:7 天保留(docs/07 §1.6)', () => {
  it('超 7 天的文件删除,新文件保留;根目录本身保留', async () => {
    const root = makeRoot();
    const old = path.join(root, 's01', 'old.txt');
    const fresh = path.join(root, 's01', 'fresh.txt');
    touch(old, NOW - TRUNCATED_RETENTION_MS - 60_000);
    touch(fresh, NOW - 60_000);

    await cleanupTruncated({ dir: root, now: NOW });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(root, 's01'))).toBe(true); // 目录未清空,保留
    expect(existsSync(root)).toBe(true);
  });

  it('边界:恰好 7 天(mtime = now - 7d)保留;再早 1 秒即删(「超 7 天」是严格早于)', async () => {
    const root = makeRoot();
    const exact = path.join(root, 's02', 'exactly-7d.txt');
    const over = path.join(root, 's02', 'over-7d.txt');
    touch(exact, NOW - TRUNCATED_RETENTION_MS);
    touch(over, NOW - TRUNCATED_RETENTION_MS - 1000);

    await cleanupTruncated({ dir: root, now: NOW });

    expect(existsSync(exact)).toBe(true);
    expect(existsSync(over)).toBe(false);
  });

  it('scope 目录清空后随手移除;预先就空的目录同样移除', async () => {
    const root = makeRoot();
    const expired = path.join(root, 's03', 'gone.txt');
    touch(expired, NOW - TRUNCATED_RETENTION_MS - 1000);
    mkdirSync(path.join(root, 'empty-scope'), { recursive: true });

    await cleanupTruncated({ dir: root, now: NOW });

    expect(existsSync(path.join(root, 's03'))).toBe(false); // 文件过期删除后目录清空 → 移除
    expect(existsSync(path.join(root, 'empty-scope'))).toBe(false);
    expect(existsSync(root)).toBe(true); // 根目录永远保留
  });

  it('根目录不存在:静默完成(启动清理绝不抛)', async () => {
    await expect(
      cleanupTruncated({ dir: path.join(tmpdir(), 'coda-none', `missing-${Date.now()}`), now: NOW }),
    ).resolves.toBeUndefined();
  });

  it('嵌套目录防御:深层旧文件同样清理,空链逐层移除', async () => {
    const root = makeRoot();
    const deep = path.join(root, 's04', 'nested', 'deep.txt');
    touch(deep, NOW - TRUNCATED_RETENTION_MS - 1000);

    await cleanupTruncated({ dir: root, now: NOW });

    expect(existsSync(deep)).toBe(false);
    expect(existsSync(path.join(root, 's04'))).toBe(false);
  });
});
