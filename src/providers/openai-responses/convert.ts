// 出站转换：内部 Context → Responses input/instructions/tools。
// 始终从本地 transcript 完整重建 input；previous_response_id 不参与正确性。

import type {
  EasyInputMessage,
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInput,
  ResponseInputItem,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';
import type {
  AssistantMessagePhase,
  AssistantMessage,
  Context,
  ImagePart,
  ModelConfig,
  StreamOptions,
  ToolResultMessage,
  UserMessage,
} from '../../protocol/index.js';
import { decodeReasoningMetadata } from './reasoning.js';

export function convertInput(ctx: Context): ResponseInput {
  const out: ResponseInputItem[] = [];
  for (const message of ctx.messages) {
    switch (message.role) {
      case 'user':
        out.push(convertUser(message));
        break;
      case 'assistant':
        pushAssistant(out, message);
        break;
      case 'tool_result':
        out.push(convertToolResult(message));
        break;
    }
  }
  return out;
}

function convertUser(message: UserMessage): EasyInputMessage {
  const images = message.content.filter((part): part is ImagePart => part.type === 'image');
  const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  if (images.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      ...(text.length > 0 ? [{ type: 'input_text' as const, text }] : []),
      ...images.map((image) => ({
        type: 'input_image' as const,
        detail: 'auto' as const,
        image_url: imageDataUrl(image),
      })),
    ],
  };
}

interface ReasoningAccumulator {
  item: ResponseReasoningItem;
  summaryIndexes: Set<number>;
  contentIndexes: Set<number>;
}

function pushAssistant(out: ResponseInputItem[], message: AssistantMessage): void {
  let pendingText = '';
  let pendingPhase: AssistantMessagePhase | undefined;
  const reasoning = new Map<string, ReasoningAccumulator>();
  const flushText = (): void => {
    if (pendingText.length === 0) return;
    out.push({
      role: 'assistant',
      content: pendingText,
      ...(pendingPhase !== undefined && { phase: pendingPhase }),
    });
    pendingText = '';
    pendingPhase = undefined;
  };
  const appendText = (text: string, phase: AssistantMessagePhase | undefined): void => {
    if (text.length === 0) return;
    if (pendingText.length > 0 && pendingPhase !== phase) flushText();
    if (pendingText.length === 0) pendingPhase = phase;
    pendingText += text;
  };

  for (const part of message.content) {
    if (part.type === 'text') {
      appendText(part.text, part.phase);
      continue;
    }
    if (part.type === 'reasoning') {
      const metadata = decodeReasoningMetadata(part.signature);
      if (metadata === undefined) {
        // 同 provider 但缺少可验证的 Responses replay 信封时降级为 assistant 文本；
        // 跨模型的常规路径已由 transform 层做同样降级。
        appendText(part.text, undefined);
        continue;
      }
      flushText();
      let accumulator = reasoning.get(metadata.itemId);
      if (accumulator === undefined) {
        const item: ResponseReasoningItem = {
          id: metadata.itemId,
          type: 'reasoning',
          summary: [],
          ...(metadata.encryptedContent !== undefined && {
            encrypted_content: metadata.encryptedContent,
          }),
        };
        accumulator = { item, summaryIndexes: new Set(), contentIndexes: new Set() };
        reasoning.set(metadata.itemId, accumulator);
        out.push(item);
      } else if (metadata.encryptedContent !== undefined) {
        accumulator.item.encrypted_content = metadata.encryptedContent;
      }
      if (metadata.kind === 'summary' && !accumulator.summaryIndexes.has(metadata.index)) {
        accumulator.summaryIndexes.add(metadata.index);
        accumulator.item.summary.push({ type: 'summary_text', text: part.text });
      } else if (metadata.kind === 'content' && !accumulator.contentIndexes.has(metadata.index)) {
        accumulator.contentIndexes.add(metadata.index);
        (accumulator.item.content ??= []).push({ type: 'reasoning_text', text: part.text });
      }
      // kind:'item' 是无可见 summary/content 的 reasoning item 占位；
      // 上面创建的空 summary item + id/encrypted_content 已是完整 replay 形态。
      continue;
    }

    flushText();
    out.push({
      type: 'function_call',
      call_id: part.id,
      name: part.name,
      arguments: part.rawArguments ?? JSON.stringify(part.arguments),
    });
  }
  flushText();
}

function convertToolResult(message: ToolResultMessage): ResponseInputItem.FunctionCallOutput {
  const images = message.content.filter((part): part is ImagePart => part.type === 'image');
  const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  let output: string | ResponseFunctionCallOutputItemList;
  if (images.length === 0) {
    output = text || (message.isError ? 'Error (no output)' : '(no output)');
  } else {
    output = [
      ...(text.length > 0 ? [{ type: 'input_text' as const, text }] : []),
      ...images.map((image) => ({
        type: 'input_image' as const,
        detail: 'auto' as const,
        image_url: imageDataUrl(image),
      })),
    ];
  }
  return { type: 'function_call_output', call_id: message.toolCallId, output };
}

function imageDataUrl(image: ImagePart): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function convertTools(ctx: Context): FunctionTool[] {
  return (ctx.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // 内部 ToolSchema 是通用 JSON Schema；adapter 不擅自改写为 strict 子集，
    // 参数合法性仍由 agent 的工具定义校验。
    strict: false,
  }));
}

type ResponsesReasoning = NonNullable<ResponseCreateParamsStreaming['reasoning']>;
type ResponsesReasoningEffort = NonNullable<ResponsesReasoning['effort']>;

interface KnownModelParameters {
  models: readonly string[];
  supportsTemperature: boolean;
  reasoningEfforts: readonly ResponsesReasoningEffort[];
}

const KNOWN_MODEL_PARAMETERS: readonly KnownModelParameters[] = [
  {
    models: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    models: ['gpt-5.5-pro', 'gpt-5.4-pro', 'gpt-5.2-pro'],
    supportsTemperature: false,
    reasoningEfforts: ['medium', 'high', 'xhigh'],
  },
  {
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    models: ['gpt-5.3-codex', 'gpt-5.2-codex'],
    supportsTemperature: false,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    models: ['gpt-5.1'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
  },
  {
    models: ['gpt-5-pro'],
    supportsTemperature: false,
    reasoningEfforts: ['high'],
  },
  {
    models: ['gpt-5'],
    supportsTemperature: false,
    reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  },
  {
    models: ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini'],
    supportsTemperature: false,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
    ],
    supportsTemperature: true,
    reasoningEfforts: [],
  },
];

function knownModelParameters(model: string): KnownModelParameters | undefined {
  const id = model.trim().toLowerCase();
  return KNOWN_MODEL_PARAMETERS.find((entry) =>
    entry.models.some((base) => matchesModelOrSnapshot(id, base)),
  );
}

function matchesModelOrSnapshot(model: string, base: string): boolean {
  if (model === base) return true;
  if (!model.startsWith(`${base}-`)) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(model.slice(base.length + 1));
}

function parseReasoningEffort(value: string | undefined): ResponsesReasoningEffort | undefined {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value;
    default:
      return undefined;
  }
}

function parseTemperature(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 2
    ? value
    : undefined;
}

export function buildParams(
  model: ModelConfig,
  ctx: Context,
  options?: StreamOptions,
): ResponseCreateParamsStreaming {
  const maxOutputTokens = options?.maxOutputTokens ?? model.defaults?.maxOutputTokens;
  const requestedTemperature = options?.temperature ?? model.defaults?.temperature;
  const requestedReasoningEffort = options?.reasoningEffort ?? model.defaults?.reasoningEffort;
  const knownParameters = knownModelParameters(model.ref.model);
  const temperature = knownParameters?.supportsTemperature === false
    ? undefined
    : parseTemperature(requestedTemperature);
  const parsedReasoningEffort = parseReasoningEffort(requestedReasoningEffort);
  const reasoningEffort =
    parsedReasoningEffort !== undefined &&
    (knownParameters === undefined || knownParameters.reasoningEfforts.includes(parsedReasoningEffort))
      ? parsedReasoningEffort
      : undefined;
  const supportsReasoning = knownParameters === undefined || knownParameters.reasoningEfforts.length > 0;
  const reasoning: ResponsesReasoning | undefined = supportsReasoning
    ? {
        summary: 'auto',
        ...(reasoningEffort !== undefined && { effort: reasoningEffort }),
      }
    : undefined;
  return {
    model: model.ref.model,
    instructions: ctx.systemPrompt,
    input: convertInput(ctx),
    tools: convertTools(ctx),
    stream: true,
    // 本地 transcript 全量重放是正确性路径；此请求不发送 previous_response_id。
    ...(supportsReasoning && { include: ['reasoning.encrypted_content' as const] }),
    ...(maxOutputTokens !== undefined && { max_output_tokens: maxOutputTokens }),
    ...(temperature !== undefined && { temperature }),
    // 未知模型保留历史 summary 回退；已知非 reasoning 模型不发送相关字段。
    ...(reasoning !== undefined && { reasoning }),
  };
}
