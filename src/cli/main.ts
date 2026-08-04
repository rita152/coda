#!/usr/bin/env bun
// CLI 入口(规格见 docs/09-cli.md §2):flag 解析 → Runtime 组合 → 前端适配 → 分派
// headless / 一次性 / 全屏 TUI。CLI 是最薄的一层:
// 把输入翻译成 identity-bearing RuntimeOps，
// 把 Runtime event payloads 翻译成像素；不持有 Runtime 权威状态副本。

import type { ModelConfig, RuntimeOp, StreamFn, WorkspaceId } from '../protocol/index.js';
import path from 'node:path';
import { createRuntimeThreadDriverFactory } from '../integrations/runtime-thread-driver/index.js';
import { createGitWorkspaceReviewPort } from './git-review-port.js';
import type { FauxScript } from '../providers/faux/index.js';
import {
  createFileRuntimeStorage,
  createMemoryRuntimeStorage,
  createRuntime,
} from '../runtime/index.js';
import type { StoredThreadLocator } from '../runtime/index.js';
import { createStdoutOutput, runtimeHomeDir } from '../shared/index.js';
import { cleanupTruncated } from './cleanup.js';
import {
  getMissingApiKeyMessage,
  isFullScreenTuiEligible,
  readConfigFile,
  resolveInteractiveUi,
  resolveConfig,
} from './config.js';
import type { ResolvedConfig } from './config.js';
import type { CliFlags, CliInvocation } from './command-catalog.js';
import { createHeadlessPromptOp, startHeadless } from './headless.js';
import { startOneShotOutput } from './one-shot-output.js';
import type { CliControlActions } from './frontend-types.js';
import type { CliSession } from './interactive-runtime.js';
import { ProviderRegistry } from './provider-registry.js';
import { runStandaloneProductCommand } from './product-commands.js';
import { ProjectRules } from './project-rules.js';
import { createRenderer } from './renderer.js';
import {
  createCliRuntimeModelResolver,
  createCliPermissionPolicy,
  resolveRuntimeStorageRoots,
} from './runtime-composition.js';
import { RuntimeFrontendSession } from './runtime-frontend.js';
import {
  createCliBasePromptProvider,
  createCliRegistryCapabilityServices,
} from './capability-services.js';
import { isRuntimeResumeRequest, selectCliResumeTarget } from './runtime-resume.js';
import { sanitizeTerminalError, sanitizeTerminalLine } from './terminal-sanitize.js';
import {
  PENDING_PRESENTATION_THREAD_ID,
  ThreadPresentationStore,
} from './presentation-state.js';
import systemPromptTemplate from './system-prompt.md' with { type: 'text' };

const SYSTEM_PROMPT_WORKING_DIRECTORY = '{{WORKING_DIRECTORY}}';

export async function runCli(invocation: CliInvocation, version: string): Promise<number> {
  const flags: CliFlags = { ...invocation.flags };
  const standaloneExit = await runStandaloneProductCommand(invocation, version);
  if (standaloneExit !== undefined) return standaloneExit;
  const sessionsCommand = invocation.command.kind === 'sessions';

  // 启动清理:截断落盘的 7 天保留(docs/07 §1)。fire-and-forget:失败静默、不阻塞启动。
  if (!sessionsCommand && !flags.ephemeral) void cleanupTruncated();

  // 非 TTY stdin 且非 --json:读完 stdin 作为一次性 prompt(docs/09 §1)。
  // 读空(coda </dev/null 且无 -p):没有可执行的交互或一次性输入——
  // 提示用法并 exit 2(放在 Session 创建之前,不为错误路径留下空会话文件)。
  if (
    !sessionsCommand &&
    !flags.json &&
    flags.prompt === undefined &&
    !process.stdin.isTTY
  ) {
    const text = (await Bun.stdin.text()).trim();
    if (text.length === 0) {
      console.error('[coda] empty stdin and no prompt; usage: coda -p "..."  or  echo "..." | coda');
      return 2;
    }
    flags.prompt = text;
  }
  if (flags.ui === 'tui' && flags.prompt !== undefined) {
    console.error('[coda] --ui=tui cannot be combined with one-shot input; remove --ui or start an interactive TTY');
    return 2;
  }
  const modernOneShot =
    flags.output !== undefined ||
    flags.finalOnly ||
    flags.ephemeral ||
    flags.timeoutMs !== undefined;
  if (modernOneShot && flags.prompt === undefined) {
    console.error(
      '[coda] --output, --final-only, --ephemeral, and --timeout require one-shot input; ' +
        'provide a prompt or pipe stdin',
    );
    return 2;
  }

  const interactiveMode =
    !sessionsCommand &&
    !flags.json &&
    flags.prompt === undefined &&
    process.stdin.isTTY === true;
  const terminalState = {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    term: Bun.env.TERM,
  };
  const tuiEligible = isFullScreenTuiEligible(flags, terminalState);
  const uiResolution = interactiveMode
    ? resolveInteractiveUi(flags.ui, terminalState)
    : undefined;
  if (uiResolution?.ok === false) {
    console.error(`[coda] ${uiResolution.message}`);
    return 2;
  }
  let resolved: ResolvedConfig = {};
  let registry: ProviderRegistry | undefined;
  if (!sessionsCommand) {
    try {
      resolved = resolveConfig(flags, Bun.env, readConfigFile(), {
        allowMissingApiKey: interactiveMode,
      });
      if (interactiveMode || resolved.modelConfig === undefined) {
        registry = new ProviderRegistry();
      }
    } catch (err) {
      console.error(`[coda] ${sanitizeTerminalError(err)}`);
      return 2;
    }
  }

  const missingKey = getMissingApiKeyMessage(resolved);
  let initialModel: ModelConfig | undefined;
  if (resolved.modelConfig !== undefined) {
    // 显式 model 配置若缺 key，交互面退回未选择状态；绝不拿占位配置创建线程。
    initialModel =
      missingKey === undefined ? resolved.modelConfig : undefined;
  } else {
    initialModel = registry?.resolveSelectedModel();
  }
  if (
    !sessionsCommand &&
    initialModel === undefined &&
    !interactiveMode &&
    (!flags.json || flags.prompt !== undefined)
  ) {
    console.error(
      `[coda] ${
        missingKey ??
        '尚未选择模型；请先在交互终端运行 /login 配置 API key，再运行 /model'
      }`,
    );
    return 2;
  }

  // 审批模式默认(docs/09 路由):交互 TUI → interactive;headless(--json)与 -p
  // 一次性 → allow(机器驱动场景由调用方自决信任边界)。显式 --approval-mode 覆盖一切。
  // 注意此判定在「非 TTY stdin → prompt」归一之后:echo | coda 同属机器驱动形态。
  const approvalMode =
    flags.approvalMode ?? (
      flags.json || flags.prompt !== undefined
        ? 'allow'
        : 'interactive'
    );
  // -p(非 --json)没有键位面也没有 approval 命令面,interactive 审批只会挂死在等待上:
  // 显式给出该组合按配置错误 fail-fast(headless --json + interactive 是合法的,有命令面)。
  if (approvalMode === 'interactive' && flags.prompt !== undefined && !flags.json) {
    console.error('[coda] --approval-mode interactive 与 -p 一次性模式不兼容(无审批应答面);用 --json 或改用 allow/deny');
    return 2;
  }

  const roots = resolveRuntimeStorageRoots({ homeDir: runtimeHomeDir() });
  const storage = flags.ephemeral
    ? createMemoryRuntimeStorage()
    : createFileRuntimeStorage({ root: roots.runtimeRoot });
  let resumeTarget: StoredThreadLocator | undefined;
  try {
    if (isRuntimeResumeRequest(flags)) {
      resumeTarget = await selectCliResumeTarget(await storage.listStoredThreads(), flags);
      if (resumeTarget === undefined) {
        console.error('[coda] no session to resume');
        return 2;
      }
    }
  } catch (err) {
    console.error(`[coda] ${sanitizeTerminalError(err)}`);
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
    console.error(`[coda] ${sanitizeTerminalError(err)}`);
    return 2;
  }

  const projectRuleWarnings = createWarningHub();
  const projectRules = new ProjectRules({ cwd, onWarning: projectRuleWarnings.emit });
  const capabilityComposition = createCliRegistryCapabilityServices({
    cwd,
    approvalMode,
    basePrompts: createCliBasePromptProvider({ content: buildSystemPrompt(cwd) }),
    ruleSnapshots: projectRules,
    ruleFreshness: projectRules,
    ruleBudget: {
      maxFiles: 32,
      maxFileBytes: 32 * 1024,
      maxBytes: 256 * 1024,
      maxPromptTokens: 16 * 1024,
    },
    ...(fauxScript !== undefined && { fauxScript }),
  });
  const compactionStreamFn: StreamFn = (model, context, options) => {
    const adapter = capabilityComposition.providerRegistry.snapshot().resolve(model.ref.api);
    if (adapter === undefined) {
      throw new Error(`No provider adapter is registered for ${JSON.stringify(model.ref.api)}`);
    }
    return adapter.stream(model, context, options);
  };
  const driverFactory = createRuntimeThreadDriverFactory({
    configure: () => ({ compactionStreamFn }),
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
      permissionPolicy: createCliPermissionPolicy(approvalMode),
      threadDriverFactory: driverFactory,
      capabilityServices: capabilityComposition.services,
      workspaceReview: createGitWorkspaceReviewPort(),
    });
  } catch (err) {
    console.error(`[coda] runtime initialization failed: ${sanitizeTerminalError(err)}`);
    return 2;
  }

  if (sessionsCommand) {
    try {
      const sessions = [...await runtime.listThreads()].sort(
        (left, right) => right.createdAt - left.createdAt,
      );
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({
          type: 'sessions',
          workspaceId: runtime.workspaceId,
          cwd,
          sessions,
        })}\n`);
      } else if (sessions.length === 0) {
        process.stdout.write('No sessions in this workspace.\n');
      } else {
        for (const item of sessions) {
          const title = item.title === undefined ? '(untitled)' : sanitizeTerminalLine(item.title);
          process.stdout.write(
            `${sanitizeTerminalLine(item.threadId)}  ${new Date(item.createdAt).toISOString()}  ` +
            `${sanitizeTerminalLine(item.state)}  ${title}\n`,
          );
        }
        process.stdout.write('Resume: coda --resume=<thread-id>\n');
      }
      return 0;
    } catch (err) {
      console.error(`[coda] sessions failed: ${sanitizeTerminalError(err)}`);
      return 1;
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }

  if (flags.json) {
    projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
    const output = createStdoutOutput();
    const initialOps: RuntimeOp[] = [];
    if (flags.prompt !== undefined) {
      if (initialModel === undefined) {
        console.error('[coda] --json with an initial prompt requires a configured model');
        await runtime.close().catch(() => undefined);
        return 2;
      }
      const threadId = resumeTarget?.threadId ?? runtime.newThreadId();
      initialOps.push({
        type: resumed ? 'thread_resume' : 'thread_create',
        opId: runtime.newOpId(),
        workspaceId: runtime.workspaceId,
        threadId,
        model: initialModel.ref,
      });
      initialOps.push(createHeadlessPromptOp({
        workspaceId: runtime.workspaceId,
        threadId,
        opId: runtime.newOpId(),
        text: flags.prompt,
      }));
    }
    return startHeadless(runtime, {
      stdin: process.stdin,
      stdout: { enqueue: output.enqueue, drain: output.drain },
      ...(initialOps.length > 0 && { initialOps }),
    });
  }

  let tuiWorkspaceSnapshot;
  if (tuiEligible) {
    try {
      tuiWorkspaceSnapshot = await runtime.getWorkspaceSnapshot();
    } catch (err) {
      console.error(`[coda] runtime snapshot failed: ${sanitizeTerminalError(err)}`);
      await runtime.close().catch(() => undefined);
      return 2;
    }
  }

  const runtimeSession = new RuntimeFrontendSession({
    runtime,
    attachment: resumed ? 'resume' : 'create',
    ...(resumeTarget !== undefined && { threadId: resumeTarget.threadId }),
    ...(initialModel !== undefined && { initialModel }),
    registerModel: (model) => modelResolver.register(model),
  });
  const presentationStore = interactiveMode
    ? new ThreadPresentationStore({
        root: path.join(roots.runtimeRoot, 'presentation-v1'),
        workspaceId: runtime.workspaceId,
        // A create path first owns the stable workspace-pending draft, even when a model is
        // already selected. Attachment migrates it to the reserved Runtime ThreadId. Explicit
        // resume starts with its known target identity and never adopts an unrelated cold draft.
        threadId: resumed
          ? runtimeSession.threadId
          : PENDING_PRESENTATION_THREAD_ID,
        onWarning: (message) => console.error(`[coda] ${sanitizeTerminalLine(message)}`),
      })
    : undefined;
  if (presentationStore !== undefined && !resumed) {
    const unsubscribePendingMigration = runtimeSession.subscribeSessionAttached(() => {
      if (presentationStore.snapshot().threadId === PENDING_PRESENTATION_THREAD_ID) {
        presentationStore.migrateToThread(runtimeSession.threadId);
      }
      unsubscribePendingMigration();
    });
  }
  let session: CliSession;
  try {
    await runtimeSession.initialize();
    session = runtimeSession;
  } catch (err) {
    console.error(`[coda] session initialization failed: ${sanitizeTerminalError(err)}`);
    try {
      presentationStore?.dispose();
    } catch (saveError) {
      console.error(`[coda] presentation save failed: ${sanitizeTerminalError(saveError)}`);
    }
    return 2;
  }
  // Approval requests arrive as Runtime event payloads through `session.subscribe`; this small
  // UI action adapter only translates decisions back into control_response/abort operations.
  const approval: CliControlActions | undefined = approvalMode === 'interactive'
    ? {
        resolveApproval: (requestId, decision) => runtimeSession.resolveApproval(requestId, decision),
      }
    : undefined;

  if (modernOneShot) {
    projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
    const output = createStdoutOutput();
    return startOneShotOutput(runtimeSession, {
      prompt: flags.prompt as string,
      mode: flags.output ?? 'text',
      finalOnly: flags.finalOnly,
      ...(flags.timeoutMs === undefined ? {} : { timeoutMs: flags.timeoutMs }),
      stdout: { enqueue: output.enqueue, drain: output.drain },
      fatalSignal: output.failureSignal,
    });
  }
  // 唯一长驻交互面在完整双 TTY 中懒加载 OpenTUI。headless 与一次性路径不会
  // 初始化 native renderer；已进入运行期的错误由 startTui 自己收尾。
  if (tuiEligible) {
    if (tuiWorkspaceSnapshot === undefined) {
      console.error('[coda] Runtime did not provide the required workspace snapshot');
      await session.close().catch(() => undefined);
      try {
        presentationStore?.dispose();
      } catch (saveError) {
        console.error(`[coda] presentation save failed: ${sanitizeTerminalError(saveError)}`);
      }
      return 2;
    }
    try {
      const { startTui } = await import('./tui.js');
      return await startTui(session, approval, {
        cwd,
        projectRuleWarnings,
        ...(session.currentModel() !== undefined && {
          model: session.currentModel(),
        }),
        version,
        color:
          !flags.noColor &&
          flags.theme !== 'mono' &&
          Bun.env.NO_COLOR === undefined,
        theme: flags.theme,
        threadId: runtimeSession.threadId,
        workspaceSnapshot: tuiWorkspaceSnapshot,
        workspace: runtimeSession,
        eventHighWaterSeq: () => runtimeSession.eventHighWaterSeq(),
        ...(presentationStore !== undefined && {
          presentation: { store: presentationStore },
        }),
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
      console.error(`[coda] full-screen TUI unavailable: ${sanitizeTerminalError(err)}`);
      await session.close().catch(() => undefined);
      try {
        presentationStore?.dispose();
      } catch (saveError) {
        console.error(`[coda] presentation save failed: ${sanitizeTerminalError(saveError)}`);
      }
      return 1;
    }
  }

  // 输出走有序 Bun FileSink 队列；TTY 能力探测仍由 compatibility 边界的 process.stdout 提供。
  // Runtime event subscriber 在每个事件后 drain，给流式输出施加有序背压；退出路径再做最终 drain。
  const output = createStdoutOutput();
  const stdout = {
    get columns(): number | undefined {
      return process.stdout.columns;
    },
    enqueue: output.enqueue,
    drain: output.drain,
  };

  if (flags.prompt === undefined) {
    console.error('[coda] interactive mode requires a supported full-screen TUI terminal');
    await session.close().catch(() => undefined);
    try {
      presentationStore?.dispose();
    } catch (saveError) {
      console.error(`[coda] presentation save failed: ${sanitizeTerminalError(saveError)}`);
    }
    return 2;
  }

  // -p 人类可读输出保持 append-only；颜色只控制 SGR，不初始化 TUI。
  const renderer = createRenderer(stdout, {
    color:
      !flags.noColor &&
      flags.theme !== 'mono' &&
      process.stdout.isTTY === true &&
      Bun.env.NO_COLOR === undefined,
    ascii: flags.ascii,
  });
  projectRuleWarnings.subscribeWarnings(logProjectRuleWarning);
  output.failureSignal.addEventListener(
    'abort',
    () => {
      console.error(`[coda] stdout write failed: ${sanitizeTerminalError(output.failureSignal.reason)}`);
      session.abort();
    },
    { once: true },
  );
  session.subscribe((e) => {
    renderer.render(e);
    return renderer.drain();
  });
  if (resumed && session.messages.length > 0) {
    renderer.replayTranscript(session.messages);
    await renderer.drain();
  }
  // -p 一次性模式:与 headless 共享 one-shot 收尾语义，但使用人类可读输出。退出码同 --json 特例规则
  // willRetry:true 是中间边界；只按最终 agent_end 决定退出码。
  let resolveFinalExit!: (code: number) => void;
  const finalExit = new Promise<number>((resolve) => {
    resolveFinalExit = resolve;
  });
  const unsub = session.subscribe((event) => {
    if (event.type === 'error' && event.fatal) {
      resolveFinalExit(1);
    } else if (event.type === 'agent_end' && event.willRetry !== true) {
      resolveFinalExit(event.reason === 'error' ? 1 : 0);
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

async function readFauxScript(path: string | undefined): Promise<FauxScript> {
  const script: FauxScript =
    path === undefined
      ? { turns: [], onExhausted: 'emptyStop' }
      : ((await Bun.file(path).json()) as FauxScript);
  script.onExhausted = script.onExhausted ?? 'emptyStop';
  return script;
}

export function buildSystemPrompt(cwd: string): string {
  return systemPromptTemplate
    .trimEnd()
    .replace(SYSTEM_PROMPT_WORKING_DIRECTORY, () => cwd);
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
