// 文件系统路径原语：统一仓库边界判断、dangling symlink 解析与工具 workdir 语义。
// 不承载 CLI 策略；调用方决定解析失败、越界路径应警告、审批还是拒绝。

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function tooManySymlinks(input: string): NodeJS.ErrnoException {
  const error = new Error(`too many symbolic links while resolving ${input}`) as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  error.path = input;
  return error;
}

/**
 * 尽力规范化路径：现存部分全部 realpath，普通不存在尾段原样拼回；若不存在来自
 * dangling symlink，则继续沿 readlink 目标解析，因此不会把越界链接误当仓库内新文件。
 */
export function canonicalizePath(input: string): string {
  const absolute = path.resolve(input);

  const resolve = (current: string, hops: number): string => {
    try {
      return realpathSync(current);
    } catch (realpathError) {
      let metadata;
      try {
        metadata = lstatSync(current);
      } catch (lstatError) {
        if (!isMissing(lstatError)) throw lstatError;
        const parent = path.dirname(current);
        if (parent === current) {
          if (!isMissing(realpathError)) throw realpathError;
          return current;
        }
        return path.join(resolve(parent, hops), path.basename(current));
      }

      if (!metadata.isSymbolicLink()) {
        if (!isMissing(realpathError)) throw realpathError;
        return current;
      }
      if (hops >= MAX_SYMLINK_HOPS) throw tooManySymlinks(absolute);
      const target = readlinkSync(current);
      return resolve(path.resolve(path.dirname(current), target), hops + 1);
    }
  };

  return resolve(absolute, 0);
}

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** bash.workdir 的唯一解析语义：相对路径始终相对 ToolContext/CLI cwd。 */
export function resolveToolWorkdir(baseCwd: string, workdir?: string): string {
  return canonicalizePath(path.resolve(baseCwd, workdir ?? '.'));
}
