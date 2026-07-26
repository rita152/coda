// 启动清理(规格见 docs/07-tools.md §1.6):截断落盘 ~/.coda/truncated 的 7 天保留——
// mtime 超 7 天的文件删除,清空后的 scope 目录随手移除(根目录保留)。
// 纪律:失败静默、绝不阻塞启动(main.ts fire-and-forget);目录与 now 可注入供测试
// (禁计时器——测试用 utimes 造旧文件 + 注入 now,零真实等待)。

import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** 7 天保留(docs/07 §1.6);mtime 严格早于 now - RETENTION 才删(「超 7 天」)。 */
export const TRUNCATED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultTruncatedRoot(): string {
  return path.join(homedir(), '.coda', 'truncated');
}

/**
 * 尽力而为的清理:任何一步失败(目录不存在 / 权限 / 竞争删除)都吞掉。
 * 结构固定为 truncated/<scope>/<file>,但对根下的裸文件与深层嵌套同样防御性处理。
 */
export async function cleanupTruncated(opts?: { dir?: string; now?: number }): Promise<void> {
  const root = opts?.dir ?? defaultTruncatedRoot();
  const cutoff = (opts?.now ?? Date.now()) - TRUNCATED_RETENTION_MS;
  try {
    await cleanDir(root, cutoff, /* removeSelf */ false);
  } catch {
    /* 静默:清理绝不影响启动 */
  }
}

/** 递归清理;removeSelf 时目录清空后删除自身。返回目录是否已空。 */
async function cleanDir(dir: string, cutoff: number, removeSelf: boolean): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false; // 不存在/不可读:视为「没清空」,不再动它
  }
  let remaining = entries.length;
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        if (await cleanDir(p, cutoff, true)) remaining--;
      } else {
        const s = await stat(p);
        if (s.mtimeMs < cutoff) {
          await unlink(p);
          remaining--;
        }
      }
    } catch {
      /* 单项失败不影响其余条目 */
    }
  }
  if (remaining === 0 && removeSelf) {
    try {
      await rmdir(dir);
      return true;
    } catch {
      return false;
    }
  }
  return remaining === 0;
}
