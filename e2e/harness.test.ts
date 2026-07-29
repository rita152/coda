// Harness completion 回归：输出 pipe 失败必须立即击穿 waitForExit，而不是悬到看门狗超时。

import { expect, test } from 'bun:test';
import { buildE2eEnvironment, combineProcessCompletion } from './harness.js';

test('e2e environment removes credentials and replaces the inherited home', () => {
  const env = buildE2eEnvironment(
    {
      PATH: '/bin',
      HOME: '/real/home',
      USERPROFILE: '/real/profile',
      OPENAI_API_KEY: 'secret',
    },
    '/tmp/isolated-home',
  );

  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/tmp/isolated-home',
    USERPROFILE: '/tmp/isolated-home',
  });
});

test('process completion propagates a stdout pump failure before child exit', async () => {
  const pumpError = new Error('stdout pipe failed');
  const childStillRunning = new Promise<number>(() => undefined);

  await expect(
    combineProcessCompletion(
      childStillRunning,
      Promise.reject(pumpError),
      Promise.resolve(),
    ),
  ).rejects.toBe(pumpError);
});

test('process completion propagates a stderr pump failure before child exit', async () => {
  const pumpError = new Error('stderr pipe failed');
  const childStillRunning = new Promise<number>(() => undefined);

  await expect(
    combineProcessCompletion(
      childStillRunning,
      Promise.resolve(),
      Promise.reject(pumpError),
    ),
  ).rejects.toBe(pumpError);
});

test('process completion returns the exit code after both pumps finish', async () => {
  expect(
    await combineProcessCompletion(
      Promise.resolve(7),
      Promise.resolve(),
      Promise.resolve(),
    ),
  ).toBe(7);
});
