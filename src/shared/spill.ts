// 截断落盘:超限工具输出的全文存档(规格见 docs/07-tools.md)。
// 目录形态 ~/.coda/truncated/<scope>/<timestamp>-<toolCallId>.txt;Runtime Agent 以当前 threadId 作为 scope。
// 启动时清理超过 7 天的文件。

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runtimeHomeDir } from './home.js';

export function truncationDir(scope: string): string {
  return path.join(runtimeHomeDir(), '.coda', 'truncated', scope);
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
