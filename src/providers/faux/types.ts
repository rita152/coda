// faux provider 的脚本类型(宿主规格:docs/10-testing.md 第 3 节)。
// faux 不是测试夹具堆,而是正式 provider:实现 StreamFn、遵守全部协议不变量,
// e2e 也用它(CLI --provider faux)。它同时是内部协议的可执行规格。

import type {
  Context,
  ModelConfig,
  ProviderErrorDetails,
  StopReason,
  StreamOptions,
  Usage,
} from '../../protocol/index.js';

/** 受控注入点:把「时序巧合」变成「显式放行」,本方案唯一的同步原语。 */
export interface Gate {
  open(): void;
  readonly opened: Promise<void>;
}

export function createGate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

export type FauxEventSpec =
  | { kind: 'text'; text: string; chunkSize?: number }        // 按 chunkSize 拆成多个 text_delta,默认 8
  | { kind: 'reasoning'; text: string; chunkSize?: number }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown>; id?: string;
      truncatedRaw?: string }                                  // 配合 stopReason:'length' 模拟截断参数
  | { kind: 'gate'; gate: Gate };                              // 暂停发射直到测试放行(受控注入点)

export interface FauxTurn {
  events?: FauxEventSpec[];
  // 类型收窄:done 事件的 stopReason 只允许 stop/length/tool_calls/content_filter
  // (docs/03 §4.2 事件文法);error/aborted 只能经 error 字段或 abort 路径产生,
  // 否则脚本可把 faux 配置成产出非法流。缺省推断:有 tool_call → 'tool_calls',否则 'stop'。
  stopReason?: Exclude<StopReason, 'error' | 'aborted'>;
  error?: { message: string; details?: ProviderErrorDetails }; // 以 error 事件收尾(stopReason 'error')
  usage?: Partial<Usage>;     // 缺省 { input: 100, output: 10 };error turn 亦尊重显式给出的值
  onRequest?: (model: ModelConfig, context: Context, options?: StreamOptions) => void; // 出站断言钩子
}

export interface FauxScript {
  turns: FauxTurn[];
  onExhausted?: 'throw' | 'emptyStop';   // 脚本耗尽:测试默认 'throw'(多余请求即 bug),e2e 用 'emptyStop'
  /**
   * 断言层失败通道(测试仪器,规格外的可选扩展):脚本耗尽('throw' 模式)或
   * onRequest 钩子抛异常时经此上报。缺省 queueMicrotask(() => { throw err })——
   * 未捕获异常使 vitest 判当前测试失败;流本身始终以协议合法的 error 事件收尾(铁律)。
   */
  failFn?: (err: Error) => void;
}

/** createFauxStreamFn 的调用留档条目(深拷贝,signal 剥离)。 */
export interface FauxCall {
  model: ModelConfig;
  context: Context;
  options?: StreamOptions;
}
