// FileTracker:read-before-edit 硬约束的登记表(工具 Executor 语义见 docs/07-tools.md)。
// Thread 级 {resolvedPath → mtimeMs}:read 成功、edit/write 成功后登记;edit/write
// 动笔前校验「读过且磁盘未变新」。由 ThreadRuntime 持有,经 ToolContext 传给每次执行。

export type FreshnessCheck = { ok: true } | { ok: false; reason: 'never_read' | 'stale' };

export interface FileTrackerPort {
  markRead(path: string, mtimeMs: number): void;
  assertFresh(path: string, currentMtimeMs: number): FreshnessCheck;
  hasRead(path: string): boolean;
}

export class FileTracker implements FileTrackerPort {
  private readonly files = new Map<string, number>();

  /** read 成功、edit/write 成功后登记(自己的写不算外部修改)。path 应为 resolve 后的绝对路径。 */
  markRead(path: string, mtimeMs: number): void {
    this.files.set(path, mtimeMs);
  }

  /** edit/write 覆盖前校验:没读过 → never_read;磁盘 mtime 比登记值新 → stale。 */
  assertFresh(path: string, currentMtimeMs: number): FreshnessCheck {
    const recorded = this.files.get(path);
    if (recorded === undefined) return { ok: false, reason: 'never_read' };
    if (currentMtimeMs > recorded) return { ok: false, reason: 'stale' };
    return { ok: true };
  }

  /** 是否登记过(write 对新文件放行、已有文件走 assertFresh 的判据入口)。 */
  hasRead(path: string): boolean {
    return this.files.has(path);
  }
}
