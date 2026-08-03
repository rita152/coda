// CLI 默认 system prompt 的产品行为契约：工具进度公开可见，且不泄漏隐藏推理。

import { expect, test } from 'bun:test';
import { buildSystemPrompt } from './main.js';

test('默认 prompt 要求工具前 commentary，并与 hidden reasoning 明确分离', () => {
  expect(buildSystemPrompt('/workspace')).toBe(
    'You are coda, a terminal coding agent. Working directory: /workspace\n' +
    'Use the provided tools to inspect and modify files. Read files before editing them. ' +
    'Before calling tools, emit a brief user-visible progress update describing the next action. ' +
    'During long tasks, add updates only at meaningful milestones. ' +
    'These updates are public commentary, not hidden reasoning; never reveal chain-of-thought. ' +
    'Prefer small, verifiable steps; when done, summarize what changed in one short sentence.',
  );
});

test('工作目录替换不解释 replacement pattern', () => {
  expect(buildSystemPrompt('/workspace/$&')).toContain('Working directory: /workspace/$&\n');
});
