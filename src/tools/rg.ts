// ripgrep 二进制定位(grep/glob 共用,规格见 docs/07-tools.md §2.3/§2.4、风险 R9)。
// 首选 @vscode/ripgrep 内嵌二进制;下载失败的环境(离线/代理)降级 PATH 上的 rg;
// 都没有则返回 undefined——工具层给出明确报错(附安装提示),而非静默失效。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

let cached: string | null | undefined;

export function resolveRgPath(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = locate() ?? null;
  return cached ?? undefined;
}

function locate(): string | undefined {
  try {
    // 惰性加载 CJS 包:包缺失/二进制未下载的环境不应在模块加载期炸掉整个工具层
    const req = createRequire(import.meta.url);
    const { rgPath } = req('@vscode/ripgrep') as { rgPath: string };
    if (existsSync(rgPath)) return rgPath;
  } catch {
    // fallthrough
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], {
      encoding: 'utf8',
    })
      .split('\n')[0]
      ?.trim();
    if (found !== undefined && found.length > 0 && existsSync(found)) return found;
  } catch {
    // fallthrough
  }
  return undefined;
}

export const RG_MISSING_MESSAGE =
  'ripgrep binary is not available. Install ripgrep (e.g. `brew install ripgrep` / `apt install ripgrep`) ' +
  'or reinstall dependencies so @vscode/ripgrep can download its bundled binary.';
