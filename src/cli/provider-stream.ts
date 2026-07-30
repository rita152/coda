// CLI 的唯一 provider 分发点。ModelRef.api 是每次请求的权威协议选择；
// provider id、模型名或 base URL 都不得参与协议猜测。

import type {
  AssistantMessage,
  ModelRef,
  StreamFn,
} from '../protocol/index.js';
import { ProviderEventStream } from '../protocol/index.js';
import { streamAnthropicMessages } from '../providers/anthropic-messages/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamOpenAIResponses } from '../providers/openai-responses/index.js';

export function createProviderStreamFn(fauxScript?: FauxScript): StreamFn {
  const faux = fauxScript === undefined ? undefined : createFauxStreamFn(fauxScript);
  return (model, context, options) => {
    const adapter = providerAdapterForApi(model.ref.api, faux);
    if (adapter !== undefined) return adapter(model, context, options);
    return unsupportedApiStream(
      model.ref,
      model.ref.api === 'faux'
        ? 'faux provider 未配置脚本'
        : `不支持的模型协议: ${model.ref.api}`,
    );
  };
}

/** 导出供装配契约测试；协议选择只读 ModelRef.api，不读 provider/model/baseURL。 */
export function providerAdapterForApi(
  api: ModelRef['api'],
  faux?: StreamFn,
): StreamFn | undefined {
  switch (api) {
    case 'openai-chat':
      return streamOpenAIChat;
    case 'openai-responses':
      return streamOpenAIResponses;
    case 'anthropic-messages':
      return streamAnthropicMessages;
    case 'faux':
      return faux;
    default:
      return undefined;
  }
}

function unsupportedApiStream(ref: ModelRef, errorMessage: string): ProviderEventStream {
  const stream = new ProviderEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    id: `a_${crypto.randomUUID()}`,
    timestamp: Date.now(),
    content: [],
    model: { ...ref },
    stopReason: 'error',
    errorMessage,
    errorDetails: {
      kind: 'unknown',
      retryable: false,
    },
    usage: { input: 0, output: 0 },
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'error', message });
  stream.end(message);
  return stream;
}
