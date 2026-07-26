// 截断落盘:超限工具输出的全文存档(规格见 docs/07-tools.md §1.6)。
// 目录形态 ~/.coda/truncated/<scope>/<timestamp>-<toolCallId>.txt;scope 在 M5 接入
// session 后为 sessionId,当前为 Agent 实例 id。7 天保留与启动清理在 M6 完善。

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function truncationDir(scope: string): string {
  return path.join(homedir(), '.coda', 'truncated', scope);
}

/** 全文落盘,返回绝对路径;失败(磁盘满/权限)返回 undefined——截断提示降级,不炸工具结果。 */
export function spillToFile(dir: string, basename: string, content: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, basename);
    writeFileSync(file, content, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/** 文件名安全化:toolCallId 可能含奇异字符(第三方端点的 id 方言)。 */
export function safeBasename(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}
