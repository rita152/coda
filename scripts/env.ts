// Bun 在启动时原生加载 .env；这里仅做键名优先级映射，不引 dotenv 依赖。
// 支持 base_url/api_key(用户约定)与 OPENAI_BASE_URL/OPENAI_API_KEY；绝不打印 apiKey。

export interface EndpointEnv {
  baseURL: string | undefined;
  apiKey: string | undefined;
}

export function loadEndpointEnv(): EndpointEnv {
  return {
    baseURL: Bun.env.OPENAI_BASE_URL ?? Bun.env['base_url'] ?? Bun.env['BASE_URL'],
    apiKey: Bun.env.OPENAI_API_KEY ?? Bun.env['api_key'] ?? Bun.env['API_KEY'],
  };
}

/**
 * Anthropic Messages 端点凭证:优先项目 .env 的小写 claude_* 键(用户为 coda 显式约定的
 * 网关端点),再回退 ANTHROPIC_* 环境变量。precedence 与 OpenAI 侧相反是有意的——宿主机常带
 * Claude Code 自己的 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN(指向 api.anthropic.com),
 * 若让它盖过 .env,coda 的网关 key 会被发去真 Anthropic 而 401。
 */
export function loadAnthropicEnv(): EndpointEnv {
  return {
    baseURL: Bun.env['claude_base_url'] ?? Bun.env['CLAUDE_BASE_URL'] ?? Bun.env.ANTHROPIC_BASE_URL,
    apiKey: Bun.env['claude_api_key'] ?? Bun.env['CLAUDE_API_KEY'] ?? Bun.env.ANTHROPIC_API_KEY,
  };
}
