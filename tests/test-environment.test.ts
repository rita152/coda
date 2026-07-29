// 测试编排环境的回归：外层即使已含 .env 凭证，spawn 白名单结果也不带凭证或 endpoint。

import { describe, expect, test } from 'bun:test';
import {
  assertSanitizedTestEnvironment,
  isSensitiveTestEnvironmentName,
  sanitizedTestEnvironment,
} from '../scripts/test-environment.js';

describe('sanitizedTestEnvironment', () => {
  test('canonical runner does not leak an inherited credential probe', () => {
    expect(Bun.env['CODA_TEST_LEAK_PROBE_API_KEY']).toBeUndefined();
    expect(Bun.env.NODE_ENV).toBe('test');
  });

  test('removes API keys, base URLs, tokens, and common credential names case-insensitively', () => {
    const source = {
      PATH: '/bin',
      HOME: '/tmp/home',
      api_key: 'local-key',
      OPENAI_API_KEY: 'openai-key',
      claude_base_url: 'https://example.invalid',
      AZURE_OPENAI_ENDPOINT: 'https://azure.example.invalid',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      DOCKER_AUTH_CONFIG: '{"auths":{}}',
      GITHUB_PAT: 'github-pat',
      AWS_ACCESS_KEY_ID: 'aws-key-id',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      DATABASE_PASSWORD: 'database-password',
    };

    const sanitized = sanitizedTestEnvironment(source);

    expect(sanitized).toEqual({ PATH: '/bin', HOME: '/tmp/home' });
    expect(source.api_key).toBe('local-key');
    expect(() => assertSanitizedTestEnvironment(sanitized)).not.toThrow();
  });

  test('self-check rejects a sensitive variable reintroduced after sanitizing', () => {
    expect(isSensitiveTestEnvironmentName('OPENAI_APIKEY')).toBe(true);
    expect(isSensitiveTestEnvironmentName('CODA_API_BASE')).toBe(true);
    expect(() =>
      assertSanitizedTestEnvironment({ PATH: '/bin', GITHUB_TOKEN: 'token' }),
    ).toThrow(/GITHUB_TOKEN/);
  });
});
