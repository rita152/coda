// ESLint 架构边界的自证测试(docs/02-architecture.md 目录职责与依赖方向)。
// 原理:向 src/ 写入带故意违例的探针文件,断言 ESLint 报出预期规则,再清理。
// 若有人静默删除 eslint.config.mjs 里的边界规则,本测试立即变红。
import { afterEach, describe, expect, it } from 'bun:test';
import { ESLint } from 'eslint';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probes: string[] = [];

interface ProbeResult {
  rules: string[];
  errorCount: number;
}

async function lintProbe(relPath: string, code: string): Promise<ProbeResult> {
  const abs = path.join(root, relPath);
  probes.push(abs);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, code, 'utf8');
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintFiles([abs]);
  if (result === undefined) {
    throw new Error(`探针未被 lint(文件被 ignore?):${relPath}`);
  }
  return {
    rules: result.messages.map((m) => m.ruleId ?? 'unknown'),
    errorCount: result.errorCount,
  };
}

afterEach(async () => {
  while (probes.length > 0) {
    await rm(probes.pop() as string, { force: true });
  }
});

describe('import 边界规则(docs/02-architecture.md)', () => {
  it('protocol barrel does not publish the internal agent-loop event payload', async () => {
    const source = await Bun.file(path.join(root, 'src/protocol/index.ts')).text();
    expect(source).not.toContain("export * from './agent-events.js';");
    expect(source).toContain("export type { PlanStep, QueuedMessage } from './agent-events.js';");
  });

  it('src/agent 内 import openai 报错(type-only 同样拦截)', async () => {
    const { rules } = await lintProbe(
      'src/agent/openai.probe.ts',
      "import type { ChatCompletion } from 'openai/resources';\nexport type X = ChatCompletion;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('src/protocol 内 import 任何 npm 包报错(零依赖)', async () => {
    const { rules } = await lintProbe(
      'src/protocol/npm.probe.ts',
      "import { z } from 'zod';\nexport const s = z;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('src/protocol 内 import node: 内置模块同样报错', async () => {
    const { rules } = await lintProbe(
      'src/protocol/node-builtin.probe.ts',
      "import { readFile } from 'node:fs/promises';\nexport const f = readFile;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('src/protocol 内 import src/agent 报错(叶子层不得向上看)', async () => {
    const { rules } = await lintProbe(
      'src/protocol/src-dep.probe.ts',
      "import '../agent/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('src/agent 内 import providers 报错(provider 经 StreamFn 注入)', async () => {
    const { rules } = await lintProbe(
      'src/agent/provider-dep.probe.ts',
      "import '../providers/faux/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('src/agent 内 import 任何 tools 模块都报错', async () => {
    const { rules: implRules } = await lintProbe(
      'src/agent/tool-impl.probe.ts',
      "import '../tools/index.js';\n",
    );
    expect(implRules).toContain('import/no-restricted-paths');

    const { rules: typesRules, errorCount: typesErrors } = await lintProbe(
      'src/agent/tool-types.probe.ts',
      "import type * as ToolTypes from '../tools/types.js';\nexport type T = typeof ToolTypes;\n",
    );
    expect(typesRules).toContain('import/no-restricted-paths');
    expect(typesErrors).toBeGreaterThan(0);
  });

  it('src/tools 内 import src/agent 报错(反向依赖被拦)', async () => {
    const { rules } = await lintProbe(
      'src/tools/agent-dep.probe.ts',
      "import '../agent/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('tests 内 import providers/openai-chat 报错(测试不得悄悄变在线测试)', async () => {
    const { rules } = await lintProbe(
      'tests/online.probe.ts',
      "import '../src/providers/openai-chat/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('tests 内 import providers/openai-responses 报错(测试不得悄悄变在线测试)', async () => {
    const { rules } = await lintProbe(
      'tests/responses-online.probe.ts',
      "import '../src/providers/openai-responses/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('合法方向零违例:providers/faux import protocol 通过', async () => {
    const { errorCount } = await lintProbe(
      'src/providers/faux/legal.probe.ts',
      "import '../../protocol/index.js';\n",
    );
    expect(errorCount).toBe(0);
  });

  it('src/protocol 内部相对导入放行(零依赖规则不误伤自己人)', async () => {
    const { errorCount } = await lintProbe(
      'src/protocol/internal.probe.ts',
      "import './index.js';\n",
    );
    expect(errorCount).toBe(0);
  });

  it('src/protocol 内动态 import 外部模块报错(静态封锁的绕过通道 1)', async () => {
    const { rules } = await lintProbe(
      'src/protocol/dynamic.probe.ts',
      "export const p = import('node:fs/promises');\n",
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('src/protocol 内 import() 类型引用外部模块报错(绕过通道 2)', async () => {
    const { rules } = await lintProbe(
      'src/protocol/import-type.probe.ts',
      "export type P = typeof import('node:path');\n",
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('src/agent 内 import() 类型引用 openai 报错(type-only 渗漏通道)', async () => {
    const { rules } = await lintProbe(
      'src/agent/openai-import-type.probe.ts',
      "export type P = import('openai/resources').ChatCompletion;\n",
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('src/session 内 import providers 报错(session 只依赖 protocol/shared/agent)', async () => {
    const { rules } = await lintProbe(
      'src/session/provider-dep.probe.ts',
      "import '../providers/faux/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('src/runtime 不得反向 import CLI/provider/Agent/tool 实现', async () => {
    for (const dependency of ['cli/main', 'providers/faux/index', 'agent/index', 'tools/index']) {
      const probeName = dependency.replaceAll('/', '-');
      const { rules } = await lintProbe(
        `src/runtime/${probeName}.probe.ts`,
        `import '../${dependency}.js';\n`,
      );
      expect(rules).toContain('import/no-restricted-paths');
    }
  });

  it('src/runtime 可依赖 protocol/shared/session/capabilities（当前合法方向）', async () => {
    const { errorCount } = await lintProbe(
      'src/runtime/legal.probe.ts',
      "import '../protocol/index.js';\nimport '../shared/index.js';\nimport '../session/index.js';\nimport type { RuntimeCapabilityServices } from '../capabilities/index.js';\nexport type Services = RuntimeCapabilityServices;\n",
    );
    expect(errorCount).toBe(0);
  });

  it('src/capabilities 只向下依赖 protocol/shared', async () => {
    for (const dependency of [
      'agent/index',
      'cli/main',
      'providers/faux/index',
      'runtime/index',
      'session/index',
      'tools/index',
    ]) {
      const probeName = dependency.replaceAll('/', '-');
      const { rules } = await lintProbe(
        `src/capabilities/${probeName}.probe.ts`,
        `import '../${dependency}.js';\n`,
      );
      expect(rules).toContain('import/no-restricted-paths');
    }

    const { rules } = await lintProbe(
      'src/capabilities/tool-types.probe.ts',
      "import type { ToolContext } from '../tools/types.js';\nexport type Leak = ToolContext;\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('coding-capabilities 集成层只能向下依赖 capability/tool 基础层', async () => {
    for (const dependency of [
      'agent/index',
      'cli/main',
      'providers/faux/index',
      'runtime/index',
      'session/index',
    ]) {
      const probeName = dependency.replaceAll('/', '-');
      const { rules } = await lintProbe(
        `src/integrations/coding-capabilities/${probeName}.probe.ts`,
        `import '../../${dependency}.js';\n`,
      );
      expect(rules).toContain('import/no-restricted-paths');
    }

    const { errorCount } = await lintProbe(
      'src/integrations/coding-capabilities/legal.probe.ts',
      "import type { CapabilityRegistration } from '../../capabilities/index.js';\nimport type { ToolContext } from '../../tools/index.js';\nexport type Legal = CapabilityRegistration | ToolContext;\n",
    );
    expect(errorCount).toBe(0);
  });

  it('runtime-thread-driver 集成层只组合 protocol 与 session', async () => {
    for (const dependency of [
      'agent/index',
      'capabilities/index',
      'cli/main',
      'providers/faux/index',
      'runtime/index',
      'tools/index',
    ]) {
      const probeName = dependency.replaceAll('/', '-');
      const { rules } = await lintProbe(
        `src/integrations/runtime-thread-driver/${probeName}.probe.ts`,
        `import '../../${dependency}.js';\n`,
      );
      expect(rules).toContain('import/no-restricted-paths');
    }

    const { errorCount } = await lintProbe(
      'src/integrations/runtime-thread-driver/legal.probe.ts',
      "import type { ThreadId } from '../../protocol/index.js';\nimport type { RuntimeThreadDriverFactory } from '../../session/index.js';\nexport type Legal = ThreadId | RuntimeThreadDriverFactory;\n",
    );
    expect(errorCount).toBe(0);
  });

  it('src/tools 不得反向依赖 capabilities 或 coding-capabilities', async () => {
    for (const dependency of ['capabilities/index', 'integrations/coding-capabilities/index']) {
      const probeName = dependency.replaceAll('/', '-');
      const { rules } = await lintProbe(
        `src/tools/${probeName}.probe.ts`,
        `import '../${dependency}.js';\n`,
      );
      expect(rules).toContain('import/no-restricted-paths');
    }
  });

  it('src/runtime 的 dynamic import/import() type 也不能绕过 core 边界', async () => {
    const { rules: dynamicRules } = await lintProbe(
      'src/runtime/dynamic-cli.probe.ts',
      "export const loaded = import('../cli/main.js');\n",
    );
    expect(dynamicRules).toContain('import/no-restricted-paths');

    const { rules: typeRules } = await lintProbe(
      'src/runtime/import-agent-type.probe.ts',
      "export type ForbiddenAgent = import('../agent/index.js').Agent;\n",
    );
    expect(typeRules).toContain('no-restricted-syntax');
  });

  it('src/session 不得反向 import runtime（每线程层不认识 workspace Supervisor）', async () => {
    const { rules } = await lintProbe(
      'src/session/runtime-dep.probe.ts',
      "import '../runtime/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('src/session 的 import() type 不能绕过 runtime 反向依赖边界', async () => {
    const { rules } = await lintProbe(
      'src/session/runtime-import-type.probe.ts',
      "export type RuntimeLeak = import('../runtime/index.js').RuntimePort;\n",
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('src/agent 内 import @anthropic-ai/sdk 报错(SDK 仅限 anthropic-messages,type-only 同拦)', async () => {
    const { rules } = await lintProbe(
      'src/agent/anthropic.probe.ts',
      "import type Anthropic from '@anthropic-ai/sdk';\nexport type X = Anthropic;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('src/agent 内 import() 类型引用 @anthropic-ai 报错(type-only 渗漏通道)', async () => {
    const { rules } = await lintProbe(
      'src/agent/anthropic-import-type.probe.ts',
      "export type P = import('@anthropic-ai/sdk').Anthropic;\n",
    );
    expect(rules).toContain('no-restricted-syntax');
  });

  it('anthropic-messages 内 import @anthropic-ai/sdk 放行(合法方向零违例)', async () => {
    const { errorCount } = await lintProbe(
      'src/providers/anthropic-messages/legal.probe.ts',
      "import '@anthropic-ai/sdk';\n",
    );
    expect(errorCount).toBe(0);
  });

  it('anthropic-messages 内 import openai 报错(跨 provider 隔离)', async () => {
    const { rules } = await lintProbe(
      'src/providers/anthropic-messages/cross.probe.ts',
      "import type { ChatCompletion } from 'openai/resources';\nexport type X = ChatCompletion;\n",
    );
    expect(rules).toContain('no-restricted-imports');
  });

  it('openai-responses 内 import openai 放行,import sibling adapter 报错', async () => {
    const { errorCount } = await lintProbe(
      'src/providers/openai-responses/legal.probe.ts',
      "import type OpenAI from 'openai';\nexport type X = OpenAI;\n",
    );
    expect(errorCount).toBe(0);

    const { rules } = await lintProbe(
      'src/providers/openai-responses/cross.probe.ts',
      "import '../openai-chat/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });

  it('tests 内 import providers/anthropic-messages 报错(测试不得触碰真实 adapter)', async () => {
    const { rules } = await lintProbe(
      'tests/anthropic-online.probe.ts',
      "import '../src/providers/anthropic-messages/index.js';\n",
    );
    expect(rules).toContain('import/no-restricted-paths');
  });
});
