// transform 层单测(M4;规格 docs/04 §6 四步 + docs/06 §7)。
// convertContext 是纯函数视图变换:不落盘、幂等、绝不改写输入。

import { describe, expect, it } from 'vitest';
import { convertContext, INTERRUPTED_RESULT_TEXT, isSameModel } from '../src/agent/index.js';
import type {
  AgentMessage,
  AssistantMessage,
  Context,
  ModelRef,
  ToolResultMessage,
  UserMessage,
} from '../src/protocol/index.js';
import { assertToolCallPairing } from './helpers/wire-pairing.js';
import { toWireShape } from './helpers/agent-harness.js';

const MODEL_A: ModelRef = { provider: 'faux', api: 'faux', model: 'a' };
const MODEL_B: ModelRef = { provider: 'other', api: 'anthropic-messages', model: 'b' };

function user(text: string): UserMessage {
  return { role: 'user', id: `u_${text}`, timestamp: 1, content: [{ type: 'text', text }], source: 'prompt' };
}

function assistant(
  parts: AssistantMessage['content'],
  over?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    role: 'assistant',
    id: 'a1',
    timestamp: 2,
    content: parts,
    model: MODEL_A,
    stopReason: 'tool_calls',
    usage: { input: 1, output: 1 },
    ...over,
  };
}

function result(toolCallId: string, over?: Partial<ToolResultMessage>): ToolResultMessage {
  return {
    role: 'tool_result',
    id: `tr_${toolCallId}`,
    timestamp: 3,
    toolCallId,
    toolName: 't',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    ...over,
  };
}

function ctxOf(messages: AgentMessage[]): Context {
  return { systemPrompt: 'sp', messages, tools: [] };
}

describe('convertContext 步骤 1:aborted/error assistant 滤除', () => {
  it('aborted assistant 整条跳过,error 同理;正常消息保留', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'text', text: 'partial' }], { stopReason: 'aborted' }),
      assistant([{ type: 'text', text: 'boom' }], { id: 'a2', stopReason: 'error', errorMessage: 'x' }),
      assistant([{ type: 'text', text: 'fine' }], { id: 'a3', stopReason: 'stop' }),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const kept = out.messages[1] as AssistantMessage;
    expect(kept.id).toBe('a3');
  });

  it('被滤 assistant 的 toolResult 一并滤除(不留无前置 assistant 的孤儿 tool 消息)', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }], { stopReason: 'aborted' }),
      result('c1'),
      assistant([{ type: 'text', text: 'ok' }], { id: 'a2', stopReason: 'stop' }),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    assertToolCallPairing(toWireShape(out.messages));
  });
});

describe('convertContext 步骤 2:孤儿 toolCall 补合成结果', () => {
  it('部分执行的批次:缺失的 toolCall 获得 isError 合成结果,插在既有结果之后', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([
        { type: 'tool_call', id: 'c1', name: 'read', arguments: {} },
        { type: 'tool_call', id: 'c2', name: 'bash', arguments: {} },
        { type: 'tool_call', id: 'c3', name: 'edit', arguments: {} },
      ]),
      result('c1'),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'tool_result', 'tool_result']);
    const synth2 = out.messages[3] as ToolResultMessage;
    const synth3 = out.messages[4] as ToolResultMessage;
    expect([synth2.toolCallId, synth3.toolCallId]).toEqual(['c2', 'c3']);
    for (const s of [synth2, synth3]) {
      expect(s.isError).toBe(true);
      expect(s.content).toEqual([{ type: 'text', text: INTERRUPTED_RESULT_TEXT }]);
    }
    expect(synth2.toolName).toBe('bash');
    assertToolCallPairing(toWireShape(out.messages));
  });

  it('后续 turn 的消息不被误吞:合成结果只插在所属 assistant 的结果块后', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }]),
      // c1 无结果(孤儿);随后是 steering user + 新 assistant
      user('steer'),
      assistant([{ type: 'text', text: 'done' }], { id: 'a2', stopReason: 'stop' }),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result', 'user', 'assistant']);
    assertToolCallPairing(toWireShape(out.messages));
  });

  it('配对完整时是恒等变换(幂等)', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }]),
      result('c1'),
      assistant([{ type: 'text', text: 'done' }], { id: 'a2', stopReason: 'stop' }),
    ];
    const once = convertContext(ctxOf(messages), MODEL_A);
    expect(once.messages).toEqual(messages);
    const twice = convertContext(ctxOf(once.messages as AgentMessage[]), MODEL_A);
    expect(twice.messages).toEqual(once.messages);
  });
});

describe('convertContext 步骤 3:跨模型降级', () => {
  it('跨模型:ReasoningPart 降级为 TextPart(剥 signature);同模型原样保留', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant(
        [
          { type: 'reasoning', text: 'thinking...', signature: 'sig123' },
          { type: 'text', text: 'answer' },
        ],
        { stopReason: 'stop' },
      ),
    ];
    const same = convertContext(ctxOf(messages), MODEL_A);
    expect((same.messages[1] as AssistantMessage).content[0]).toEqual({
      type: 'reasoning',
      text: 'thinking...',
      signature: 'sig123',
    });
    const cross = convertContext(ctxOf(messages), MODEL_B);
    expect((cross.messages[1] as AssistantMessage).content[0]).toEqual({ type: 'text', text: 'thinking...' });
  });

  it('跨模型:超长 toolCallId 压到 ≤40 字符,tool_call 与 tool_result 映射一致;同模型不动', () => {
    const longId = 'fc_' + 'x'.repeat(80);
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: longId, name: 'read', arguments: {} }]),
      result(longId),
    ];
    const same = convertContext(ctxOf(messages), MODEL_A);
    expect((same.messages[1] as AssistantMessage).content[0]).toMatchObject({ id: longId });

    const cross = convertContext(ctxOf(messages), MODEL_B);
    const call = (cross.messages[1] as AssistantMessage).content[0];
    const res = cross.messages[2] as ToolResultMessage;
    expect(call?.type === 'tool_call' && call.id.length).toBeLessThanOrEqual(40);
    expect(call?.type === 'tool_call' && call.id).toBe(res.toolCallId);
    // 确定性:同输入恒同像
    const cross2 = convertContext(ctxOf(messages), MODEL_B);
    expect((cross2.messages[2] as ToolResultMessage).toolCallId).toBe(res.toolCallId);
    assertToolCallPairing(toWireShape(cross.messages));
  });
});

describe('convertContext 步骤 4:非视觉模型图片降级', () => {
  it('supportsImages:false → user 与 tool_result 中的 ImagePart 降为占位文本;true → 原样', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        id: 'u1',
        timestamp: 1,
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
        source: 'prompt',
      },
      assistant([{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }]),
      result('c1', { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/jpeg' }] }),
    ];
    const kept = convertContext(ctxOf(messages), MODEL_A, { supportsImages: true });
    expect((kept.messages[0] as UserMessage).content[1]).toMatchObject({ type: 'image' });

    const down = convertContext(ctxOf(messages), MODEL_A, { supportsImages: false });
    expect((down.messages[0] as UserMessage).content[1]).toEqual({
      type: 'text',
      text: '[image omitted: image/png]',
    });
    expect((down.messages[2] as ToolResultMessage).content[0]).toEqual({
      type: 'text',
      text: '[image omitted: image/jpeg]',
    });
  });
});

describe('convertContext 块归属配对(M4 对抗核查:跨 turn id 复用 / 声明序 / dangling)', () => {
  // 出处:src/agent/transform.ts 头注——「每条 tool_result 只归属于其前方最近一条声明了
  // 该 id 的 assistant(块内配对)」。provider 跨 turn 复用确定性 id(vLLM/llama.cpp 的
  // call_0)时,全局 id 集合会把后 turn 的真实结果错配给前 turn 的孤儿/被滤块。
  it('跨 turn 复用 call_0(前块孤儿):前块补合成 interrupted 结果,后块真实结果原样保留', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: 'call_0', name: 'read', arguments: {} }]),   // A:孤儿(非 aborted)
      { ...user('steer'), source: 'steering' },
      assistant([{ type: 'tool_call', id: 'call_0', name: 'read', arguments: {} }], { id: 'a2' }),   // B:同 id
      result('call_0'),                                                                // 只属于 B
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    expect(out.messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'tool_result', 'user', 'assistant', 'tool_result',
    ]);
    // A 块:获得合成结果(若按全局 id 集合判孤儿,B 的真实结果会被误配到此,A 不再补)
    const synth = out.messages[2] as ToolResultMessage;
    expect(synth.toolCallId).toBe('call_0');
    expect(synth.isError).toBe(true);
    expect(synth.content).toEqual([{ type: 'text', text: INTERRUPTED_RESULT_TEXT }]);
    // B 块:真实结果原样(消息本体未被替换)
    const real = out.messages[5] as ToolResultMessage;
    expect(real.id).toBe('tr_call_0');
    expect(real.isError).toBe(false);
    expect(real.content).toEqual([{ type: 'text', text: 'ok' }]);
    assertToolCallPairing(toWireShape(out.messages));
  });

  it('跨 turn 复用 call_0(前块 aborted):前块整体滤除,后块真实结果不被连带滤除也不被替换成合成', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: 'call_0', name: 'read', arguments: {} }], { stopReason: 'aborted' }),
      { ...user('steer'), source: 'steering' },
      assistant([{ type: 'tool_call', id: 'call_0', name: 'read', arguments: {} }], { id: 'a2' }),
      result('call_0'),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    // aborted 块只连带滤自己的结果:B 的结果按块归属存活
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'tool_result']);
    const real = out.messages[3] as ToolResultMessage;
    expect(real.id).toBe('tr_call_0');
    expect(real.isError).toBe(false);
    expect(real.content).toEqual([{ type: 'text', text: 'ok' }]);   // 真实输出,不是 interrupted 合成
    assertToolCallPairing(toWireShape(out.messages));
  });

  it('并行批中间孤儿:出站结果按 tool_calls 声明序 c1、c2(合成)、c3,不是「既有在前合成殿后」', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([
        { type: 'tool_call', id: 'c1', name: 'read', arguments: {} },
        { type: 'tool_call', id: 'c2', name: 'bash', arguments: {} },
        { type: 'tool_call', id: 'c3', name: 'edit', arguments: {} },
      ]),
      result('c1'),
      result('c3'),      // c2 孤儿
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);
    const results = out.messages.filter((m): m is ToolResultMessage => m.role === 'tool_result');
    expect(results.map((r) => r.toolCallId)).toEqual(['c1', 'c2', 'c3']);   // 声明序
    expect(results.map((r) => r.isError)).toEqual([false, true, false]);
    expect(results[1]?.content).toEqual([{ type: 'text', text: INTERRUPTED_RESULT_TEXT }]);
    assertToolCallPairing(toWireShape(out.messages));
  });

  it('dangling result 丢弃:无归属块的 ghost 与块声明集外的 id 一律不出站', () => {
    // 转录事实层不自产 dangling,但 transformContext 钩子可能产出;本层是出站合法性最后一道
    const ghost = convertContext(
      ctxOf([user('hi'), result('ghost'), assistant([{ type: 'text', text: 'ok' }], { stopReason: 'stop' })]),
      MODEL_A,
    );
    expect(ghost.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    assertToolCallPairing(toWireShape(ghost.messages));

    const outside = convertContext(
      ctxOf([
        user('hi'),
        assistant([{ type: 'tool_call', id: 'c1', name: 'read', arguments: {} }]),
        result('zz'),      // 当前块声明集外
        result('c1'),
      ]),
      MODEL_A,
    );
    expect(outside.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_result']);
    expect((outside.messages[2] as ToolResultMessage).toolCallId).toBe('c1');
    assertToolCallPairing(toWireShape(outside.messages));
  });

  it('同一超长 id 同现于跨模型与同模型块:同模型块两侧保持原 id,跨模型块两侧一致归一化', () => {
    const longId = 'call_' + 'z'.repeat(60);
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([{ type: 'tool_call', id: longId, name: 'read', arguments: {} }], { model: MODEL_B }),
      result(longId),
      assistant([{ type: 'tool_call', id: longId, name: 'read', arguments: {} }], { id: 'a2' }),
      result(longId, { id: 'tr2' }),
    ];
    const out = convertContext(ctxOf(messages), MODEL_A);   // MODEL_B 块跨模型,MODEL_A 块同模型
    const crossCall = (out.messages[1] as AssistantMessage).content[0];
    const crossRes = out.messages[2] as ToolResultMessage;
    expect(crossCall?.type === 'tool_call' && crossCall.id.length).toBeLessThanOrEqual(40);
    expect(crossCall?.type === 'tool_call' && crossCall.id).toBe(crossRes.toolCallId);
    expect(crossRes.toolCallId).not.toBe(longId);
    // 同模型块:call 与 result 都不被 idMap 波及(id 归一化仅施加于跨模型块)
    const sameCall = (out.messages[3] as AssistantMessage).content[0];
    const sameRes = out.messages[4] as ToolResultMessage;
    expect(sameCall?.type === 'tool_call' && sameCall.id).toBe(longId);
    expect(sameRes.toolCallId).toBe(longId);
    assertToolCallPairing(toWireShape(out.messages));
  });
});

describe('convertContext:纯函数性质', () => {
  it('绝不改写输入消息(深度对比修复前后原数组)', () => {
    const messages: AgentMessage[] = [
      user('hi'),
      assistant([
        { type: 'tool_call', id: 'c_' + 'y'.repeat(60), name: 'read', arguments: {} },
        { type: 'reasoning', text: 'r', signature: 's' },
      ], { stopReason: 'aborted' }),
      assistant([{ type: 'tool_call', id: 'c2', name: 'bash', arguments: {} }], { id: 'a2' }),
    ];
    const snapshot = structuredClone(messages);
    convertContext(ctxOf(messages), MODEL_B, { supportsImages: false });
    expect(messages).toEqual(snapshot);
  });

  it('isSameModel:三元组逐字段比较', () => {
    expect(isSameModel(MODEL_A, { ...MODEL_A })).toBe(true);
    expect(isSameModel(MODEL_A, { ...MODEL_A, model: 'z' })).toBe(false);
    expect(isSameModel(MODEL_A, { ...MODEL_A, provider: 'z' })).toBe(false);
    expect(isSameModel(MODEL_A, { ...MODEL_A, api: 'z' })).toBe(false);
  });
});
