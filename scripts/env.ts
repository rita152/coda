// .env 解析(不引 dotenv 依赖):支持 base_url/api_key(用户约定)与 OPENAI_BASE_URL/OPENAI_API_KEY。
// 仅供 scripts/ 使用;绝不打印 apiKey。
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface EndpointEnv {
  baseURL: string | undefined;
  apiKey: string | undefined;
}

export function loadEndpointEnv(root = process.cwd()): EndpointEnv {
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
  return {
    baseURL: process.env.OPENAI_BASE_URL ?? fromFile['base_url'] ?? fromFile['BASE_URL'],
    apiKey: process.env.OPENAI_API_KEY ?? fromFile['api_key'] ?? fromFile['API_KEY'],
  };
}
