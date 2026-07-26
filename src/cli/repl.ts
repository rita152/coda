// 交互 REPL(规格见 docs/09-cli.md §3):readline raw keypress + escapeCodeTimeout 50ms。
// 分工:repl 管键位与输入行状态,渲染(输入行/状态提示/转录)全部经 Renderer——
// stdout 单写入者纪律(docs/09 §1.3)。可测部分(历史环、斜杠命令、双击消歧、Enter 分派)
// 拆为纯函数/纯类导出,由 repl.test.ts 覆盖;键位接线本身依赖真实 TTY,无法全自动测试。
//
// 人工冒烟清单(docs/09 §9 前四条,发布前真实终端过一遍):
// [ ] 流式输出期间打字,输入行内容不被 delta 冲花;Enter 后徽标出现 steer 1,
//     转录区在下个 turn 边界出现 » steering: 回显
// [ ] Esc 在 50ms 消歧下:方向键不触发 abort;流式中裸 Esc 一次即 abort,
//     assistant 消息以 [aborted] 收尾
// [ ] Alt+Enter 与 /f 前缀均能入 follow-up 队列(至少各在一种终端验证)
// [ ] coda --continue 重放转录后,新输入接在原上下文继续

import * as readline from 'node:readline';
import process from 'node:process';
import type { AgentMessage, QueuedMessage } from '../protocol/index.js';
import type { Session, SessionUsage } from '../session/index.js';
import type { Renderer } from './renderer.js';

export const ESC_TIMEOUT_MS = 50; // Esc 消歧窗口(docs/09 §3.2)
export const ESC_EXIT_WINDOW_MS = 500; // 双 Esc 退出窗口
export const CTRL_C_EXIT_WINDOW_MS = 1500; // 双 Ctrl+C 退出窗口

// ---- 纯逻辑:斜杠命令 ----

export type SlashCommand =
  | { cmd: 'quit' | 'queue' | 'status' | 'help' }
  | { cmd: 'follow_up'; text: string }
  | { cmd: 'unknown'; input: string };

/** 非斜杠输入返回 undefined。空闲命令表:/quit /queue /status /help;/f|/followup 随时合法。 */
export function parseSlashCommand(text: string): SlashCommand | undefined {
  if (!text.startsWith('/')) return undefined;
  const space = text.indexOf(' ');
  const head = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  switch (head) {
    case '/quit':
    case '/q':
      return { cmd: 'quit' };
    case '/queue':
      return { cmd: 'queue' };
    case '/status':
      return { cmd: 'status' };
    case '/help':
      return { cmd: 'help' };
    case '/f':
    case '/followup':
      return { cmd: 'follow_up', text: rest };
    default:
      return { cmd: 'unknown', input: text };
  }
}

// ---- 纯逻辑:Enter 分派(docs/09 §3 键位表的可测内核)----

export type EnterAction =
  | { kind: 'none' }
  | { kind: 'prompt'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'follow_up'; text: string }
  | { kind: 'command'; command: SlashCommand };

/**
 * 空闲 Enter=prompt、运行中 Enter=steer、Alt+Enter=followUp;
 * 流式中 /f <text> 兜底 follow-up(docs/09 §3.2),其余斜杠命令仅空闲时生效——
 * 运行中输入 /status 等按普通文本 steer(键位表没有含糊地带)。
 */
export function decideEnter(state: 'idle' | 'running', meta: boolean, raw: string): EnterAction {
  const text = raw.trim();
  if (text === '') return { kind: 'none' };
  if (meta) return { kind: 'follow_up', text };
  const slash = parseSlashCommand(text);
  if (slash !== undefined && slash.cmd === 'follow_up') {
    return slash.text === '' ? { kind: 'none' } : { kind: 'follow_up', text: slash.text };
  }
  if (state === 'running') return { kind: 'steer', text };
  if (slash !== undefined) return { kind: 'command', command: slash };
  return { kind: 'prompt', text };
}

// ---- 纯逻辑:本会话输入历史(↑/↓)----

export class InputHistory {
  #items: string[] = [];
  #index = 0; // === items.length 表示「草稿位」
  #draft = '';

  push(text: string): void {
    if (text.trim() === '') return;
    if (this.#items[this.#items.length - 1] !== text) this.#items.push(text);
    this.#index = this.#items.length;
    this.#draft = '';
  }

  /** ↑:首次上翻保存当前草稿;到顶后停在最旧一条。 */
  up(current: string): string {
    if (this.#items.length === 0) return current;
    if (this.#index === this.#items.length) this.#draft = current;
    if (this.#index > 0) this.#index--;
    return this.#items[this.#index] ?? current;
  }

  /** ↓:翻回草稿位时还原草稿。 */
  down(): string {
    if (this.#index < this.#items.length) this.#index++;
    if (this.#index === this.#items.length) return this.#draft;
    return this.#items[this.#index] ?? this.#draft;
  }
}

// ---- 纯逻辑:双击消歧(Esc Esc / Ctrl+C Ctrl+C,时钟注入可测)----

export class DoublePress {
  #last = Number.NEGATIVE_INFINITY;
  constructor(private readonly windowMs: number) {}

  /** 返回 true 表示窗口内第二击(触发后归零,三连击不会连发)。 */
  hit(now: number): boolean {
    const isDouble = now - this.#last <= this.windowMs;
    this.#last = isDouble ? Number.NEGATIVE_INFINITY : now;
    return isDouble;
  }

  reset(): void {
    this.#last = Number.NEGATIVE_INFINITY;
  }
}

// ---- 纯逻辑:/status /queue 的输出格式 ----

export function formatStatusLines(usage: SessionUsage, model?: string): string[] {
  const c = usage.cumulative;
  const lines: string[] = [];
  if (model !== undefined) lines.push(`model: ${model}`);
  lines.push(`turns: ${usage.turns}`);
  let tok = `tokens: ${c.input} in / ${c.output} out`;
  if (c.reasoning !== undefined) tok += ` (${c.reasoning} reasoning)`;
  if (c.cacheRead !== undefined) tok += ` (${c.cacheRead} cache read)`;
  lines.push(tok);
  if (c.costUSD !== undefined) lines.push(`cost: $${c.costUSD.toFixed(4)}`);
  if (usage.lastTurn !== undefined) {
    lines.push(`last turn: ${usage.lastTurn.input} in / ${usage.lastTurn.output} out`);
  }
  return lines;
}

export function formatQueueLines(
  steering: readonly QueuedMessage[],
  followUp: readonly QueuedMessage[],
): string[] {
  if (steering.length === 0 && followUp.length === 0) return ['queues empty'];
  const lines: string[] = [];
  const block = (label: string, items: readonly QueuedMessage[]): void => {
    if (items.length === 0) return;
    lines.push(`${label} (${items.length}):`);
    items.forEach((m, i) => {
      const text = m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text;
      lines.push(`  ${i + 1}. ${text}`);
    });
  };
  block('steering', steering);
  block('follow-up', followUp);
  return lines;
}

const HELP_LINES = [
  'Enter: send (idle) / steer (running)   Alt+Enter or /f <text>: follow-up',
  'Esc: abort (running)   Esc Esc / Ctrl+C Ctrl+C: quit   Ctrl+D: quit (empty input)',
  '/quit  /queue  /status  /help',
];

function lastModelName(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === 'assistant') return m.model.model;
  }
  return undefined;
}

// ---- REPL 主体 ----

export async function startRepl(session: Session, renderer: Renderer): Promise<number> {
  const stdin = process.stdin;
  let input = '';
  let cursor = 0;
  const history = new InputHistory();
  const escExit = new DoublePress(ESC_EXIT_WINDOW_MS);
  const ctrlCExit = new DoublePress(CTRL_C_EXIT_WINDOW_MS);
  let lastQueues: { steering: QueuedMessage[]; followUp: QueuedMessage[] } = {
    steering: [],
    followUp: [],
  };
  let pasting = false;
  let statusShown = false;
  let closing = false;

  return await new Promise<number>((resolve) => {
    const setInput = (text: string, cur = text.length): void => {
      input = text;
      cursor = cur;
      renderer.setInputLine?.(input);
    };

    const setStatusHint = (text: string): void => {
      statusShown = true;
      renderer.setStatus?.(text);
    };
    const clearStatusHint = (): void => {
      if (!statusShown) return;
      statusShown = false;
      renderer.setStatus?.(undefined);
    };

    const running = (): boolean => session.agent.state === 'running';

    const unsub = session.subscribe((e) => {
      if (e.type === 'queue_update') {
        lastQueues = { steering: [...e.steering], followUp: [...e.followUp] };
      } else if (e.type === 'error' && e.fatal) {
        void shutdown(1); // 致命错误进入退出流程(docs/09 §4)
      }
    });

    const onResize = (): void => {
      renderer.redraw?.();
    };
    const onSignal = (): void => {
      void shutdown(0);
    };

    const cleanup = (): void => {
      stdin.removeListener('keypress', onKeypress);
      process.removeListener('SIGWINCH', onResize);
      process.removeListener('SIGTERM', onSignal);
      unsub();
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      renderer.unmount?.();
    };

    /** 退出前:流式中先 abort,session.close() = waitForIdle + flush 落盘(docs/09 §3)。 */
    const shutdown = async (code: number): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        if (running()) session.abort();
        await session.close();
      } finally {
        cleanup();
        resolve(code);
      }
    };

    const printErr = (err: unknown): void => {
      renderer.println?.(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    const runPrompt = (text: string): void => {
      try {
        session.prompt(text).catch(printErr);
      } catch (err) {
        printErr(err); // state 竞争兜底:running 时 prompt 同步 throw,被键位表吸收
      }
    };

    const runCommand = (c: SlashCommand): void => {
      switch (c.cmd) {
        case 'quit':
          void shutdown(0);
          break;
        case 'help':
          for (const l of HELP_LINES) renderer.println?.(l);
          break;
        case 'status':
          for (const l of formatStatusLines(session.usage(), lastModelName(session.messages))) {
            renderer.println?.(l);
          }
          break;
        case 'queue':
          for (const l of formatQueueLines(lastQueues.steering, lastQueues.followUp)) {
            renderer.println?.(l);
          }
          break;
        case 'follow_up':
          if (c.text !== '') session.followUp(c.text);
          break;
        case 'unknown':
          renderer.println?.(`unknown command: ${c.input} (try /help)`);
          break;
      }
    };

    const submit = (meta: boolean): void => {
      const action = decideEnter(running() ? 'running' : 'idle', meta, input);
      if (action.kind === 'none') {
        setInput('');
        return;
      }
      history.push(input);
      switch (action.kind) {
        case 'prompt':
          runPrompt(action.text);
          break;
        case 'steer':
          session.steer(action.text);
          break;
        case 'follow_up':
          session.followUp(action.text);
          break;
        case 'command':
          runCommand(action.command);
          break;
      }
      setInput('');
    };

    const insert = (s: string): void => {
      input = input.slice(0, cursor) + s + input.slice(cursor);
      cursor += s.length;
      renderer.setInputLine?.(input);
    };

    const onKeypress = (str: string | undefined, key: readline.Key | undefined): void => {
      if (closing) return;
      const k = key ?? {};
      const name = k.name ?? '';

      // bracketed paste:粘贴换行不触发发送(docs/09 §8;Node 20+ keypress 解码
      // paste-start/paste-end,不支持的终端退化为逐行——已知限制)
      if (name === 'paste-start') {
        pasting = true;
        return;
      }
      if (name === 'paste-end') {
        pasting = false;
        renderer.setInputLine?.(input);
        return;
      }
      if (pasting) {
        if (str !== undefined && str !== '') insert(str);
        else if (name === 'return' || name === 'enter') insert('\n');
        return;
      }

      // 双击窗口:被其他按键打断即失效
      if (name !== 'escape') escExit.reset();
      if (!(k.ctrl === true && name === 'c')) ctrlCExit.reset();
      clearStatusHint();

      if (k.ctrl === true && name === 'c') {
        if (input !== '') {
          setInput(''); // 输入非空:清空输入行(docs/09 §3)
          ctrlCExit.reset();
          return;
        }
        if (ctrlCExit.hit(Date.now())) {
          void shutdown(0);
          return;
        }
        setStatusHint('press Ctrl+C again to exit');
        return;
      }
      if (k.ctrl === true && name === 'd') {
        if (input === '' && !running()) void shutdown(0);
        return;
      }
      if (name === 'escape') {
        if (escExit.hit(Date.now())) {
          void shutdown(0);
          return;
        }
        if (running()) session.abort(); // Esc 不消费输入框文本(docs/09 §3.1)
        return;
      }
      if (name === 'return' || name === 'enter') {
        submit(k.meta === true); // Alt+Enter → key.meta && name==='return'(docs/09 §3.2)
        return;
      }
      if (name === 'up') {
        setInput(history.up(input));
        return;
      }
      if (name === 'down') {
        setInput(history.down());
        return;
      }
      if (name === 'left') {
        if (cursor > 0) cursor--;
        return;
      }
      if (name === 'right') {
        if (cursor < input.length) cursor++;
        return;
      }
      if (name === 'home' || (k.ctrl === true && name === 'a')) {
        cursor = 0;
        return;
      }
      if (name === 'end' || (k.ctrl === true && name === 'e')) {
        cursor = input.length;
        return;
      }
      if (name === 'backspace') {
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor);
          cursor--;
          renderer.setInputLine?.(input);
        }
        return;
      }
      if (name === 'delete') {
        if (cursor < input.length) {
          input = input.slice(0, cursor) + input.slice(cursor + 1);
          renderer.setInputLine?.(input);
        }
        return;
      }
      if (k.ctrl === true && name === 'u') {
        setInput('');
        return;
      }
      if (k.ctrl === true || k.meta === true) return; // 其余控制组合忽略
      if (str !== undefined && str !== '') {
        // 剥控制字符,\t 保留在数据层(提交的文本含真实 tab);显示层由 renderer 的
        // sanitizeDynText 统一清洗(\t → 2 空格、\r 剥除),动态区行宽数学不受影响。
        // 非 paste 路径的裸换行不入输入行。
        const clean = str.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '');
        if (clean !== '') insert(clean);
      }
    };

    // 接线:emitKeypressEvents 第二参仅取 escapeCodeTimeout(50ms 消歧,docs/09 §3.2)
    readline.emitKeypressEvents(
      stdin,
      { escapeCodeTimeout: ESC_TIMEOUT_MS } as unknown as readline.Interface,
    );
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKeypress);
    process.on('SIGWINCH', onResize);
    process.once('SIGTERM', onSignal);

    renderer.mount?.();
    renderer.setInputLine?.('');
  });
}
