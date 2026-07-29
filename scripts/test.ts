// 自包含测试入口：L1–L4 离线测试 → Bun.build → L5 构建产物 e2e。
// 所有子进程都接收显式净化环境，避免外层 Bun 已加载的 .env 泄漏到测试。

import {
  assertSanitizedTestEnvironment,
  sanitizedTestEnvironment,
} from './test-environment.js';

type TestScope = 'all' | 'unit' | 'e2e';

const PROJECT_ROOT = `${import.meta.dir}/..`;
const bunExecutable = Bun.argv[0] ?? throwMissingBunExecutable();

const rawArgs = Bun.argv.slice(2);
const [scopeArg, ...scopedTestArgs] = rawArgs;
const scope: TestScope = scopeArg === 'unit' || scopeArg === 'e2e' ? scopeArg : 'all';
const testArgs = scope === 'all' ? rawArgs : scopedTestArgs;

const testEnv = {
  ...sanitizedTestEnvironment(Bun.env),
  NODE_ENV: 'test',
};
assertSanitizedTestEnvironment(testEnv);

async function runBun(args: readonly string[], cwd = PROJECT_ROOT): Promise<void> {
  const child = Bun.spawn([bunExecutable, '--no-env-file', ...args], {
    cwd,
    env: testEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

if (scope === 'all' || scope === 'unit') {
  await runBun([
    'test',
    '--pass-with-no-tests',
    '--path-ignore-patterns=e2e',
    ...testArgs,
  ]);
}

if (scope === 'all' || scope === 'e2e') {
  await runBun(['run', 'scripts/build.ts']);
  await runBun(
    ['test', '--pass-with-no-tests', ...testArgs],
    `${PROJECT_ROOT}/e2e`,
  );
}

function throwMissingBunExecutable(): never {
  throw new Error('cannot locate the Bun executable');
}
