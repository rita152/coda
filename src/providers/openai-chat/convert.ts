// 出站转换:内部 Context → Chat Completions wire 消息(规格见 docs/04-provider-adapter.md 第 3 节)。
// 本函数假定输入已经过 transform 层清洗(aborted 已滤、孤儿 toolCall 已补结果),
// 只做机械映射,不做修复——职责分开才可各自测试。

import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  AssistantMessage,
  Context,
  ImagePart,
  JSONSchema,
  ModelConfig,
  StreamOptions,
  ToolResultMessage,
  UserMessage,
} from '../../protocol/index.js';
import type { ResolvedCompat } from './compat.js';

export function convertMessages(ctx: Context, compat: ResolvedCompat): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (ctx.systemPrompt) {
    out.push({ role: compat.supportsDeveloperRole ? 'developer' : 'system', content: ctx.systemPrompt });
  }
  const messages = ctx.messages;
  let pendingImages: ImagePart[] = [];   // 本批 tool 结果中的图片,批次结束后统一补 user 消息

  // 方言垫片基于 wire 相邻关系而非转录相邻:空/仅 reasoning 的 assistant 会被跳过、
  // 图片合成消息会插入,转录里的「下一条」不等于 wire 上的「下一条」。
  const pushUser = (msg: ChatCompletionMessageParam): void => {
    if (compat.requiresAssistantAfterToolResult && out.at(-1)?.role === 'tool') {
      out.push({ role: 'assistant', content: 'Continuing.' });
    }
    out.push(msg);
  };

  messages.forEach((m, i) => {
    switch (m.role) {
      case 'user':
        pushUser(convertUser(m, compat));
        break;
      case 'assistant':
        pushAssistant(out, m);
        break;
      case 'tool_result': {
        pushToolResult(out, m, compat);
        pendingImages.push(...m.content.filter((p): p is ImagePart => p.type === 'image'));
        const next = messages[i + 1];
        if (next?.role !== 'tool_result') {
          // 批次结束:tool 消息必须紧跟 assistant 连续排列,图片 user 消息只能在整批之后补
          if (pendingImages.length > 0 && compat.supportsImageParts) {
            pushUser({
              role: 'user',
              content: [
                { type: 'text', text: 'Attached image(s) from tool result:' },
                ...pendingImages.map(toImageUrlPart),
              ],
            });
          }
          pendingImages = [];
        }
        break;
      }
    }
  });
  return out;
}

function convertUser(m: UserMessage, compat: ResolvedCompat): ChatCompletionMessageParam {
  const images = m.content.filter((p): p is ImagePart => p.type === 'image');
  const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  // 纯文本输出字符串而非单元素数组(pi 教训:数组形式诱发部分模型模仿结构输出)。
  if (images.length === 0) {
    return { role: 'user', content: text };
  }
  if (!compat.supportsImageParts) {
    // 与 transform 层的降级形态对齐:占位文本,不无声丢弃(模型应知道「这里曾有图」)
    const placeholders = images.map((p) => `[image omitted: ${p.mimeType}]`).join(' ');
    return { role: 'user', content: text ? `${text} ${placeholders}` : placeholders };
  }
  const parts: ChatCompletionContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images) parts.push(toImageUrlPart(img));
  return { role: 'user', content: parts };
}

function pushAssistant(out: ChatCompletionMessageParam[], m: AssistantMessage): void {
  // ReasoningPart 在此被丢弃:同模型重放时 Chat Completions 无处安放 reasoning;
  // 跨模型时 transform 层已按需降级为文本。
  const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  const toolCalls = m.content.filter((p) => p.type === 'tool_call');
  if (!text && toolCalls.length === 0) return;   // 空 assistant 消息跳过(很多 provider 对此 400)
  out.push({
    role: 'assistant',
    content: text || null,                        // 有 tool_calls 时允许 null
    ...(toolCalls.length > 0 && {
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        // 优先 rawArguments:保留模型原始输出,避免 parse→stringify 往返改变键序或丢失截断现场
        function: { name: tc.name, arguments: tc.rawArguments ?? JSON.stringify(tc.arguments) },
      })),
    }),
  });
}

function pushToolResult(out: ChatCompletionMessageParam[], m: ToolResultMessage, compat: ResolvedCompat): void {
  // tool 消息装不下图片:由 convertMessages 在批次结束后抽出补 user 消息。details 永不出站。
  // 非视觉端点的图片兜底:transform 层只在显式 supportsImageParts:false 时降级,
  // baseURL 自动推断出的非视觉 profile 走到这里——占位并入 tool 文本,不无声丢弃。
  const textOnly = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  const placeholders = compat.supportsImageParts
    ? ''
    : m.content
        .filter((p): p is ImagePart => p.type === 'image')
        .map((p) => `[image omitted: ${p.mimeType}]`)
        .join(' ');
  const text =
    [textOnly, placeholders].filter((s) => s.length > 0).join(' ') ||
    (m.isError ? 'Error (no output)' : '(no output)');
  out.push({
    role: 'tool',
    tool_call_id: m.toolCallId,
    content: text,
    ...(compat.requiresToolResultName && { name: m.toolName }),
  } as ChatCompletionMessageParam);
}

function toImageUrlPart(img: ImagePart): ChatCompletionContentPart {
  return { type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } };
}

// ---------- strict schema 清洗 ----------

/**
 * OpenAI Structured Outputs 的 JSON Schema 子集清洗:根为 object、
 * 所有对象 additionalProperties:false、全属性入 required、原可选属性转 type:[...,'null']。
 * protocol 层的 ToolSchema 保持原始 JSON Schema,清洗只发生在出站瞬间。
 */
export function toStrictSchema(schema: JSONSchema): JSONSchema {
  const clone = structuredClone(schema);
  walkStrict(clone);
  return clone;
}

function walkStrict(node: unknown): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const props = obj['properties'] as Record<string, unknown> | undefined;
  if (obj['type'] === 'object' || props) {
    // additionalProperties 已是 schema 对象(z.record 形态):递归清洗后保留,
    // 静默改 false 会把 record 变成禁止任何键的空对象
    if (obj['additionalProperties'] === null || typeof obj['additionalProperties'] !== 'object') {
      obj['additionalProperties'] = false;
    } else {
      walkStrict(obj['additionalProperties']);
    }
    if (props) {
      const originalRequired = new Set(Array.isArray(obj['required']) ? (obj['required'] as string[]) : []);
      obj['required'] = Object.keys(props);
      for (const [key, child] of Object.entries(props)) {
        walkStrict(child);
        if (!originalRequired.has(key)) addNullType(child);
      }
    } else {
      obj['properties'] = {};                    // 裸 object:补空 properties/required,OpenAI strict 拒收缺失形态
      obj['required'] = [];
    }
  }
  const items = obj['items'];
  if (Array.isArray(items)) items.forEach(walkStrict);   // 旧式元组:items 为数组
  else if (items) walkStrict(items);
  const prefixItems = obj['prefixItems'];
  if (Array.isArray(prefixItems)) prefixItems.forEach(walkStrict);   // 2020-12 元组(zod v4 产出)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = obj[key];
    if (Array.isArray(branch)) branch.forEach(walkStrict);
  }
  // 递归/复用 schema:zod v4 z.toJSONSchema() 产出 $defs + $ref,内层同样要清洗
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = obj[key];
    if (defs !== null && typeof defs === 'object') {
      for (const def of Object.values(defs as Record<string, unknown>)) walkStrict(def);
    }
  }
}

function addNullType(child: unknown): void {
  if (child === null || typeof child !== 'object' || Array.isArray(child)) return;
  const obj = child as Record<string, unknown>;
  const t = obj['type'];
  if (typeof t === 'string' && t !== 'null') obj['type'] = [t, 'null'];
  else if (Array.isArray(t) && !t.includes('null')) obj['type'] = [...t, 'null'];
  else if (t === undefined) {
    // 无 type 的形态($ref / anyOf):包一层 anyOf 加 null 分支,可选语义不静默变必填
    if (Array.isArray(obj['anyOf'])) {
      (obj['anyOf'] as unknown[]).push({ type: 'null' });
      return;
    }
    if (obj['$ref'] !== undefined) {
      const ref = obj['$ref'];
      delete obj['$ref'];
      obj['anyOf'] = [{ $ref: ref }, { type: 'null' }];
      return;
    }
  }
  // enum/const 与 null 化同步,否则产出自相矛盾的 schema(null 不在 enum 内)
  if (Array.isArray(obj['enum']) && !(obj['enum'] as unknown[]).includes(null)) {
    (obj['enum'] as unknown[]).push(null);
  }
  if (obj['const'] !== undefined) {
    obj['enum'] = [obj['const'], null];
    delete obj['const'];
  }
}

// ---------- 参数裁剪 ----------

type OpenAIReasoningEffort = NonNullable<ChatCompletionCreateParamsStreaming['reasoning_effort']>;

interface KnownModelParameters {
  models: readonly string[];
  supportsTemperature: boolean;
  reasoningEfforts: readonly OpenAIReasoningEffort[];
}

const KNOWN_MODEL_PARAMETERS: readonly KnownModelParameters[] = [
  {
    models: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.2'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    models: ['gpt-5.1'],
    supportsTemperature: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
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

function parseReasoningEffort(value: string | undefined): OpenAIReasoningEffort | undefined {
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
  options: StreamOptions | undefined,
  compat: ResolvedCompat,
): ChatCompletionCreateParamsStreaming {
  const maxTokens = options?.maxOutputTokens ?? model.defaults?.maxOutputTokens;
  const requestedTemperature = options?.temperature ?? model.defaults?.temperature;
  const requestedReasoningEffort = options?.reasoningEffort ?? model.defaults?.reasoningEffort;
  const knownParameters = knownModelParameters(model.ref.model);
  const temperature =
    compat.supportsTemperature && knownParameters?.supportsTemperature !== false
      ? parseTemperature(requestedTemperature)
      : undefined;
  const parsedReasoningEffort = compat.supportsReasoningEffort
    ? parseReasoningEffort(requestedReasoningEffort)
    : undefined;
  const reasoningEffort =
    parsedReasoningEffort !== undefined &&
    (knownParameters === undefined || knownParameters.reasoningEfforts.includes(parsedReasoningEffort))
      ? parsedReasoningEffort
      : undefined;
  const tools: ChatCompletionTool[] | undefined = ctx.tools?.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: compat.supportsStrictTools ? toStrictSchema(t.parameters) : t.parameters,
      ...(compat.supportsStrictTools && { strict: true }),
    },
  }));
  return {
    model: model.ref.model,
    messages: convertMessages(ctx, compat),
    stream: true,
    ...(compat.supportsUsageInStreaming && { stream_options: { include_usage: true } }),
    ...(maxTokens != null && { [compat.maxTokensField]: maxTokens }),
    ...(temperature !== undefined && { temperature }),
    ...(reasoningEffort !== undefined && { reasoning_effort: reasoningEffort }),
    ...(tools && tools.length > 0 && { tools }),
  };
}
