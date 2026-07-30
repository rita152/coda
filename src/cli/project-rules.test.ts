// 项目规则感知回归：分层/无规则/双上限/符号链接/执行前 gate/跨 turn 动态刷新。

import {
  afterEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context, ToolCallPart } from '../protocol/index.js';
import { bashTool, writeTool } from '../tools/index.js';
import { makeHarness } from '../../tests/helpers/agent-harness.js';
import {
  estimateProjectRuleTokens,
  guardProjectRuleExecutions,
  ProjectRules,
} from './project-rules.js';

const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function makeRepository(): string {
  const root = makeDirectory('coda-project-rules-');
  mkdirSync(path.join(root, '.git'));
  return root;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function context(): Context {
  return {
    systemPrompt: 'BASE',
    messages: [
      {
        role: 'user',
        id: 'u1',
        timestamp: 1,
        content: [{ type: 'text', text: 'do the work' }],
        source: 'prompt',
      },
    ],
    tools: [],
  };
}

function projectSection(systemPrompt: string): string {
  return systemPrompt.startsWith('BASE\n\n')
    ? systemPrompt.slice('BASE\n\n'.length)
    : systemPrompt;
}

function toolCall(name: string, args: Record<string, unknown>, id = `${name}-1`): ToolCallPart {
  return { type: 'tool_call', id, name, arguments: args };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('ProjectRules 分层发现与 prompt 注入', () => {
  it('从嵌套 cwd 找到仓库根，按 root → target 注入带 source/scope 的覆盖链', async () => {
    const root = makeRepository();
    const app = path.join(root, 'packages', 'app');
    mkdirSync(app, { recursive: true });
    const rootRules = write(root, 'AGENTS.md', 'ROOT_RULE_UNIQUE');
    const packagesRules = write(root, 'packages/AGENTS.md', 'PACKAGES_RULE_UNIQUE');
    const appRules = write(root, 'packages/app/AGENTS.md', 'APP_RULE_UNIQUE');
    const rules = new ProjectRules({ cwd: app });

    const input = context();
    const output = await rules.inject(input);
    const prompt = output.systemPrompt ?? '';

    expect(rules.repositoryRoot).toBe(root);
    expect(prompt.indexOf('ROOT_RULE_UNIQUE')).toBeLessThan(prompt.indexOf('PACKAGES_RULE_UNIQUE'));
    expect(prompt.indexOf('PACKAGES_RULE_UNIQUE')).toBeLessThan(prompt.indexOf('APP_RULE_UNIQUE'));
    expect(prompt).toContain(`source="${rootRules}"`);
    expect(prompt).toContain(`source="${packagesRules}"`);
    expect(prompt).toContain(`source="${appRules}"`);
    expect(prompt).toContain(`scope="${path.join(root, 'packages', 'app')}${path.sep}**"`);
    expect(output.messages).toEqual(input.messages);
    expect(JSON.stringify(output.messages)).not.toContain('ROOT_RULE_UNIQUE');
  });

  it('无 AGENTS.md 时不改变 system prompt，edit/write/bash gate 均无额外阻塞', async () => {
    const root = makeRepository();
    const rules = new ProjectRules({ cwd: root });
    const input = context();

    expect(await rules.inject(input)).toBe(input);
    expect(await rules.beforeToolCall(toolCall('edit', { path: 'src/a.ts' }))).toEqual({});
    expect(await rules.beforeToolCall(toolCall('write', { path: 'src/b.ts' }))).toEqual({});
    expect(
      await rules.beforeToolCall(toolCall('bash', { command: 'bun test', workdir: 'src' })),
    ).toEqual({});
  });

  it('edit/write 目标目录与 bash workdir 首次触达时先加载，下一次注入后才放行', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', 'ROOT');
    write(root, 'edit-scope/AGENTS.md', 'EDIT_SCOPE');
    write(root, 'write-scope/AGENTS.md', 'WRITE_SCOPE');
    write(root, 'bash-scope/AGENTS.md', 'BASH_SCOPE');
    const rules = new ProjectRules({ cwd: root });
    await rules.inject(context());

    const edit = toolCall('edit', { path: 'edit-scope/a.ts' });
    expect((await rules.beforeToolCall(edit)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('EDIT_SCOPE');
    expect(await rules.beforeToolCall(edit)).toEqual({});

    const writeCall = toolCall('write', { path: 'write-scope/a.ts' });
    expect((await rules.beforeToolCall(writeCall)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('WRITE_SCOPE');
    expect(await rules.beforeToolCall(writeCall)).toEqual({});

    const bash = toolCall('bash', { command: 'bun test', workdir: 'bash-scope' });
    expect((await rules.beforeToolCall(bash)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('BASH_SCOPE');
    expect(await rules.beforeToolCall(bash)).toEqual({});
  });

  it('bash 命令里的重定向与 cd 目标也会加载对应子目录规则', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', 'ROOT');
    write(root, 'redirected/AGENTS.md', 'REDIRECTED_SCOPE');
    write(root, 'changed/AGENTS.md', 'CHANGED_SCOPE');
    const rules = new ProjectRules({ cwd: root });
    await rules.inject(context());

    const redirect = toolCall('bash', {
      command: 'printf x > redirected/out.txt',
    });
    expect((await rules.beforeToolCall(redirect)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('REDIRECTED_SCOPE');
    expect(await rules.beforeToolCall(redirect)).toEqual({});

    await rules.inject(context());
    const changed = toolCall('bash', {
      command: 'cd changed && printf x > out.txt',
    });
    expect((await rules.beforeToolCall(changed)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('CHANGED_SCOPE');
    expect(await rules.beforeToolCall(changed)).toEqual({});
  });

  it('bash 裸目录参数也会加载现存目标目录的规则', async () => {
    const root = makeRepository();
    write(root, 'source.txt', 'payload');
    write(root, '123/AGENTS.md', 'BARE_DIRECTORY_SCOPE');
    const rules = new ProjectRules({ cwd: root });
    await rules.inject(context());

    const copy = toolCall('bash', { command: 'cp source.txt 123' });
    expect((await rules.beforeToolCall(copy)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('BARE_DIRECTORY_SCOPE');
    expect(await rules.beforeToolCall(copy)).toEqual({});
  });
});

describe('ProjectRules 限制与非致命警告', () => {
  it('单文件字节超限时忽略规则并警告', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', '123456789');
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: root,
      maxFileBytes: 8,
      onWarning: (warning) => warnings.push(warning),
    });

    const output = await rules.inject(context());
    expect(output.systemPrompt).toBe('BASE');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('exceeds per-file limit 8');
  });

  it('总 token 超限时优先保留更窄作用域并警告', async () => {
    const root = makeRepository();
    const child = path.join(root, 'child');
    mkdirSync(child);
    write(root, 'child/AGENTS.md', 'CHILD123');
    const probe = new ProjectRules({ cwd: child });
    const childOnly = projectSection((await probe.inject(context())).systemPrompt ?? '');
    const limit = estimateProjectRuleTokens(childOnly);
    write(root, 'AGENTS.md', 'ROOT1234');
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: child,
      maxTotalTokens: limit,
      onWarning: (warning) => warnings.push(warning),
    });

    const prompt = (await rules.inject(context())).systemPrompt ?? '';
    expect(prompt).not.toContain('ROOT1234');
    expect(prompt).toContain('CHILD123');
    expect(estimateProjectRuleTokens(projectSection(prompt))).toBeLessThanOrEqual(limit);
    expect(warnings.some((warning) => warning.includes('token estimate'))).toBe(true);
  });

  it('越界 AGENTS.md 软链与目标目录软链都只警告，不读取外部规则或致命失败', async () => {
    const root = makeRepository();
    const outside = makeDirectory('coda-project-rules-outside-');
    const outsideRules = write(outside, 'outside-rules.md', 'MUST_NOT_LEAK');
    const outsideTarget = write(outside, 'outside-target.ts', 'export {};');
    symlinkSync(outsideRules, path.join(root, 'AGENTS.md'));
    symlinkSync(outside, path.join(root, 'linked-outside'));
    symlinkSync(outsideTarget, path.join(root, 'linked-file.ts'));
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: root,
      onWarning: (warning) => warnings.push(warning),
    });

    const output = await rules.inject(context());
    expect(output.systemPrompt).toBe('BASE');
    expect(output.systemPrompt).not.toContain('MUST_NOT_LEAK');
    expect(
      await rules.beforeToolCall(toolCall('write', { path: 'linked-outside/new.ts' })),
    ).toEqual({});
    expect(
      await rules.beforeToolCall(toolCall('edit', { path: 'linked-file.ts' })),
    ).toEqual({});
    expect(warnings.some((warning) => warning.includes('symlink resolves outside'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('path crosses a symlink outside'))).toBe(true);
  });

  it('dangling leaf 软链指向仓库外时警告，但仍加载链接前的安全祖先规则', async () => {
    const root = makeRepository();
    const outside = makeDirectory('coda-project-rules-dangling-');
    write(root, 'AGENTS.md', 'ROOT_RULE');
    write(root, 'sub/AGENTS.md', 'SAFE_SUB_RULE');
    const missingOutside = path.join(outside, 'not-created.ts');
    symlinkSync(missingOutside, path.join(root, 'sub', 'linked.ts'));
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: root,
      onWarning: (warning) => warnings.push(warning),
    });
    await rules.inject(context());

    const call = toolCall('write', { path: 'sub/linked.ts' });
    expect((await rules.beforeToolCall(call)).block).toBe(true);
    expect((await rules.inject(context())).systemPrompt).toContain('SAFE_SUB_RULE');
    expect(await rules.beforeToolCall(call)).toEqual({});
    expect(existsSync(missingOutside)).toBe(false);
    expect(warnings.some((warning) => warning.includes(missingOutside))).toBe(true);
  });

  it('AGENTS.md 指向仓库内缺失目标时作为读取失败警告，而不是静默当成无规则', async () => {
    const root = makeRepository();
    const missingRules = path.join(root, 'missing-rules.md');
    symlinkSync(missingRules, path.join(root, 'AGENTS.md'));
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: root,
      onWarning: (warning) => warnings.push(warning),
    });

    expect((await rules.inject(context())).systemPrompt).toBe('BASE');
    expect(warnings.some((warning) => warning.includes('could not open project rules'))).toBe(true);
    expect(warnings.some((warning) => warning.includes(missingRules))).toBe(true);
  });

  it('warning 在前端订阅前缓冲，监听器失败不影响规则扫描', async () => {
    const root = makeRepository();
    write(root, 'AGENTS.md', 'too large');
    const rules = new ProjectRules({ cwd: root, maxFileBytes: 2 });

    await rules.inject(context());
    rules.subscribeWarnings(() => {
      throw new Error('renderer failed');
    });
    const replayed: string[] = [];
    rules.subscribeWarnings((warning) => replayed.push(warning));

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toContain('per-file limit 2');
  });

  it('规则恢复后同一种超限再次发生时重新 warning', async () => {
    const root = makeRepository();
    const rulesFile = write(root, 'AGENTS.md', '123456789');
    const warnings: string[] = [];
    const rules = new ProjectRules({
      cwd: root,
      maxFileBytes: 8,
      onWarning: (warning) => warnings.push(warning),
    });

    await rules.inject(context());
    await rules.beforeToolCall(toolCall('write', { path: 'out.ts' }));
    expect(warnings.filter((warning) => warning.includes('per-file limit 8'))).toHaveLength(1);
    writeFileSync(rulesFile, 'ok');
    await rules.inject(context());
    writeFileSync(rulesFile, '123456789');
    await rules.inject(context());
    await rules.beforeToolCall(toolCall('write', { path: 'out.ts' }));

    expect(warnings.filter((warning) => warning.includes('per-file limit 8'))).toHaveLength(2);
  });

  it('历史 sibling 占满预算时当前目标仍会被 gate，并在下一 turn 单独注入', async () => {
    const root = makeRepository();
    mkdirSync(path.join(root, 'a'));
    mkdirSync(path.join(root, 'z'));
    write(root, 'a/AGENTS.md', 'A_SCOPE');
    write(root, 'z/AGENTS.md', 'Z_SCOPE');
    const probe = new ProjectRules({ cwd: path.join(root, 'a') });
    const oneScope = projectSection((await probe.inject(context())).systemPrompt ?? '');
    const limit = estimateProjectRuleTokens(oneScope);
    const rules = new ProjectRules({ cwd: root, maxTotalTokens: limit });
    await rules.inject(context());

    expect(
      (await rules.beforeToolCall(toolCall('write', { path: 'a/out.ts' }, 'write-a'))).block,
    ).toBe(true);
    expect(
      (await rules.beforeToolCall(toolCall('write', { path: 'z/out.ts' }, 'write-z'))).block,
    ).toBe(true);
    const mixed = (await rules.inject(context())).systemPrompt ?? '';
    expect(mixed).toContain('A_SCOPE');
    expect(mixed).not.toContain('Z_SCOPE');

    const zRetry = await rules.beforeToolCall(
      toolCall('write', { path: 'z/out.ts' }, 'write-z-retry'),
    );
    expect(zRetry.block).toBe(true);
    const zOnly = (await rules.inject(context())).systemPrompt ?? '';
    expect(zOnly).toContain('Z_SCOPE');
    expect(zOnly).not.toContain('A_SCOPE');
  });
});

describe('ProjectRules turn 语义', () => {
  it('首次深层 write 被 gate，下一 turn 看见规则后才执行', async () => {
    const root = makeRepository();
    const target = path.join(root, 'nested');
    mkdirSync(target);
    write(root, 'AGENTS.md', 'ROOT_ONLY');
    write(root, 'nested/AGENTS.md', 'NESTED_BEFORE_WRITE');
    const rules = new ProjectRules({ cwd: root });
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              {
                kind: 'tool_call',
                name: 'write',
                args: { path: 'nested/out.txt', content: 'done' },
                id: 'write-1',
              },
            ],
          },
          {
            events: [
              {
                kind: 'tool_call',
                name: 'write',
                args: { path: 'nested/out.txt', content: 'done' },
                id: 'write-2',
              },
            ],
          },
          { events: [{ kind: 'text', text: 'finished' }] },
        ],
      },
      {
        cwd: root,
        tools: [writeTool],
        transformContext: (ctx) => rules.inject(ctx),
        beforeToolCall: (call) => rules.beforeToolCall(call),
      },
    );

    await h.agent.prompt('go');

    expect(await Bun.file(path.join(target, 'out.txt')).text()).toBe('done');
    expect(h.streamFn.calls[0]?.context.systemPrompt).not.toContain('NESTED_BEFORE_WRITE');
    expect(h.streamFn.calls[1]?.context.systemPrompt).toContain('NESTED_BEFORE_WRITE');
    const firstResult = h.agent.transcript.find(
      (message) => message.role === 'tool_result' && message.toolCallId === 'write-1',
    );
    expect(firstResult?.role === 'tool_result' && firstResult.isError).toBe(true);
  });

  it('同批前一条命令改写 AGENTS.md 时，execute 边界复检阻止后一条写操作', async () => {
    const root = makeRepository();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    write(root, 'AGENTS.md', 'ROOT_RULE');
    write(root, 'nested/AGENTS.md', 'OLD_BATCH_RULE');
    const rules = new ProjectRules({ cwd: nested });
    const tools = guardProjectRuleExecutions([bashTool, writeTool], rules);
    const h = makeHarness(
      {
        turns: [
          {
            events: [
              {
                kind: 'tool_call',
                name: 'bash',
                args: {
                  command: "printf '%s' 'NEW_BATCH_RULE' > AGENTS.md",
                  workdir: nested,
                },
                id: 'bash-rules-update',
              },
              {
                kind: 'tool_call',
                name: 'write',
                args: { path: 'out.txt', content: 'must not be written yet' },
                id: 'write-after-rules-update',
              },
            ],
          },
          { events: [{ kind: 'text', text: 'will retry later' }] },
        ],
      },
      {
        cwd: nested,
        tools,
        transformContext: (ctx) => rules.inject(ctx),
        beforeToolCall: (call) => rules.beforeToolCall(call),
      },
    );

    await h.agent.prompt('go');

    expect(existsSync(path.join(nested, 'out.txt'))).toBe(false);
    expect(h.streamFn.calls[1]?.context.systemPrompt).toContain('NEW_BATCH_RULE');
    const blocked = h.agent.transcript.find(
      (message) =>
        message.role === 'tool_result' &&
        message.toolCallId === 'write-after-rules-update',
    );
    expect(blocked?.role === 'tool_result' && blocked.isError).toBe(true);
  });

  it('AGENTS.md 修改后下一次 prompt 生效，规则正文不进入 transcript', async () => {
    const root = makeRepository();
    const rulesFile = write(root, 'AGENTS.md', 'OLD_RULE_UNIQUE');
    const rules = new ProjectRules({ cwd: root });
    const h = makeHarness(
      {
        turns: [
          { events: [{ kind: 'text', text: 'first' }] },
          { events: [{ kind: 'text', text: 'second' }] },
        ],
      },
      { cwd: root, transformContext: (ctx) => rules.inject(ctx) },
    );

    await h.agent.prompt('one');
    writeFileSync(rulesFile, 'NEW_RULE_UNIQUE');
    await h.agent.prompt('two');

    expect(h.streamFn.calls[0]?.context.systemPrompt).toContain('OLD_RULE_UNIQUE');
    expect(h.streamFn.calls[1]?.context.systemPrompt).toContain('NEW_RULE_UNIQUE');
    expect(h.streamFn.calls[1]?.context.systemPrompt).not.toContain('OLD_RULE_UNIQUE');
    const transcript = JSON.stringify(h.agent.transcript);
    expect(transcript).not.toContain('OLD_RULE_UNIQUE');
    expect(transcript).not.toContain('NEW_RULE_UNIQUE');
  });
});
