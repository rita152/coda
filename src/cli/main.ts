#!/usr/bin/env bun
// CLI 入口(规格见 docs/09-cli.md §2):flag 解析 → 配置解析 → Session 组装 → 分派
// headless / 一次性 / 交互 REPL。CLI 是最薄的一层:把输入翻译成 Agent 方法调用,
// 把事件翻译成像素;不持有会话状态副本。

import type { StreamFn } from '../protocol/index.js';
import { ApprovalBroker } from '../agent/index.js';
import type { AgentConfig } from '../agent/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { createCodingTools } from '../tools/index.js';
import { streamOpenAIChat } from '../providers/openai-chat/index.js';
import { streamAnthropicMessages } from '../providers/anthropic-messages/index.js';
import { createFauxStreamFn } from '../providers/faux/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import type { SessionEvent, SessionOptions } from '../session/index.js';
import { Session } from '../session/index.js';
import { createStdoutOutput } from '../shared/index.js';
import { createApprovalPolicy } from './approval-policy.js';
import { cleanupTruncated } from './cleanup.js';
import { parseFlags, readConfigFile, resolveConfig } from './config.js';
import type { CliFlags } from './config.js';
import { startHeadless } from './headless.js';
import { createRenderer } from './renderer.js';
import { startRepl } from './repl.js';
import { pickSessionInteractive } from './resume-picker.js';

async function main(): Promise<number> {
  let flags: CliFlags;
  try {
    flags = parseFlags(Bun.argv.slice(2));
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // 启动清理:截断落盘的 7 天保留(docs/07 §1.6)。fire-and-forget:失败静默、不阻塞启动。
  void cleanupTruncated();

  let resolved;
  try {
    resolved = resolveConfig(flags, Bun.env, readConfigFile());
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // 非 TTY stdin 且非 --json:读完 stdin 作为一次性 prompt(docs/09 §8)。
  // 读空(coda </dev/null 且无 -p):交互 REPL 需要 TTY,进 startRepl 只会无限挂起——
  // 提示用法并 exit 2(放在 Session 创建之前,不为错误路径留下空会话文件)。
  if (!flags.json && flags.prompt === undefined && !process.stdin.isTTY) {
    const text = (await Bun.stdin.text()).trim();
    if (text.length === 0) {
      console.error('[coda] empty stdin and no prompt; usage: coda -p "..."  or  echo "..." | coda');
      return 2;
    }
    flags.prompt = text;
  }

  const cwd = flags.cwd ?? process.cwd();
  const streamFn = await makeStreamFn(resolved.provider, resolved.fauxScript);
  const tools = createCodingTools();

  // 审批模式默认(docs/09 §6.5 修订):交互 REPL → interactive;headless(--json)与 -p
  // 一次性 → allow(机器驱动场景由调用方自决信任边界)。显式 --approval-mode 覆盖一切。
  // 注意此判定在「非 TTY stdin → prompt」归一之后:echo | coda 同属机器驱动形态。
  const approvalMode =
    flags.approvalMode ?? (flags.json || flags.prompt !== undefined ? 'allow' : 'interactive');
  // -p(非 --json)没有键位面也没有 approval 命令面,interactive 审批只会挂死在等待上:
  // 显式给出该组合按配置错误 fail-fast(headless --json + interactive 是合法的,有命令面)。
  if (approvalMode === 'interactive' && flags.prompt !== undefined && !flags.json) {
    console.error('[coda] --approval-mode interactive 与 -p 一次性模式不兼容(无审批应答面);用 --json 或改用 allow/deny');
    return 2;
  }

  // 审批装配(docs/07 §3.1):allow 不挂钩子;interactive 组装 ApprovalBroker +
  // createApprovalPolicy;deny 直接静态 beforeToolCall(block edit/execute,不建 broker)。
  // broker 的 approval_request 不经 agent Emitter,由这里的 listeners 旁路通道送达
  // renderer / headless / repl;requestAbort 晚绑定 session(policy 先于 session 创建)。
  const sessionRef: { current?: Session } = {};
  const approvalListeners = new Set<(e: SessionEvent) => void>();
  let beforeToolCall: AgentConfig['beforeToolCall'];
  let approval:
    | {
        broker: ApprovalBroker;
        onAbort: () => void;
        subscribe: (l: (e: SessionEvent) => void) => () => void;
      }
    | undefined;
  if (approvalMode === 'interactive') {
    const broker = new ApprovalBroker((e) => {
      for (const l of [...approvalListeners]) l(e);
    });
    const policy = createApprovalPolicy({
      broker,
      projectRoot: cwd,
      tools,
      requestAbort: () => sessionRef.current?.abort(),
    });
    beforeToolCall = policy.beforeToolCall;
    approval = {
      broker,
      onAbort: () => {
        policy.onAbort();
      },
      subscribe: (l) => {
        approvalListeners.add(l);
        return () => {
          approvalListeners.delete(l);
        };
      },
    };
  } else if (approvalMode === 'deny') {
    beforeToolCall = createDenyHook(tools);
  }

  const sessionOptions: SessionOptions = {
    agentConfig: {
      streamFn,
      model: resolved.modelConfig,
      tools,
      cwd,
      systemPrompt: () => buildSystemPrompt(cwd),
      ...(beforeToolCall !== undefined && { beforeToolCall }),
    },
    ...(flags.sessionDir !== undefined && { dir: flags.sessionDir }),
  };

  // 会话选择:--continue 恢复最近一个;--resume [id] 指定或列表选择;否则新会话
  let session: Session;
  let resumed = false;
  if (flags.continue_ || flags.resume !== undefined) {
    const id = await resolveSessionId(flags, sessionOptions.dir);
    if (id === undefined) {
      console.error('[coda] no session to resume');
      return 2;
    }
    session = await Session.resume(id, sessionOptions);
    resumed = true;
  } else {
    session = await Session.create(sessionOptions);
  }
  sessionRef.current = session; // 审批 abort 决策的晚绑定目标(policy 的 requestAbort)

  // 输出走有序 Bun FileSink 队列；TTY 能力探测仍由 compatibility 边界的 process.stdout 提供。
  // Session listener 在每个事件后 drain，给流式输出施加背压；退出路径再做最终 drain。
  const output = createStdoutOutput();
  const stdout = {
    get columns(): number | undefined {
      return process.stdout.columns;
    },
    enqueue: output.enqueue,
    drain: output.drain,
  };

  if (flags.json) {
    // --json 与 -p 组合(docs/09 §6.4 一次性特例):启动注入 prompt,最终 agent_end 后自动退出
    return startHeadless(session, {
      stdin: process.stdin,
      stdout,
      ...(flags.prompt !== undefined && { initialPrompt: flags.prompt }),
      ...(approval !== undefined && { approval }),
    });
  }

  // interactive 由 TTY(且非一次性)决定;color 独立(NO_COLOR/--no-color 只禁 SGR 着色,
  // 不禁动态区光标控制,docs/09 §1.3)
  const renderer = createRenderer(stdout, {
    color: !flags.noColor && process.stdout.isTTY === true && Bun.env.NO_COLOR === undefined,
    interactive: process.stdout.isTTY === true && flags.prompt === undefined,
  });
  output.failureSignal.addEventListener(
    'abort',
    () => {
      console.error('[coda] stdout write failed:', output.failureSignal.reason);
      // -p 没有 REPL 生命周期接管；交互模式由 startRepl 的 fatalSignal 路径统一清理。
      if (flags.prompt !== undefined) {
        session.abort();
        approval?.onAbort();
      }
    },
    { once: true },
  );
  session.subscribe((e) => {
    renderer.render(e);
    return renderer.drain();
  });
  // 审批旁路事件同样进 renderer(approval_request 的转录留痕 + 动态区提示)
  approval?.subscribe((e) => {
    renderer.render(e);
    // ApprovalBroker 是同步边界，无法 await listener；显式消费 rejection，避免审批时
    // stdout 已失败却无人观察、任务永久悬在 broker.request()。
    renderer.drain().catch(() => {});
  });
  if (resumed) {
    renderer.replayTranscript(session.messages);
    await renderer.drain();
  }

  if (flags.prompt !== undefined) {
    // -p 一次性模式:headless 内核的特例(人类可读输出)。退出码同 --json 特例规则
    // (docs/09 §6.4):willRetry:true 是中间边界；只按最终 agent_end 决定退出码。
    let resolveFinalExit!: (code: number) => void;
    const finalExit = new Promise<number>((resolve) => {
      resolveFinalExit = resolve;
    });
    const unsub = session.subscribe((e) => {
      if (e.type === 'error' && e.fatal) {
        resolveFinalExit(1);
      } else if (e.type === 'agent_end' && e.willRetry !== true) {
        resolveFinalExit(e.reason === 'error' ? 1 : 0);
      }
    });
    try {
      await session.prompt(flags.prompt);
      const exitCode = await finalExit;
      await session.close();
      await renderer.drain();
      return exitCode;
    } finally {
      unsub();
    }
  }

  const exitCode = await startRepl(session, renderer, approval, {
    fatalSignal: output.failureSignal,
  });
  if (!output.failureSignal.aborted) await renderer.drain();
  return exitCode;
}

async function makeStreamFn(
  provider: 'openai-chat' | 'anthropic-messages' | 'faux',
  fauxScriptPath?: string,
): Promise<StreamFn> {
  if (provider === 'faux') {
    const script: FauxScript =
      fauxScriptPath !== undefined
        ? ((await Bun.file(fauxScriptPath).json()) as FauxScript)
        : { turns: [], onExhausted: 'emptyStop' };
    script.onExhausted = script.onExhausted ?? 'emptyStop';
    return createFauxStreamFn(script);
  }
  // 新增 provider = 新增 adapter 分发项(docs/04 §8:CLI 只注册 ModelRef 与 StreamFn)
  if (provider === 'anthropic-messages') return streamAnthropicMessages;
  return streamOpenAIChat;
}

/**
 * --approval-mode deny 的静态 beforeToolCall(M6 分工约定;kind 直通同 docs/07 §3.1):
 * read/search/plan 放行,edit/execute(含缺省 kind)直接 block——不建 broker、无审批事件,
 * 任务继续(deny 是引导不是终止,docs/07 §3.2)。
 */
function createDenyHook(tools: ToolDefinition[]): NonNullable<AgentConfig['beforeToolCall']> {
  const kinds = new Map(tools.map((t) => [t.name, t.kind ?? 'execute']));
  return async (call) => {
    const kind = kinds.get(call.name) ?? 'execute';
    if (kind === 'read' || kind === 'search' || kind === 'plan') return {};
    return {
      block: true,
      reason:
        `Tool "${call.name}" requires approval, but approvals are disabled ` +
        '(--approval-mode deny). Use read-only tools, or ask the user to rerun without deny mode.',
    };
  };
}

function buildSystemPrompt(cwd: string): string {
  return (
    `You are coda, a terminal coding agent. Working directory: ${cwd}\n` +
    'Use the provided tools to inspect and modify files. Read files before editing them. ' +
    'Prefer small, verifiable steps; when done, summarize what changed in one short sentence.'
  );
}

async function resolveSessionId(flags: CliFlags, dir: string | undefined): Promise<string | undefined> {
  const sessions = await Session.list(dir);
  if (flags.continue_) return sessions[0]?.id;                       // 最近一个
  if (typeof flags.resume === 'string') return flags.resume;         // 显式 id
  return pickSessionInteractive(sessions);                           // 列表选择
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('[coda] fatal:', err);
    process.exitCode = 1;
  },
);
