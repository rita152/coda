// 出站转换:内部 Context → Anthropic Messages wire 参数(规格见 docs/04-provider-adapter.md §8)。
// 本函数假定输入已经过 transform 层清洗(aborted 已滤、孤儿 toolCall 已补结果),只做机械映射。
//
// 与 openai-chat 的关键差异(协议表达力验证点,docs/04 §8):
//  - systemPrompt → 顶层 system 参数(不是消息);
//  - tool_result → user 消息内的 tool_result content block,图片直接进 block(原生支持,
//    不需要 openai-chat 的「抽出补 user 消息」补丁);
//  - assistant 的 ReasoningPart → thinking block(带 signature 原样回传);其中 Anthropic
//    redacted_thinking 通过 adapter 私有 opaque envelope 恢复为同名 block;
//  - 工具 schema 的 parameters → input_schema;
//  - 连续同 role 消息合并(Anthropic 要求 user/assistant 交替)。

import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  OutputConfig,
  RedactedThinkingBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  AssistantMessage,
  Context,
  ImagePart,
  ModelConfig,
  StreamOptions,
  ToolResultMessage,
  UserMessage,
} from '../../protocol/index.js';
import {
  isDefaultTemperatureOnlyModel,
  supportsEffortWithEnabledThinking,
  supportsEffortForModel,
  thinkingModeForModel,
  type ResolvedAnthropicCompat,
} from './compat.js';
import { decodeRedactedThinking } from './redacted-thinking.js';

// tool_result 的 content 子集(Anthropic 允许其中携带 text/image,原生支持图片)。
type ToolResultContent = Extract<ToolResultBlockParam['content'], unknown[]>[number];

interface DraftMessage {
  role: 'user' | 'assistant';
  content: ContentBlockParam[];
}

export function convertMessages(ctx: Context, compat: ResolvedAnthropicCompat): MessageParam[] {
  const drafts: DraftMessage[] = [];

  // 连续同 role 合并:tool_result 映射为 user 消息,同批多个工具结果 / 相邻 user 须并入同一 user 轮次
  // (Anthropic 要求 user/assistant 严格交替)。空 assistant 被跳过后,前后 user 也会因此合并。
  const emit = (role: 'user' | 'assistant', content: ContentBlockParam[]): void => {
    if (content.length === 0) return;                       // 空块不产生消息(空 assistant 跳过)
    const last = drafts.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else drafts.push({ role, content });
  };

  for (const m of ctx.messages) {
    switch (m.role) {
      case 'user':
        emit('user', convertUserContent(m, compat));
        break;
      case 'assistant':
        emit('assistant', convertAssistantContent(m));
        break;
      case 'tool_result':
        emit('user', [convertToolResult(m, compat)]);       // tool_result 是 user 消息内的一个 block
        break;
    }
  }
  return drafts.map((d) => ({ role: d.role, content: d.content }));
}

function convertUserContent(m: UserMessage, compat: ResolvedAnthropicCompat): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of m.content) {
    if (part.type === 'text') {
      if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      pushImage(blocks, part, compat);
    }
  }
  return blocks;
}

function convertAssistantContent(m: AssistantMessage): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of m.content) {
    switch (part.type) {
      case 'reasoning': {
        const redactedData = decodeRedactedThinking(part.signature);
        if (redactedData !== undefined) {
          const block: RedactedThinkingBlockParam = {
            type: 'redacted_thinking',
            data: redactedData,
          };
          blocks.push(block);
          break;
        }
        // thinking block 必须带合法 signature 才能回传;缺失(跨模型降级后本不该到这里)则跳过,
        // 避免服务端因无签名 thinking 块 400。
        if (part.signature && part.signature.length > 0) {
          blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature });
        }
        break;
      }
      case 'text':
        if (part.text.length > 0) blocks.push({ type: 'text', text: part.text });
        break;
      case 'tool_call': {
        const block: ToolUseBlockParam = {
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: part.arguments,   // 解析后的对象直接作为 input(rawArguments 为诊断用,不出站)
        };
        blocks.push(block);
        break;
      }
    }
  }
  return blocks;
}

function convertToolResult(m: ToolResultMessage, compat: ResolvedAnthropicCompat): ToolResultBlockParam {
  // details 永不出站(UI/持久化专用)。图片原生进 tool_result content(无 openai-chat 的抽出补丁)。
  const content: ToolResultContent[] = [];
  for (const part of m.content) {
    if (part.type === 'text') {
      if (part.text.length > 0) content.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      if (compat.supportsImageParts) content.push(toImageBlock(part));
      else content.push({ type: 'text', text: `[image omitted: ${part.mimeType}]` });
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: m.isError ? 'Error (no output)' : '(no output)' });
  }
  return { type: 'tool_result', tool_use_id: m.toolCallId, content, is_error: m.isError };
}

function pushImage(blocks: ContentBlockParam[], img: ImagePart, compat: ResolvedAnthropicCompat): void {
  if (compat.supportsImageParts) blocks.push(toImageBlock(img));
  else blocks.push({ type: 'text', text: `[image omitted: ${img.mimeType}]` });
}

function toImageBlock(img: ImagePart): ImageBlockParam {
  // protocol 的 mimeType 是开放 string;Anthropic 收窄为四种 base64 媒体类型,原样透传由服务端校验
  const source: Base64ImageSource = {
    type: 'base64',
    media_type: img.mimeType as Base64ImageSource['media_type'],
    data: img.data,
  };
  return { type: 'image', source };
}

// ---------- 工具 schema ----------

function convertTools(ctx: Context): Tool[] | undefined {
  if (!ctx.tools || ctx.tools.length === 0) return undefined;
  return ctx.tools.map((t) => ({
    name: t.name,
    ...(t.description != null && { description: t.description }),
    input_schema: t.parameters as Tool.InputSchema,   // parameters 已是 JSON Schema(工具层 z.toJSONSchema)
  }));
}

// ---------- 参数裁剪 ----------

export function buildParams(
  model: ModelConfig,
  ctx: Context,
  options: StreamOptions | undefined,
  compat: ResolvedAnthropicCompat,
): MessageCreateParamsStreaming {
  const requestedMax = options?.maxOutputTokens ?? model.defaults?.maxOutputTokens ?? compat.defaultMaxTokens;
  const temperature = options?.temperature ?? model.defaults?.temperature;
  const reasoningEffort = options?.reasoningEffort ?? model.defaults?.reasoningEffort;
  const effort = parseAnthropicEffort(reasoningEffort);
  const thinkingMode = compat.supportsThinking ? thinkingModeForModel(model.ref.model) : 'unsupported';
  const thinkingOn = effort !== undefined && thinkingMode !== 'unsupported';
  const budget = compat.thinkingBudgetTokens;
  // enabled 模式要求 max_tokens 严格大于 budget;adaptive 没有固定 budget,不抬高用户请求。
  const maxTokens = thinkingOn && thinkingMode === 'enabled' && requestedMax <= budget
    ? budget + requestedMax
    : requestedMax;

  const params: MessageCreateParamsStreaming = {
    model: model.ref.model,
    stream: true,
    max_tokens: maxTokens,
    messages: convertMessages(ctx, compat),
  };
  if (ctx.systemPrompt) params.system = ctx.systemPrompt;   // 顶层 system 参数,不是消息
  const tools = convertTools(ctx);
  if (tools) params.tools = tools;
  if (thinkingOn) {
    // thinking 开启时不发 temperature(Anthropic 要求 temperature 省略或为 1)。
    if (thinkingMode === 'adaptive') {
      params.thinking = { type: 'adaptive' };
      if (effort !== undefined && supportsEffortForModel(model.ref.model, effort)) {
        params.output_config = { effort };
      }
    } else {
      params.thinking = { type: 'enabled', budget_tokens: budget };
      if (effort !== undefined && supportsEffortWithEnabledThinking(model.ref.model) && supportsEffortForModel(model.ref.model, effort)) {
        params.output_config = { effort };
      }
    }
  } else if (
    temperature != null &&
    compat.supportsTemperature &&
    !isDefaultTemperatureOnlyModel(model.ref.model)
  ) {
    params.temperature = temperature;
  }
  return params;
}

type AnthropicEffort = Exclude<NonNullable<OutputConfig['effort']>, null>;

function parseAnthropicEffort(value: string | undefined): AnthropicEffort | undefined {
  switch (value) {
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
