import {
  describe,
  expect,
  it,
} from 'bun:test';
import {
  anthropicSdkBaseURL,
  streamAnthropicMessages,
} from '../providers/anthropic-messages/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamOpenAIResponses } from '../providers/openai-responses/index.js';
import {
  createProviderStreamFn,
  providerAdapterForApi,
} from './provider-stream.js';

describe('ModelRef.api 动态 adapter 分发', () => {
  it('三个可配置协议逐一分发到现有 adapter，不根据 provider/model 猜测', () => {
    expect(providerAdapterForApi('openai-chat')).toBe(streamOpenAIChat);
    expect(providerAdapterForApi('openai-responses')).toBe(streamOpenAIResponses);
    expect(providerAdapterForApi('anthropic-messages')).toBe(streamAnthropicMessages);
    expect(providerAdapterForApi('future-unknown-api')).toBeUndefined();
  });

  it('未知 api 不 throw，而是产生合法 start → error 终态流', async () => {
    const streamFn = createProviderStreamFn();
    const stream = streamFn(
      {
        ref: {
          provider: 'custom:test',
          api: 'future-unknown-api',
          model: 'm',
        },
        apiKey: 'must-not-appear',
      },
      { messages: [] },
    );
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    expect(result.model).toEqual({
      provider: 'custom:test',
      api: 'future-unknown-api',
      model: 'm',
    });
    expect(result.stopReason).toBe('error');
    expect(JSON.stringify(events)).not.toContain('must-not-appear');
  });

  it('faux 也走同一 api 分发槽，供 CLI/e2e 保持确定性', async () => {
    const faux = createFauxStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'ok' }] }],
    });
    expect(providerAdapterForApi('faux', faux)).toBe(faux);
    const stream = createProviderStreamFn({
      turns: [{ events: [{ kind: 'text', text: 'ok' }] }],
    })(
      { ref: { provider: 'faux', api: 'faux', model: 'fixture' } },
      { messages: [] },
    );
    const result = await stream.result();
    expect(result.model.api).toBe('faux');
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('Anthropic SDK 只剥离版本根，避免 OpenCode Go /v1/v1/messages', () => {
    expect(anthropicSdkBaseURL('https://opencode.ai/zen/go/v1')).toBe(
      'https://opencode.ai/zen/go',
    );
    expect(anthropicSdkBaseURL('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com',
    );
    expect(anthropicSdkBaseURL('https://example.test/service/v10')).toBe(
      'https://example.test/service/v10',
    );
  });
});
