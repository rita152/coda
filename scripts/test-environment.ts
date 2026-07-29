// 测试进程环境隔离：保留 PATH/HOME 等运行必需项，同时移除凭证、token 与 API endpoint。
// 外层 `bun run` 可能已经加载 .env，因此仅给内层 Bun 传 `--no-env-file` 并不足以隔离。

const SENSITIVE_NAME_MARKERS = [
  'API_KEY',
  'APIKEY',
  'BASE_URL',
  'BASEURL',
  'API_BASE',
  'ENDPOINT',
  'ACCESS_KEY',
  'AUTH',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'CREDENTIAL',
] as const;

export function isSensitiveTestEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase().replaceAll('-', '_');
  return (
    normalized === 'KEY' ||
    normalized.endsWith('_KEY') ||
    normalized === 'PAT' ||
    normalized.endsWith('_PAT') ||
    SENSITIVE_NAME_MARKERS.some((marker) => normalized.includes(marker))
  );
}

export function sanitizedTestEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isSensitiveTestEnvironmentName(name)) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

/** 防御性自检：测试编排器和 e2e harness 在 spawn 前都可验证净化结果。 */
export function assertSanitizedTestEnvironment(env: Readonly<Record<string, string>>): void {
  const leakedNames = Object.keys(env).filter(isSensitiveTestEnvironmentName);
  if (leakedNames.length > 0) {
    throw new Error(`refusing to start tests with sensitive environment variables: ${leakedNames.join(', ')}`);
  }
}
