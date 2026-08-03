// Agent-loop test harness. Even synthetic tools cross the RuntimeTurnProvider boundary so tests
// cannot accidentally exercise a removed static-tool or static-provider Agent path.

import { z } from 'zod';
import { Agent } from '../../src/agent/index.js';
import type {
  AgentConfig,
  RuntimeTurnProvider,
} from '../../src/agent/index.js';
import type {
  AgentEvent,
  AgentMessage,
  JSONSchema,
  ModelConfig,
  StreamFn,
  ToolCallPart,
} from '../../src/protocol/index.js';
import { createFauxStreamFn } from '../../src/providers/faux/index.js';
import type { FauxScript } from '../../src/providers/faux/index.js';
import { FileTracker } from '../../src/shared/index.js';
import type {
  ToolContext,
  ToolOutput,
} from '../../src/tools/types.js';

export const TEST_MODEL: ModelConfig = {
  ref: { provider: 'faux', api: 'faux', model: 'test' },
};

export interface TestCapability<P = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType<P>;
  readonly promptSnippet?: string;
  readonly executionMode?: 'sequential';
  execute(args: P, context: ToolContext): Promise<ToolOutput>;
}

/** Minimal synthetic capability with a single optional `value` field by default. */
export function makeTool<P = { value?: string }>(
  name: string,
  execute: (args: P, ctx: ToolContext) => Promise<ToolOutput>,
  opts?: {
    readonly executionMode?: 'sequential';
    readonly parameters?: z.ZodType<P>;
    readonly promptSnippet?: string;
  },
): TestCapability<P> {
  const defaultParameters = z.object({
    value: z.string().optional().describe('test value'),
  }) as unknown as z.ZodType<P>;
  return {
    name,
    description: `test capability ${name}`,
    parameters: opts?.parameters ?? defaultParameters,
    ...(opts?.executionMode === undefined ? {} : { executionMode: opts.executionMode }),
    ...(opts?.promptSnippet === undefined ? {} : { promptSnippet: opts.promptSnippet }),
    execute,
  };
}

/**
 * Construct the only Agent execution port used by tests. Provider, schemas and executors are
 * captured together for each turn, matching the production registry lifecycle.
 */
export function makeRuntimeTurnProvider(
  streamFn: StreamFn,
  tools: readonly TestCapability[] = [],
  systemPrompt = 'You are a test agent.',
): RuntimeTurnProvider {
  const fileTracker = new FileTracker();
  return {
    async capture() {
      const captured = [...tools];
      return {
        streamFn,
        assemble(messages) {
          const snippets = captured
            .map((tool) => tool.promptSnippet)
            .filter((snippet): snippet is string => snippet !== undefined && snippet.length > 0);
          return {
            ok: true as const,
            context: {
              systemPrompt: snippets.length === 0
                ? systemPrompt
                : `${systemPrompt}\n\n# Tool usage notes\n\n${snippets.join('\n\n')}`,
              messages: [...messages],
              tools: captured.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: z.toJSONSchema(tool.parameters) as JSONSchema,
              })),
            },
          };
        },
        async prepareToolCall(call: Readonly<ToolCallPart>) {
          const tool = captured.find((candidate) => candidate.name === call.name);
          if (tool === undefined) {
            return {
              ok: false as const,
              message:
                `Unknown tool "${call.name}". Available tools: ` +
                `${captured.map((candidate) => candidate.name).join(', ')}.`,
            };
          }
          const parsed = tool.parameters.safeParse(call.arguments);
          if (!parsed.success) {
            return {
              ok: false as const,
              message:
                `The ${tool.name} capability was called with invalid arguments: ` +
                `${z.prettifyError(parsed.error)}. ` +
                'Please rewrite the input so it satisfies the expected schema.',
            };
          }
          return {
            ok: true as const,
            args: parsed.data,
            executionMode: tool.executionMode ?? 'parallel' as const,
            execute: async (input: {
              readonly signal: AbortSignal;
              readonly onUpdate: (update: Readonly<Record<string, unknown>>) => void;
            }) => tool.execute(parsed.data, {
              cwd: process.cwd(),
              signal: input.signal,
              onUpdate: input.onUpdate,
              fileTracker,
            }),
          };
        },
      };
    },
  };
}

/**
 * Internal messages to the minimum wire pairing shape used by transform assertions.
 */
export function toWireShape(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const toolCalls = message.content
        .filter((part) => part.type === 'tool_call')
        .map((part) => ({ id: part.id }));
      return toolCalls.length > 0
        ? { role: 'assistant', tool_calls: toolCalls }
        : { role: 'assistant' };
    }
    if (message.role === 'tool_result') {
      return { role: 'tool', tool_call_id: message.toolCallId };
    }
    return { role: message.role };
  });
}

export function textOutput(text: string): ToolOutput {
  return { content: [{ type: 'text', text }] };
}

export interface Harness {
  agent: Agent;
  events: AgentEvent[];
  streamFn: ReturnType<typeof createFauxStreamFn>;
  /** Wait for the next future event that matches the predicate. */
  waitForEvent: (pred: (event: AgentEvent) => boolean) => Promise<AgentEvent>;
}

type HarnessConfig = Partial<Omit<AgentConfig, 'model' | 'runtimeTurnProvider'>> & {
  readonly tools?: readonly TestCapability[];
  readonly runtimeTurnProvider?: RuntimeTurnProvider;
  readonly systemPrompt?: string;
};

export function makeHarness(
  script: FauxScript,
  cfg: HarnessConfig = {},
): Harness {
  const streamFn = createFauxStreamFn(script);
  const tools = cfg.tools ?? [];
  const runtimeTurnProvider = cfg.runtimeTurnProvider
    ?? makeRuntimeTurnProvider(streamFn, tools, cfg.systemPrompt);
  const agent = new Agent({
    model: TEST_MODEL,
    runtimeTurnProvider,
    ...(cfg.transformContext === undefined ? {} : { transformContext: cfg.transformContext }),
    ...(cfg.afterToolCall === undefined ? {} : { afterToolCall: cfg.afterToolCall }),
    ...(cfg.shouldStopAfterTurn === undefined
      ? {}
      : { shouldStopAfterTurn: cfg.shouldStopAfterTurn }),
    ...(cfg.initialMessages === undefined ? {} : { initialMessages: cfg.initialMessages }),
    ...(cfg.initialQueues === undefined ? {} : { initialQueues: cfg.initialQueues }),
    ...(cfg.truncationScope === undefined ? {} : { truncationScope: cfg.truncationScope }),
  });
  const events: AgentEvent[] = [];
  const waiters: {
    readonly pred: (event: AgentEvent) => boolean;
    readonly resolve: (event: AgentEvent) => void;
  }[] = [];
  agent.subscribe((event) => {
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index] as (typeof waiters)[number];
      if (waiter.pred(event)) {
        waiters.splice(index, 1);
        waiter.resolve(event);
      }
    }
  });
  return {
    agent,
    events,
    streamFn,
    waitForEvent: (pred) =>
      new Promise<AgentEvent>((resolve) => {
        waiters.push({ pred, resolve });
      }),
  };
}

/** Normalize IDs/content while retaining the event grammar. */
export function typeSequence(events: AgentEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'message_start' || event.type === 'message_end') {
      return `${event.type}(${event.message.role})`;
    }
    if (event.type === 'agent_start') return `agent_start(${event.reason})`;
    if (event.type === 'agent_end') return `agent_end(${event.reason})`;
    return event.type;
  });
}
