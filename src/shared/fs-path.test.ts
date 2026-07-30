// dangling-aware 路径原语回归：普通新建路径、leaf/parent symlink、循环与 workdir 基准。

import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalizePath,
  isPathInside,
  resolveToolWorkdir,
} from './fs-path.js';

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe('canonicalizePath', () => {
  it('普通不存在尾段保留在已解析父目录下', () => {
    const root = temporaryDirectory('coda-path-root-');
    expect(canonicalizePath(path.join(root, 'new', 'file.ts'))).toBe(
      path.join(root, 'new', 'file.ts'),
    );
  });

  it('dangling leaf 与 parent symlink 都继续沿链接目标解析', () => {
    const root = temporaryDirectory('coda-path-root-');
    const outside = temporaryDirectory('coda-path-outside-');
    const leafTarget = path.join(outside, 'missing.ts');
    symlinkSync(leafTarget, path.join(root, 'leaf.ts'));
    symlinkSync(path.join(outside, 'missing-dir'), path.join(root, 'parent'));

    expect(canonicalizePath(path.join(root, 'leaf.ts'))).toBe(leafTarget);
    expect(canonicalizePath(path.join(root, 'parent', 'child.ts'))).toBe(
      path.join(outside, 'missing-dir', 'child.ts'),
    );
    expect(isPathInside(root, canonicalizePath(path.join(root, 'leaf.ts')))).toBe(false);
  });

  it('仓库内 symlink 解析到物理目录，循环以 ELOOP 结束', () => {
    const root = temporaryDirectory('coda-path-root-');
    mkdirSync(path.join(root, 'real'));
    symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
    symlinkSync(path.join(root, 'cycle-b'), path.join(root, 'cycle-a'));
    symlinkSync(path.join(root, 'cycle-a'), path.join(root, 'cycle-b'));

    expect(canonicalizePath(path.join(root, 'linked', 'new.ts'))).toBe(
      path.join(root, 'real', 'new.ts'),
    );
    expect(() => canonicalizePath(path.join(root, 'cycle-a'))).toThrow();
  });
});

describe('resolveToolWorkdir', () => {
  it('相对 workdir 以显式 base cwd 为基准', () => {
    expect(resolveToolWorkdir('/repo', 'packages/app')).toBe('/repo/packages/app');
    expect(resolveToolWorkdir('/repo')).toBe('/repo');
  });

  it('workdir 软链先物理化，后续 cd/重定向与真实 shell cwd 一致', () => {
    const root = temporaryDirectory('coda-workdir-root-');
    const physical = path.join(root, 'real', 'nested');
    mkdirSync(physical, { recursive: true });
    symlinkSync(physical, path.join(root, 'alias'));

    expect(resolveToolWorkdir(root, 'alias')).toBe(physical);
  });
});
