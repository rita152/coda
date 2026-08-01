#!/usr/bin/env bun
// CLI 入口(规格见 docs/09-cli.md §2):flag 解析 → Runtime 组合 → 前端适配 → 分派
// headless / 一次性 / 全屏 TUI（必要时降级 classic REPL）。CLI 是最薄的一层:
// 把输入翻译成 Agent 方法调用,
// 把事件翻译成像素;不持有会话状态副本。

import packageJson from '../../package.json';
import type { ModelConfig, WorkspaceId } from '../protocol/index.js';
import { createLegacySessionThreadDriverFactory } from '../integrations/legacy-session-runtime/index.js';
import { createCodingTools } from '../tools/index.js';
import type { FauxScript } from '../providers/faux/index.js';
import { createFileRuntimeStorage, createRuntime } from '../runtime/index.js';
import { createStdoutOutput, runtimeHomeDir } from '../shared/index.js';
import { defaultRulesFile } from './approval-policy.js';
import { cleanupTruncated } from './cleanup.js';
import {
  getMissingApiKeyMessage,
  isFullScreenTuiEligible,
  parseFlags,
  readConfigFile,
  resolveConfig,
} from './config.js';
import type { CliFlags } from './config.js';
import { startEnvelopeHeadless } from './envelope-headless.js';
import { startHeadless } from './headless.js';
import type { CliSession } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import { createProviderStreamFn } from './provider-stream.js';
import { guardProjectRuleExecutions, ProjectRules } from './project-rules.js';
import { createRenderer } from './renderer.js';
import type { ReplApproval } from './repl.js';
import { startRepl } from './repl.js';
import {
  createCliRuntimeModelResolver,
  createLegacyPermissionPolicy,
  resolveRuntimeStorageRoots,
} from './runtime-composition.js';
import { RuntimeFrontendSession } from './runtime-frontend.js';
import { createStaticLegacyApprovalAdapterFactory } from './legacy-approval-adapter.js';
import { isRuntimeResumeRequest, selectCliResumeTarget } from './runtime-resume.js';
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
  if (flags.eventFormat !== 'envelope' && !flags.json && flags.prompt === undefined && !process.stdin.isTTY) {
    const text = (await Bun.stdin.text()).trim();
    if (text.length === 0) {
      console.error('[coda] empty stdin and no prompt; usage: coda -p "..."  or  echo "..." | coda');
      return 2;
    }
    flags.prompt = text;
  }

  const interactiveMode =
    flags.eventFormat !== 'envelope' &&
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
  if (initialModel === undefined && !interactiveMode && flags.eventFormat !== 'envelope') {
    console.error(
      `[coda] ${
        legacyMissingKey ??
        '尚未选择模型；请先在交互终端运行 /login 配置 API key，再运行 /model'
      }`,
    );
    return 2;
  }

  // 审批模式默认(docs/09 §6.5 修订):交互 TUI/classic → interactive;headless(--json)与 -p
  // 一次性 → allow(机器驱动场景由调用方自决信任边界)。显式 --approval-mode 覆盖一切。
  // 注意此判定在「非 TTY stdin → prompt」归一之后:echo | coda 同属机器驱动形态。
  const approvalMode =
    flags.approvalMode ?? (
      flags.eventFormat === 'envelope' || flags.json || flags.prompt !== undefined
        ? 'allow'
        : 'interactive'
    );
  // -p(非 --json)没有键位面也没有 approval 命令面,interactive 审批只会挂死在等待上:
  // 显式给出该组合按配置错误 fail-fast(headless --json + interactive 是合法的,有命令面)。
  if (approvalMode === 'interactive' && flags.prompt !== undefined && !flags.json) {
    console.error('[coda] --approval-mode interactive 与 -p 一次性模式不兼容(无审批应答面);用 --json 或改用 allow/deny');
    return 2;
  }

  const roots = resolveRuntimeStorageRoots({
    homeDir: runtimeHomeDir(),
    ...(flags.sessionDir !== undefined && { legacySessionDir: flags.sessionDir }),
  });
  const storage = createFileRuntimeStorage({
    root: roots.runtimeRoot,
    legacySessionDir: roots.legacySessionDir,
    legacyApprovalFile: defaultRulesFile(),
  });
  let resumeTarget;
  try {
    if (isRuntimeResumeRequest(flags)) {
      resumeTarget = await selectCliResumeTarget(await storage.listStoredThreads(), flags);
      if (resumeTarget === undefined) {
        console.error('[coda] no session to resume');
        return 2;
      }
    }
  } catch (err) {
    console.error(`[coda] ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const resumed = resumeTarget !== undefined;
  const requestedCwd = new ProjectRules({ cwd: flags.cwd ?? process.cwd() }).cwd;
  const cwd = resumeTarget?.ownerRecordedCwd ?? requestedCwd;
  if (resumeTarget !== undefined && requestedCwd !== cwd) {
    console.error(
      `[coda] warning: resuming in recorded cwd ${JSON.stringify(cwd)} ` +
      `(requested ${JSON.stringify(requestedCwd)})`,
    );
  }
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

  const projectRuleWarnings = createWarningHub();
  const approvalAdapterFactory = createStaticLegacyApprovalAdapterFactory({
    mode: approvalMode,
    projectRoot: cwd,
    tools: createCodingTools(),
  });
  const driverFactory = createLegacySessionThreadDriverFactory({
    sessionDir: roots.legacySessionDir,
    approvalAdapterFactory,
    configure: ({ model }) => {
      // Attachment-local project rules, tools, and Agent FileTracker are never shared across
      // independently attached Runtime threads. Approval state lives in the durable bridge.
      const projectRules = new ProjectRules({ cwd, onWarning: projectRuleWarnings.emit });
      const tools = guardProjectRuleExecutions(createCodingTools(), projectRules);
      return {
        sessionOptions: {
          agentConfig: {
            streamFn: createProviderStreamFn(fauxScript),
            model,
            tools,
            cwd,
            systemPrompt: () => buildSystemPrompt(cwd),
            transformContext: (context) => projectRules.inject(context),
            beforeToolCall: (call) => projectRules.beforeToolCall(call),
          },
        },
        policyRevision: `legacy-cli-${approvalMode}-v2`,
      };
    },
  });
  const modelResolver = createCliRuntimeModelResolver(registry);
  if (initialModel !== undefined) modelResolver.register(initialModel);

  let runtime;
  try {
    runtime = await createRuntime({
      workspace: {
        cwd,
        ...(resumeTarget !== undefined
          ? { workspaceId: resumeTarget.ownerWorkspaceId }
          : flags.workspace !== undefined
            ? { workspaceId: flags.workspace as WorkspaceId }
            : {}),
      },
      storage,
      modelResolver,
      permissionPolicy: createLegacyPermissionPolicy(),
      threadDriverFactory: driverFactory,
    });
  } catch (err) {
    console.error(`[coda] runtime initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (flags.eventFormat === 'envelope') {
    projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
    const output = createStdoutOutput();
    return startEnvelopeHeadless(runtime, {
      stdin: process.stdin,
      stdout: { enqueue: output.enqueue, drain: output.drain },
    });
  }

  const runtimeSession = new RuntimeFrontendSession({
    runtime,
    attachment: resumed ? 'resume' : 'create',
    ...(resumeTarget !== undefined && { threadId: resumeTarget.threadId }),
    ...(initialModel !== undefined && { initialModel }),
    registerModel: (model) => modelResolver.register(model),
  });
  let session: CliSession;
  try {
    await runtimeSession.initialize();
    session = runtimeSession;
  } catch (err) {
    console.error(`[coda] session initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  // Approval requests are already canonical Runtime events projected through `session.subscribe`;
  // the legacy UI bridge only translates decisions back into control_response/abort operations.
  const approval: ReplApproval | undefined = approvalMode === 'interactive'
    ? {
        broker: { resolve: (approvalId, decision) => runtimeSession.resolveApproval(approvalId, decision) },
        onAbort: () => {},
        subscribe: () => () => {},
      }
    : undefined;

  // 默认交互面:双 TTY 且终端具备全屏能力时懒加载 OpenTUI。这里必须早于 stdout
  // FileSink/legacy renderer 的创建——两套渲染器不能同时拥有 raw stdin/stdout。
  // 初始化失败时 createCliRenderer 会恢复终端，随后可安全降级 classic REPL；
  // 已进入运行期的错误由 startTui 自己收尾并返回 exit code，不从中途切换 UI。
  if (tuiEligible) {
    try {
      const { startTui } = await import('./tui.js');
      return await startTui(session, approval, {
        cwd,
        projectRuleWarnings,
        ...(session.currentModel() !== undefined && {
          model: session.currentModel(),
        }),
        version: packageJson.version,
        color: !flags.noColor && Bun.env.NO_COLOR === undefined,
        ...(initialModel?.limits?.context !== undefined && {
          contextLimit: initialModel.limits.context,
        }),
        resumed,
        ...(registry !== undefined && {
          providerCommands: {
            registry,
            runtime: runtimeSession,
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
    projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
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
  if (flags.prompt === undefined && process.stdout.isTTY === true) {
    projectRuleWarnings.subscribeWarnings((message) => {
      renderer.println?.(`⚠ project rules · ${sanitizeTerminalLine(message)}`);
    });
  } else {
    projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
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
    ...(registry !== undefined && {
      providerCommands: {
        registry,
        runtime: runtimeSession,
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

function buildSystemPrompt(cwd: string): string {
  return (
    `You are coda, a terminal coding agent. Working directory: ${cwd}\n` +
    'Use the provided tools to inspect and modify files. Read files before editing them. ' +
    'Prefer small, verifiable steps; when done, summarize what changed in one short sentence.'
  );
}

interface WarningHub {
  readonly emit: (message: string) => void;
  readonly subscribeWarnings: (listener: (message: string) => void) => () => void;
}

function createWarningHub(): WarningHub {
  const history: string[] = [];
  const listeners = new Set<(message: string) => void>();
  return {
    emit: (message) => {
      history.push(message);
      for (const listener of [...listeners]) listener(message);
    },
    subscribeWarnings: (listener) => {
      for (const message of history) listener(message);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function logProjectRuleWarning(message: string): void {
  console.error(`[coda] warning: project rules · ${sanitizeTerminalLine(message)}`);
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
