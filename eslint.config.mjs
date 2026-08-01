// 分层依赖规则的机械保障(规格见 docs/02-architecture.md 第 3 节)。
// 规则 A:import/no-restricted-paths 管项目内目录间依赖方向;
// 规则 B:no-restricted-imports 管 npm 包级封锁(openai 仅允许两个 OpenAI adapter);
// 规则 C:protocol 层零依赖(禁止一切 bare import,含 node: 内置模块)。
// 三条规则的自证测试在 tests/boundaries.test.ts——改动本文件必须让该测试仍然通过。
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'docs/**', 'coverage/**'] },
  ...tseslint.configs.recommended,

  // ---- 规则 A:目录间依赖方向(zone 语义:target 内的文件不得 import from 内的模块)----
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'e2e/**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      'import/no-restricted-paths': ['error', {
        zones: [
          // protocol、shared 是叶子:不得 import src 下任何其他目录
          { target: './src/protocol', from: './src', except: ['./protocol'] },
          { target: './src/shared', from: './src', except: ['./shared'] },
          // providers 只向下看 protocol/shared
          { target: './src/providers', from: './src/agent' },
          { target: './src/providers', from: './src/tools' },
          { target: './src/providers', from: './src/session' },
          { target: './src/providers', from: './src/cli' },
          // agent 不认识 providers/session/cli;对 tools 仅放行框架类型文件
          { target: './src/agent', from: './src/providers' },
          { target: './src/agent', from: './src/session' },
          { target: './src/agent', from: './src/cli' },
          { target: './src/agent', from: './src/tools', except: ['./types.ts'] },
          // tools 不认识上层与 providers
          { target: './src/tools', from: './src/providers' },
          { target: './src/tools', from: './src/agent' },
          { target: './src/tools', from: './src/session' },
          { target: './src/tools', from: './src/cli' },
          // session 只依赖 protocol/shared/agent(见 docs/02 §7),不得触碰 providers/tools/cli
          { target: './src/session', from: './src/cli' },
          { target: './src/session', from: './src/providers' },
          { target: './src/session', from: './src/tools' },
          // runtime 是无 UI 的 Supervisor/路由层，只依赖 protocol/shared 与本层；
          // Session/Agent/provider/tool 只能经注入 port 或上层 legacy adapter 接入。
          {
            target: './src/runtime',
            from: './src',
            except: ['./runtime', './protocol', './shared'],
          },
          // provider 之间互相隔离(跨 provider import 是设计异味)
          { target: './src/providers/openai-chat', from: './src/providers/faux' },
          { target: './src/providers/faux', from: './src/providers/openai-chat' },
          { target: './src/providers/openai-responses', from: './src/providers/faux' },
          { target: './src/providers/faux', from: './src/providers/openai-responses' },
          { target: './src/providers/anthropic-messages', from: './src/providers/faux' },
          { target: './src/providers/anthropic-messages', from: './src/providers/openai-chat' },
          { target: './src/providers/openai-chat', from: './src/providers/anthropic-messages' },
          { target: './src/providers/faux', from: './src/providers/anthropic-messages' },
          { target: './src/providers/anthropic-messages', from: './src/providers/openai-responses' },
          { target: './src/providers/openai-responses', from: './src/providers/anthropic-messages' },
          { target: './src/providers/openai-chat', from: './src/providers/openai-responses' },
          { target: './src/providers/openai-responses', from: './src/providers/openai-chat' },
          // 测试只允许用 faux provider,不得触碰真实 adapter(防止测试悄悄变在线测试)
          { target: './tests', from: './src/providers/openai-chat' },
          { target: './tests', from: './src/providers/openai-responses' },
          { target: './tests', from: './src/providers/anthropic-messages' },
        ],
      }],
    },
  },

  // ---- 规则 B:SDK 包按 provider 目录隔离(需求 1 的机械保障)----
  // openai 仅 providers/openai-chat 与 providers/openai-responses;
  // @anthropic-ai/sdk 仅 providers/anthropic-messages。
  // flat config 同 ruleId 后者整体覆盖前者(不合并 options),故不能用两个各自 ignore 的并列块
  // ——那样第二块的 no-restricted-imports 会把第一块的 openai 规则整个吃掉。改用「基线全禁 +
  // 各 provider 目录 override 放行自己那一个」结构。scripts/ 同受约束;record-fixture*.ts
  // (录制原始 wire 需 SDK)以显式 eslint-disable 注释豁免——例外必须可见、可审。
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['openai', 'openai/*'], message: 'openai SDK 只允许在 src/providers/openai-chat/ 或 openai-responses/ 内使用(协议隔离,见 docs/02-architecture.md)' },
          { group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'], message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(协议隔离,见 docs/04 §8)' },
        ],
      }],
      // 动态 import() 与内联 import() 类型引用是另外两条渗漏通道,用语法选择器一并堵死。
      'no-restricted-syntax': ['error',
        { selector: String.raw`ImportExpression > Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(动态 import 同样受限)' },
        { selector: String.raw`TSImportType Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(import() 类型引用同样受限)' },
        { selector: String.raw`ImportExpression > Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(动态 import 同样受限)' },
        { selector: String.raw`TSImportType Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(import() 类型引用同样受限)' },
      ],
    },
  },
  // 两个 OpenAI adapter override:放行 openai,仍禁 @anthropic-ai(跨 provider 隔离)
  {
    files: ['src/providers/openai-chat/**/*.ts', 'src/providers/openai-responses/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'], message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(跨 provider 隔离)' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: String.raw`ImportExpression > Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(跨 provider 隔离)' },
        { selector: String.raw`TSImportType Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(跨 provider 隔离)' },
      ],
    },
  },
  // anthropic-messages override:放行 @anthropic-ai,仍禁 openai(跨 provider 隔离)
  {
    files: ['src/providers/anthropic-messages/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['openai', 'openai/*'], message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(跨 provider 隔离)' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: String.raw`ImportExpression > Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(跨 provider 隔离)' },
        { selector: String.raw`TSImportType Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(跨 provider 隔离)' },
      ],
    },
  },

  // runtime core 的 import() type 不经过 import/no-restricted-paths；显式补上该通道。
  // flat config 会整体覆盖同 ruleId，故同时保留全局 SDK 动态/type-only 封锁。
  {
    files: ['src/runtime/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: String.raw`ImportExpression > Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(动态 import 同样受限)' },
        { selector: String.raw`TSImportType Literal[value=/^openai(\u002F|$)/]`, message: 'openai SDK 只允许在 OpenAI adapter 目录内使用(import() 类型引用同样受限)' },
        { selector: String.raw`ImportExpression > Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(动态 import 同样受限)' },
        { selector: String.raw`TSImportType Literal[value=/^@anthropic-ai(\u002F|$)/]`, message: '@anthropic-ai/sdk 只允许在 src/providers/anthropic-messages/ 内使用(import() 类型引用同样受限)' },
        {
          selector: String.raw`TSImportType Literal[value=/^\.\.\u002F(cli|providers|session|agent|tools)(\u002F|$)/]`,
          message: 'src/runtime core 禁止通过 import() 类型引用 CLI/provider/Session/Agent/tool',
        },
      ],
    },
  },

  // ---- 规则 C:protocol 层零运行时依赖(纯类型 + EventStream,连 node: 内置模块也不引)----
  // regex 而非 group:gitignore 语义下 '*' 会连相对导入一起封死(protocol 内部 import './x.js' 也报错)。
  // '^[^.]' 只拦 bare specifier(npm 包与 node: 内置);'../' 越出 protocol 由规则 A 的 zone 兜底。
  {
    files: ['src/protocol/**/*.ts'],
    // 测试文件豁免(需要 import bun:test);运行时代码零依赖的约束不变。
    // 测试仍受规则 A/B 约束(不得 import 其他 src 目录与 openai)。
    ignores: ['src/protocol/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^[^.]',
          message: 'src/protocol 零依赖:只允许 protocol 内部的相对导入(见 docs/02-architecture.md)',
        }],
      }],
      // 动态 import 与 import() 类型引用同样封死(含 node: 内置模块)
      'no-restricted-syntax': ['error',
        {
          selector: 'ImportExpression > Literal[value=/^[^.]/]',
          message: 'src/protocol 零依赖:禁止动态 import 外部模块',
        },
        {
          selector: 'TSImportType Literal[value=/^[^.]/]',
          message: 'src/protocol 零依赖:禁止 import() 类型引用外部模块',
        },
      ],
    },
  },
);
