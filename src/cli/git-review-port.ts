import path from 'node:path';
import type { RuntimeDiffFile } from '../protocol/index.js';
import type { RuntimeWorkspaceReviewPort } from '../runtime/ports.js';

interface GitResult {
  readonly code: number;
  readonly stdout: string;
}

/** Composition-root Git inspection. Runtime validates and snapshots this before any UI sees it. */
export function createGitWorkspaceReviewPort(): RuntimeWorkspaceReviewPort {
  return {
    async snapshotGit({ cwd }) {
      const result = await runGit(cwd, [
        'status', '--porcelain=v1', '--branch', '--untracked-files=normal',
      ]);
      if (result.code !== 0) return { dirty: false };
      const lines = result.stdout.replaceAll('\r\n', '\n').split('\n');
      const heading = lines[0]?.startsWith('## ') === true ? lines[0].slice(3) : '';
      const branch = heading.replace(/^No commits yet on /u, '').split('...')[0]?.trim();
      return {
        ...(branch === undefined || branch === '' || branch === 'HEAD (no branch)'
          ? {}
          : { branch }),
        dirty: lines.slice(1).some((line) => line !== ''),
      };
    },
    async snapshotDiff({ cwd }) {
      const [staged, unstaged, untracked] = await Promise.all([
        diffGroup(cwd, 'staged'),
        diffGroup(cwd, 'unstaged'),
        untrackedGroup(cwd),
      ]);
      return [...staged, ...unstaged, ...untracked];
    },
  };
}

async function diffGroup(
  cwd: string,
  group: 'staged' | 'unstaged',
): Promise<readonly RuntimeDiffFile[]> {
  const flags = group === 'staged' ? ['diff', '--cached'] : ['diff'];
  const names = await runGit(cwd, [...flags, '--name-status', '-z', '--no-ext-diff']);
  if (names.code !== 0) return [];
  const entries = parseNameStatus(names.stdout);
  return Promise.all(entries.map(async ({ path: file, status }) => {
    const patch = await runGit(cwd, [
      ...flags,
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
      file,
    ]);
    return {
      path: file,
      group,
      status,
      patch: patch.code === 0 || patch.code === 1 ? patch.stdout : '',
    };
  }));
}

async function untrackedGroup(cwd: string): Promise<readonly RuntimeDiffFile[]> {
  const listed = await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) return [];
  const files = listed.stdout.split('\0').filter((file) => file !== '');
  return Promise.all(files.map(async (file) => {
    const patch = await runGit(cwd, [
      'diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
      '--', '/dev/null', path.resolve(cwd, file),
    ]);
    return {
      path: file,
      group: 'untracked' as const,
      status: 'A',
      patch: patch.code === 0 || patch.code === 1 ? patch.stdout : '',
    };
  }));
}

function parseNameStatus(value: string): readonly { readonly path: string; readonly status: string }[] {
  const fields = value.split('\0');
  const entries: Array<{ readonly path: string; readonly status: string }> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status === undefined || status === '') break;
    const source = fields[index++];
    if (source === undefined || source === '') break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = fields[index++];
      if (target === undefined || target === '') break;
      entries.push({ path: target, status });
    } else {
      entries.push({ path: source, status });
    }
  }
  return entries;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  try {
    const child = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: '' };
  }
}
