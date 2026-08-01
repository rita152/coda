import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkspaceReviewPort } from './git-review-port.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Git workspace review port', () => {
  it('returns complete staged, unstaged, and untracked patches without shell interpolation', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'coda-git-review-'));
    roots.push(cwd);
    git(cwd, ['init', '-b', 'ux3-review']);
    git(cwd, ['config', 'user.email', 'coda@example.test']);
    git(cwd, ['config', 'user.name', 'Coda Test']);
    writeFileSync(path.join(cwd, 'staged.ts'), 'export const staged = 1;\n');
    writeFileSync(path.join(cwd, 'unstaged.ts'), 'export const unstaged = 1;\n');
    git(cwd, ['add', 'staged.ts', 'unstaged.ts']);
    git(cwd, ['commit', '-m', 'baseline']);

    writeFileSync(path.join(cwd, 'staged.ts'), 'export const staged = 2;\n');
    git(cwd, ['add', 'staged.ts']);
    writeFileSync(path.join(cwd, 'unstaged.ts'), 'export const unstaged = 2;\n');
    writeFileSync(path.join(cwd, 'untracked [safe].ts'), 'export const untracked = true;\n');

    const review = createGitWorkspaceReviewPort();
    expect(await review.snapshotGit({ workspaceId: 'workspace-test' as never, cwd })).toEqual({
      branch: 'ux3-review',
      dirty: true,
    });
    const files = await review.snapshotDiff({ workspaceId: 'workspace-test' as never, cwd });
    expect(files.map((file) => [file.group, file.path, file.status])).toEqual([
      ['staged', 'staged.ts', 'M'],
      ['unstaged', 'unstaged.ts', 'M'],
      ['untracked', 'untracked [safe].ts', 'A'],
    ]);
    expect(files[0]?.patch).toContain('+export const staged = 2;');
    expect(files[1]?.patch).toContain('+export const unstaged = 2;');
    expect(files[2]?.patch).toContain('+export const untracked = true;');
  });
});

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
