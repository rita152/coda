// ripgrep 二进制定位(grep/glob 共用,工具 Executor 语义见 docs/07-tools.md)。
// 首选 @vscode/ripgrep 内嵌二进制;下载失败的环境(离线/代理)降级 PATH 上的 rg;
// 都没有则返回 undefined——工具层给出明确报错(附安装提示),而非静默失效。

let cached: Promise<string | undefined> | undefined;

export function resolveRgPath(): Promise<string | undefined> {
  cached ??= locate();
  return cached;
}

async function locate(): Promise<string | undefined> {
  try {
    // 惰性加载:包缺失/二进制未下载的环境不应在模块加载期炸掉整个工具层
    const { rgPath } = await import('@vscode/ripgrep');
    if (typeof rgPath === 'string' && (await Bun.file(rgPath).exists())) return rgPath;
  } catch {
    // fallthrough
  }
  const found = Bun.which('rg');
  if (found !== null && (await Bun.file(found).exists())) return found;
  return undefined;
}

export const RG_MISSING_MESSAGE =
  'ripgrep binary is not available. Install ripgrep (e.g. `brew install ripgrep` / `apt install ripgrep`) ' +
  'or reinstall dependencies so @vscode/ripgrep can download its bundled binary.';
