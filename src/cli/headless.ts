// Headless JSON 模式(规格见 docs/09-cli.md §6):stdin 一行一条命令,stdout 一行一条
// SessionEvent(NDJSON,原样外发、不包裹信封)。stdout 纪律:除 NDJSON 外零输出,
// 日志一律走 stderr。生命周期(§6.4):EOF 视同 shutdown;SIGINT/SIGTERM 同 shutdown;
// shutdown 运行中先 abort → waitForIdle → flush 落盘 → exit 0;致命错误输出
// {type:'error',fatal:true} 后 exit 1。一次性特例(§6.4):initialPrompt(--json -p)
// 启动即注入一条 prompt,对应 agent_end 后自动 shutdown——reason 'error' → exit 1。

import { createInterface } from 'node:readline';
import process from 'node:process';
import type { ApprovalDecision } from '../agent/index.js';
import type { Session, SessionEvent } from '../session/index.js';
import { PROTOCOL_VERSION } from '../session/index.js';

/** stdin 命令(docs/09 §6.2/§6.5):命名对齐内部协议,snake_case 贯穿 wire 面。 */
export type CliCommand =
  | { type: 'prompt'; text: string }     // 空闲时开新任务;运行中返回 error 事件(non-fatal)
  | { type: 'steer'; text: string }      // 入 steering 队列(随时)
  | { type: 'follow_up'; text: string }  // 入 follow-up 队列(随时)
  | { type: 'abort' }                    // agent.abort();idle 时 no-op
  | { type: 'shutdown' }
  // M6 审批应答(docs/09 §6.5,codex 把审批应答也做成 Op 的同构):--approval-mode
  // interactive 时经 broker.resolve 决议;其他模式返回 non-fatal error。
  | { type: 'approval'; approvalId: string; decision: ApprovalDecision };

/**
 * 审批接线(main.ts 装配后传入;docs/07 §3.1):broker 的 approval_request 不经 agent
 * Emitter,经 subscribe 的旁路通道汇入同一条 NDJSON 流。
 */
export interface HeadlessApproval {
  /** interactive 才有(deny 模式不建 broker):approval 命令的决议入口。 */
  broker?: { resolve: (approvalId: string, decision: ApprovalDecision) => void };
  /** abort 收尾;调用纪律(R7):必须在 session.abort() 之后。 */
  onAbort: () => void;
  /** approval_request 旁路事件订阅;返回退订函数。 */
  subscribe: (listener: (e: SessionEvent) => void) => () => void;
}

export async function startHeadless(
  session: Session,
  opts: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    /** --json -p 组合(docs/09 §6.4 一次性特例):启动注入 prompt,agent_end 后自动 shutdown。 */
    initialPrompt?: string;
    /** M6 审批接线(--approval-mode 非 allow 时由 main.ts 传入)。 */
    approval?: HeadlessApproval;
  },
): Promise<number> {
  const writeLine = (obj: unknown): void => {
    opts.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  let settled = false;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code: number): void => {
    if (!settled) {
      settled = true;
      resolveExit(code);
    }
  };

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown || settled) return;
    shuttingDown = true;
    try {
      session.abort();              // 运行中先硬中断(idle 时 no-op)
      // R7 时序:任务观察到 cancellation 之后才决议 pending 审批——顺序反了,悬着的
      // 审批会以「拒绝」形态先漏给模型。不清 pending 则 waitForIdle 永远挂死。
      opts.approval?.onAbort();
      await session.close();        // waitForIdle → flush 落盘,之后进程可安全退出
      finish(code);
    } catch (err) {
      writeLine({ type: 'error', fatal: true, message: `shutdown failed: ${String(err)}` });
      finish(1);
    }
  };

  const oneShot = opts.initialPrompt !== undefined;

  // 启动首行:协议版本旁路事件(docs/09 §6.3;版本号取自 session 层 PROTOCOL_VERSION)
  writeLine({ type: 'protocol', protocolVersion: PROTOCOL_VERSION });
  // SessionEvent 原样外发:不加任何自定义字段,事件类型本身自带判别
  const unsubscribe = session.subscribe((e: SessionEvent) => {
    writeLine(e);
    // 致命错误(docs/09 §6.4「致命错误 → exit 1」):事件照常外发后走 shutdown 路径
    // (abort + close 落盘)并以 1 退出;不能只写事件不退——headless 管道对端无人善后。
    if (e.type === 'error' && e.fatal) {
      void shutdown(1);
      return;
    }
    // 一次性特例:注入 prompt 对应的 agent_end 后自动 shutdown;reason 'error' → exit 1
    // (脚本可感知),其余(completed/aborted)按 §6.4 正常 shutdown 语义 exit 0。
    if (oneShot && e.type === 'agent_end') {
      void shutdown(e.reason === 'error' ? 1 : 0);
    }
  });
  // 审批旁路通道:approval_request 与主事件流汇入同一条 NDJSON(docs/07 §3.1)。
  // 同步直写:broker emit 发生在 beforeToolCall 内,彼时 loop 已 await 完先行事件,顺序正确。
  const unsubApproval = opts.approval?.subscribe((e: SessionEvent) => {
    writeLine(e);
  });

  const dispatch = (cmd: CliCommand): void => {
    switch (cmd.type) {
      case 'prompt': {
        // running 时不 throw 到进程:输出 non-fatal error 事件(docs/09 §6.2 映射表)
        if (session.agent.state === 'running') {
          writeLine({ type: 'error', fatal: false, message: 'agent is running; use steer or follow_up' });
          return;
        }
        session.prompt(cmd.text).catch((err: unknown) => {
          // StreamFn 铁律下 run 不应 reject;真发生即致命(docs/09 §6.4)
          writeLine({ type: 'error', fatal: true, message: `prompt failed: ${String(err)}` });
          finish(1);
        });
        return;
      }
      case 'steer':
        session.steer(cmd.text);
        return;
      case 'follow_up':
        session.followUp(cmd.text);
        return;
      case 'abort':
        // R7 时序:session.abort() 在前(任务观察到 cancellation),pending 审批才以
        // 'abort' 决议——审批中被 abort 的工具结果必须是中断形态,绝非「拒绝」形态。
        session.abort();
        opts.approval?.onAbort();
        return;
      case 'approval': {
        const broker = opts.approval?.broker;
        if (broker === undefined) {
          // 非 interactive 模式没有 broker:容错回报,不退出(docs/09 §6.3 容错纪律)
          writeLine({
            type: 'error',
            fatal: false,
            message: 'approval not available: run with --approval-mode interactive',
          });
          return;
        }
        // decision 'abort' 同样走 resolve:policy 内部先 requestAbort() 再以中断形态回喂(R7)
        broker.resolve(cmd.approvalId, cmd.decision);
        return;
      }
      case 'shutdown':
        void shutdown();
        return;
    }
  };

  const onLine = (line: string): void => {
    if (settled || shuttingDown) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let cmd: CliCommand;
    try {
      cmd = parseCommand(trimmed);
    } catch (err) {
      // 无法解析的行:non-fatal error,继续读下一行(容错,不退出)
      writeLine({
        type: 'error',
        fatal: false,
        message: `invalid command: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    try {
      dispatch(cmd);
    } catch (err) {
      writeLine({ type: 'error', fatal: true, message: err instanceof Error ? err.message : String(err) });
      finish(1);
    }
  };

  const onSignal = (): void => {
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const rl = createInterface({ input: opts.stdin, terminal: false });
  rl.on('line', onLine);
  rl.on('close', () => {
    void shutdown(); // stdin EOF 视同 shutdown
  });
  opts.stdin.on('error', () => {
    void shutdown();
  });

  // 一次性特例:启动即注入 prompt(复用 dispatch 的 prompt-rejection 致命处理);
  // stdin 命令流仍然可用(steer/follow_up/abort 在 run 期间照常合法)。
  if (opts.initialPrompt !== undefined) {
    dispatch({ type: 'prompt', text: opts.initialPrompt });
  }

  const code = await exit;
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  unsubscribe();
  unsubApproval?.();
  rl.close();
  releaseStdin(opts.stdin);
  return code;
}

/** 解析并校验一行命令;不合法时 throw(调用方转为 non-fatal error 事件)。 */
function parseCommand(line: string): CliCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`not valid JSON: ${truncate(line)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object: ${truncate(line)}`);
  }
  const cmd = parsed as { type?: unknown; text?: unknown; approvalId?: unknown; decision?: unknown };
  switch (cmd.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
      if (typeof cmd.text !== 'string') {
        throw new Error(`"${cmd.type}" requires a string "text" field`);
      }
      return { type: cmd.type, text: cmd.text };
    case 'abort':
    case 'shutdown':
      return { type: cmd.type };
    case 'approval': {
      if (typeof cmd.approvalId !== 'string') {
        throw new Error('"approval" requires a string "approvalId" field');
      }
      const d = cmd.decision;
      if (d !== 'allow_once' && d !== 'allow_always' && d !== 'deny' && d !== 'abort') {
        throw new Error('"approval" requires decision allow_once|allow_always|deny|abort');
      }
      return { type: 'approval', approvalId: cmd.approvalId, decision: d };
    }
    default:
      throw new Error(`unknown command type: ${truncate(String(cmd.type))}`);
  }
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 释放 stdin 句柄,让事件循环得以清空、进程自然退出:
 * process.stdin(Socket/TTY)有 unref;测试注入的 PassThrough 走 destroy。
 */
function releaseStdin(stdin: NodeJS.ReadableStream): void {
  const s = stdin as NodeJS.ReadableStream & { unref?: () => void; destroy?: () => void };
  if (typeof s.unref === 'function') s.unref();
  else if (typeof s.destroy === 'function') s.destroy();
}
