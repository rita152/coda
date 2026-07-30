#!/usr/bin/env bun
// CLI 入口(规格见 docs/09-cli.md §2):flag 解析 → 配置解析 → Session 组装 → 分派
// headless / 一次性 / 全屏 TUI（必要时降级 classic REPL）。CLI 是最薄的一层:
// 把输入翻译成 Agent 方法调用,
// 把事件翻译成像素;不持有会话状态副本。

import packageJson from '../../package.json';
import type { ModelConfig } from '../protocol/index.js';
import { ApprovalBroker } from '../agent/index.js';
import type { AgentConfig } from '../agent/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { createCodingTools } from '../tools/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import type { SessionEvent, SessionOptions } from '../session/index.js';
import { Session } from '../session/index.js';
import { createStdoutOutput } from '../shared/index.js';
import { createApprovalPolicy } from './approval-policy.js';
import { cleanupTruncated } from './cleanup.js';
import {
  getMissingApiKeyMessage,
  isFullScreenTuiEligible,
  parseFlags,
  readConfigFile,
  resolveConfig,
} from './config.js';
import type { CliFlags } from './config.js';
import { startHeadless } from './headless.js';
import { InteractiveRuntime } from './interactive-runtime.js';
import type { CliSession } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import { createProviderStreamFn } from './provider-stream.js';
import { guardProjectRuleExecutions, ProjectRules } from './project-rules.js';
import { createRenderer } from './renderer.js';
import { startRepl } from './repl.js';
import { pickSessionInteractive } from './resume-picker.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

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

  const interactiveMode =
    !flags.json &&
    flags.prompt === undefined &&
    process.stdin.isTTY === true;
  const tuiEligible = isFullScreenTuiEligible(flags, {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    term: Bun.env.TERM,
  });

  let resolved;
  let registry: ProviderRegistry | undefined;
  try {
    resolved = resolveConfig(flags, Bun.env, readConfigFile(), {
      allowMissingApiKey: interactiveMode,
    });
    if (interactiveMode || resolved.modelConfig === undefined) {
      registry = new ProviderRegistry();
    }
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const legacyMissingKey = getMissingApiKeyMessage(resolved);
  let initialModel: ModelConfig | undefined;
  if (resolved.modelConfig !== undefined) {
    // 旧式显式 model 配置若缺 key，交互面退回未选择状态；绝不拿占位配置创建 Session。
    initialModel =
      legacyMissingKey === undefined ? resolved.modelConfig : undefined;
  } else {
    initialModel = registry?.resolveSelectedModel();
  }
  if (initialModel === undefined && !interactiveMode) {
    console.error(
      `[coda] ${
        legacyMissingKey ??
        '尚未选择模型；请先在交互终端运行 /login 配置 API key，再运行 /model'
      }`,
    );
    return 2;
  }

  const requestedCwd = flags.cwd ?? process.cwd();
  const projectRules = new ProjectRules({ cwd: requestedCwd });
  // 工具与规则分析共用物理 cwd；否则 symlink cwd 下的相对 workdir 会产生两套路径语义。
  const cwd = projectRules.cwd;
  let fauxScript: FauxScript | undefined;
  try {
    fauxScript =
      resolved.provider === 'faux'
        ? await readFauxScript(resolved.fauxScript)
        : undefined;
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const streamFn = createProviderStreamFn(fauxScript);
  const tools = guardProjectRuleExecutions(createCodingTools(), projectRules);

  // 审批模式默认(docs/09 §6.5 修订):交互 TUI/classic → interactive;headless(--json)与 -p
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
  const sessionRef: { current?: { abort(): void } } = {};
  const approvalListeners = new Set<(e: SessionEvent) => void>();
  let approvalBeforeToolCall: AgentConfig['beforeToolCall'];
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
    approvalBeforeToolCall = policy.beforeToolCall;
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
    approvalBeforeToolCall = createDenyHook(tools);
  }
  // 项目规则 gate 先于审批：若新作用域尚未进入模型上下文，先让模型在下一 turn
  // 看到规则再重试，避免为本轮注定不执行的调用弹审批。
  const beforeToolCall: NonNullable<AgentConfig['beforeToolCall']> = async (call) => {
    const rulesDecision = await projectRules.beforeToolCall(call);
    if (rulesDecision.block) return rulesDecision;
    return approvalBeforeToolCall?.(call) ?? {};
  };

  // 恢复目标可在没有模型时先选定，但真正 load/create 必须等到已有有效 ModelConfig。
  let resumeId: string | undefined;
  if (flags.continue_ || flags.resume !== undefined) {
    resumeId = await resolveSessionId(flags, flags.sessionDir);
    if (resumeId === undefined) {
      console.error('[coda] no session to resume');
      return 2;
    }
  }
  const resumed = resumeId !== undefined;
  const sessionOptions = (model: ModelConfig): SessionOptions => ({
    agentConfig: {
      streamFn,
      model,
      tools,
      cwd,
      systemPrompt: () => buildSystemPrompt(cwd),
      transformContext: (ctx) => projectRules.inject(ctx),
      beforeToolCall,
    },
    ...(flags.sessionDir !== undefined && { dir: flags.sessionDir }),
  });
  const createSession = (model: ModelConfig): Promise<Session> =>
    resumeId === undefined
      ? Session.create(sessionOptions(model))
      : Session.resume(resumeId, sessionOptions(model));

  let interactiveRuntime: InteractiveRuntime | undefined;
  let concreteSession: Session | undefined;
  let session: CliSession;
  try {
    if (interactiveMode) {
      interactiveRuntime = new InteractiveRuntime({
        ...(initialModel !== undefined && { initialModel }),
        createSession,
      });
      await interactiveRuntime.initialize();
      session = interactiveRuntime;
    } else {
      concreteSession = await createSession(initialModel as ModelConfig);
      session = concreteSession;
    }
  } catch (err) {
    console.error(`[coda] session initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  sessionRef.current = session;

  // 默认交互面:双 TTY 且终端具备全屏能力时懒加载 OpenTUI。这里必须早于 stdout
  // FileSink/legacy renderer 的创建——两套渲染器不能同时拥有 raw stdin/stdout。
  // 初始化失败时 createCliRenderer 会恢复终端，随后可安全降级 classic REPL；
  // 已进入运行期的错误由 startTui 自己收尾并返回 exit code，不从中途切换 UI。
  if (tuiEligible) {
    try {
      const { startTui } = await import('./tui.js');
      return await startTui(session, approval, {
        cwd,
        projectRuleWarnings: projectRules,
        ...(session.currentModel() !== undefined && {
          model: session.currentModel(),
        }),
        version: packageJson.version,
        color: !flags.noColor && Bun.env.NO_COLOR === undefined,
        ...(initialModel?.limits?.context !== undefined && {
          contextLimit: initialModel.limits.context,
        }),
        resumed,
        ...(interactiveRuntime !== undefined && registry !== undefined && {
          providerCommands: {
            registry,
            runtime: interactiveRuntime,
          },
        }),
      });
    } catch (err) {
      console.error(
        `[coda] full-screen TUI unavailable, using classic mode: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
    projectRules.subscribeWarnings((message) => {
      console.error(`[coda] warning: project rules · ${sanitizeTerminalLine(message)}`);
    });
    // --json 与 -p 组合(docs/09 §6.4 一次性特例):启动注入 prompt,最终 agent_end 后自动退出
    return startHeadless(concreteSession as Session, {
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
  if (flags.prompt === undefined && process.stdout.isTTY === true) {
    projectRules.subscribeWarnings((message) => {
      renderer.println?.(`⚠ project rules · ${sanitizeTerminalLine(message)}`);
    });
  } else {
    projectRules.subscribeWarnings((message) => {
      console.error(`[coda] warning: project rules · ${sanitizeTerminalLine(message)}`);
    });
  }
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
  if (resumed && session.messages.length > 0) {
    renderer.replayTranscript(session.messages);
    await renderer.drain();
  }

  if (flags.prompt !== undefined) {
    // -p 一次性模式:与 headless 共享 one-shot 收尾语义，但使用人类可读输出。退出码同 --json 特例规则
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
    ...(interactiveRuntime !== undefined && registry !== undefined && {
      providerCommands: {
        registry,
        runtime: interactiveRuntime,
      },
    }),
  });
  if (!output.failureSignal.aborted) await renderer.drain();
  return exitCode;
}

async function readFauxScript(path: string | undefined): Promise<FauxScript> {
  const script: FauxScript =
    path === undefined
      ? { turns: [], onExhausted: 'emptyStop' }
      : ((await Bun.file(path).json()) as FauxScript);
  script.onExhausted = script.onExhausted ?? 'emptyStop';
  return script;
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
