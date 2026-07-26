// .env 解析(不引 dotenv 依赖):支持 base_url/api_key(用户约定)与 OPENAI_BASE_URL/OPENAI_API_KEY。
// 仅供 scripts/ 使用;绝不打印 apiKey。
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface EndpointEnv {
  baseURL: string | undefined;
  apiKey: string | undefined;
}

function parseEnvFile(root: string): Record<string, string> {
  const fromFile: Record<string, string> = {};
  try {
    for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = (m[2] as string).trim();
      if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();   // unquoted 值剥行内注释
      fromFile[m[1] as string] = value;
    }
  } catch {
    // 无 .env:仅用环境变量
  }
  return fromFile;
}

export function loadEndpointEnv(root = process.cwd()): EndpointEnv {
  const fromFile = parseEnvFile(root);
  return {
    baseURL: process.env.OPENAI_BASE_URL ?? fromFile['base_url'] ?? fromFile['BASE_URL'],
    apiKey: process.env.OPENAI_API_KEY ?? fromFile['api_key'] ?? fromFile['API_KEY'],
  };
}

/**
 * Anthropic Messages 端点凭证(M7):优先项目 .env 的小写 claude_* 键(用户为 coda 显式约定的
 * 网关端点),再回退 ANTHROPIC_* 环境变量。precedence 与 OpenAI 侧相反是有意的——宿主机常带
 * Claude Code 自己的 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN(指向 api.anthropic.com),
 * 若让它盖过 .env,coda 的网关 key 会被发去真 Anthropic 而 401。
 */
export function loadAnthropicEnv(root = process.cwd()): EndpointEnv {
  const fromFile = parseEnvFile(root);
  return {
    baseURL: fromFile['claude_base_url'] ?? fromFile['CLAUDE_BASE_URL'] ?? process.env.ANTHROPIC_BASE_URL,
    apiKey: fromFile['claude_api_key'] ?? fromFile['CLAUDE_API_KEY'] ?? process.env.ANTHROPIC_API_KEY,
  };
}
