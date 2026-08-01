// Append-only interactive surface for accessible/plain modes. It uses canonical terminal line
// input (no alternate screen, cursor rewrites, mouse, animation, or bracketed-paste toggles).

import * as readline from 'node:readline';
import type { QueuedMessage } from '../protocol/index.js';
import { renderInteractiveHelp } from './command-catalog.js';
import type { InteractiveSession } from './interactive-runtime.js';
import type { ProviderRegistry } from './provider-registry.js';
import { applyProviderModelSelection } from './provider-actions.js';
import {
  collectDoctorReport,
  formatAuthStatusLines,
  formatDoctorReportLines,
} from './product-commands.js';
import type { Renderer } from './renderer.js';
import {
  decideEnter,
  formatQueueLines,
  formatStatusLines,
  InputHistory,
  interactionCanAbort,
  interactionEnterState,
} from './repl.js';
import type { ReplApproval } from './repl.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';
import {
  copyTextToClipboard,
  editDraftWithExternalEditor,
  exportTranscript,
  latestAssistantText,
  MessageTranscriptSearch,
  promptHistoryEntries,
  transcriptContent,
  workspacePathCandidates,
} from './presentation-actions.js';
import {
  persistableDraft,
  type ThreadPresentationStore,
} from './presentation-state.js';

export interface LineReplOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly approval?: ReplApproval;
  readonly providerCommands?: {
    readonly registry: ProviderRegistry;
    readonly runtime: InteractiveSession;
  };
  readonly fatalSignal?: AbortSignal;
  readonly mode: 'accessible' | 'plain';
  readonly version?: string;
  readonly presentation?: {
    readonly store: ThreadPresentationStore;
    readonly cwd: string;
    readonly editDraft?: (draft: string) => Promise<string>;
    readonly copyText?: (text: string) => Promise<void>;
  };
}

export async function startLineRepl(
  session: InteractiveSession,
  renderer: Renderer,
  options: LineReplOptions,
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const approvalIds: string[] = [];
  let queues: { steering: readonly QueuedMessage[]; followUp: readonly QueuedMessage[] } = {
    steering: [],
    followUp: [],
  };
  let closing = false;
  let commandChain = Promise.resolve();
  const history = new InputHistory();
  for (const prompt of promptHistoryEntries(session.messages)) history.push(prompt);
  const transcriptSearch = new MessageTranscriptSearch(() => session.messages);
  const rl = readline.createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });

  renderer.println?.(
    options.mode === 'accessible'
      ? 'Accessible mode: append-only output. Type /help for text commands.'
      : 'Plain mode: append-only output. Type /help for text commands.',
  );
  if (session.currentModel() === undefined) {
    renderer.println?.('Get started: 1) coda auth login  2) coda models --select <provider/model>  3) enter a task');
  }
  if (options.presentation?.store.snapshot().draft !== '') {
    renderer.println?.('A draft was restored for this thread. Use /draft show or /draft send.');
  }
  stderr.write('> ');

  const unsub = session.subscribe((event) => {
    if (event.type === 'queue_update') {
      queues = { steering: [...event.steering], followUp: [...event.followUp] };
    } else if (event.type === 'approval_request' && !approvalIds.includes(event.approvalId)) {
      approvalIds.push(event.approvalId);
      renderer.println?.('Approval response: y=allow once, a=allow always, n=deny, /abort=abort run');
    }
  });

  return await new Promise<number>((resolve) => {
    const cleanup = (): void => {
      unsub();
      rl.removeAllListeners();
      rl.close();
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('SIGINT', onInterrupt);
      options.fatalSignal?.removeEventListener('abort', onFatalOutput);
    };
    const shutdown = async (
      code: number,
      abort = false,
      waitForCommands = true,
    ): Promise<void> => {
      if (closing) return;
      closing = true;
      try {
        if (abort || interactionCanAbort(session.interactionState())) {
          session.abort();
          options.approval?.onAbort();
        }
        // /quit 本身在 commandChain 内执行，不能等待包含自身的 Promise。
        // signal/EOF 路径则等待已开始的文本命令收尾。
        if (waitForCommands) await commandChain.catch(() => undefined);
        await session.close();
        await renderer.drain();
      } catch (error) {
        renderer.println?.(`shutdown failed: ${safeError(error)}`);
        code = 1;
      } finally {
        cleanup();
        try {
          options.presentation?.store.dispose();
        } catch (error) {
          renderer.println?.(`presentation save failed: ${safeError(error)}`);
          code = 1;
        }
        resolve(code);
      }
    };
    const onTerminate = (): void => { void shutdown(0, true); };
    const onFatalOutput = (): void => { void shutdown(1, true); };
    const onInterrupt = (): void => {
      if (interactionCanAbort(session.interactionState())) {
        session.abort();
        options.approval?.onAbort();
        renderer.println?.('Current run aborted.');
        return;
      }
      void shutdown(0);
    };

    const respondToApproval = (line: string): boolean => {
      const approvalId = approvalIds[0];
      if (approvalId === undefined || options.approval?.broker === undefined) return false;
      const normalized = line.trim().toLocaleLowerCase('en-US');
      const decision = normalized === 'y' || normalized === '/allow-once'
        ? 'allow_once'
        : normalized === 'a' || normalized === '/allow-always'
          ? 'allow_always'
          : normalized === 'n' || normalized === '/deny'
            ? 'deny'
            : undefined;
      if (normalized === '/abort') {
        session.abort();
        approvalIds.length = 0;
        options.approval.onAbort();
        return true;
      }
      if (decision === undefined) {
        renderer.println?.('Approval is waiting: enter y, a, n, or /abort.');
        return true;
      }
      approvalIds.shift();
      options.approval.broker.resolve(approvalId, decision);
      return true;
    };

    const handleProviderTextCommand = async (line: string): Promise<boolean> => {
      const [head, ...rest] = line.trim().split(/\s+/u);
      if (head !== '/login' && head !== '/model' && head !== '/logout') return false;
      if (session.interactionState() !== 'idle') {
        renderer.println?.('Task is still running; finish or abort before provider commands.');
        return true;
      }
      if (head === '/login') {
        renderer.println?.('Login opens a protected secret prompt: exit and run `coda auth login`.');
        return true;
      }
      if (head === '/model') {
        const provider = options.providerCommands;
        if (provider === undefined) {
          renderer.println?.('/model is unavailable in this mode.');
          return true;
        }
        const models = provider.registry.availableModels();
        const ref = rest.join(' ');
        if (ref === '') {
          if (models.length === 0) renderer.println?.('No cached models. Run `coda auth login`.');
          else models.forEach((model) => renderer.println?.(`  ${model.ref} · ${model.api}`));
          renderer.println?.('Choose with `/model <provider/model>`.');
          return true;
        }
        const selected = models.find((model) => model.ref === ref);
        const config = selected === undefined
          ? undefined
          : provider.registry.resolveModel(selected.providerId, selected.model);
        if (selected === undefined || config === undefined) {
          renderer.println?.(`Model unavailable: ${sanitizeTerminalLine(ref)}`);
          return true;
        }
        const { persistenceError } = await applyProviderModelSelection(
          provider.runtime,
          provider.registry,
          config,
        );
        renderer.println?.(`Selected ${selected.ref}.`);
        if (persistenceError !== undefined) {
          renderer.println?.(
            'Model changed, but the recent selection could not be saved; ' +
            `the next launch may not restore it: ${safeError(persistenceError)}`,
          );
        }
        return true;
      }
      if (head === '/logout') {
        const provider = options.providerCommands;
        if (provider === undefined) {
          renderer.println?.('/logout is unavailable in this mode.');
          return true;
        }
        const providerId = rest.join(' ');
        if (providerId === '') {
          const credentials = provider.registry.listCredentials();
          credentials.forEach((credential) =>
            renderer.println?.(`  ${credential.providerId} · ${credential.providerName}`));
          renderer.println?.('Log out with `/logout <provider-id>`.');
          return true;
        }
        if (session.currentModel()?.provider === providerId) provider.runtime.clearModel();
        renderer.println?.(
          provider.registry.logout(providerId)
            ? `Logged out ${sanitizeTerminalLine(providerId)}.`
            : `No saved credentials for ${sanitizeTerminalLine(providerId)}.`,
        );
        return true;
      }
      return false;
    };

    const printSearchMatch = (
      match: ReturnType<MessageTranscriptSearch['move']>,
    ): void => {
      if (match === undefined) {
        renderer.println?.('No transcript matches. Start with /search <query>.');
        return;
      }
      renderer.println?.(
        `match ${match.ordinal + 1}/${match.total} · ${match.label} · ${match.snippet}`,
      );
      options.presentation?.store.setSearch({
        query: transcriptSearch.query,
        matchOrdinal: match.ordinal,
      });
    };

    const editSavedDraft = async (): Promise<void> => {
      const presentation = options.presentation;
      if (presentation === undefined) {
        renderer.println?.('/edit is unavailable without presentation storage.');
        return;
      }
      const draft = presentation.store.snapshot().draft;
      rl.pause();
      stdin.pause();
      try {
        const edited = await (
          presentation.editDraft?.(draft) ??
          editDraftWithExternalEditor(draft, { cwd: presentation.cwd })
        );
        presentation.store.setDraft(persistableDraft(edited));
        presentation.store.flush();
        renderer.println?.('Draft returned from $EDITOR. Use /draft show or /draft send.');
      } catch (error) {
        renderer.println?.(`editor failed: ${safeError(error)}`);
      } finally {
        if (!closing) {
          stdin.resume();
          rl.resume();
        }
      }
    };

    const copyTranscript = async (mode: string): Promise<void> => {
      const normalized = mode === '' ? 'latest' : mode;
      if (normalized !== 'latest' && normalized !== 'raw') {
        renderer.println?.('usage: /copy [latest|raw]');
        return;
      }
      const content = transcriptContent(session.messages, normalized);
      if (content === '') {
        renderer.println?.('Nothing to copy.');
        return;
      }
      try {
        await (options.presentation?.copyText?.(content) ?? copyTextToClipboard(content));
        renderer.println?.(
          normalized === 'raw' ? 'Raw transcript copied.' : 'Latest response copied.',
        );
      } catch (error) {
        renderer.println?.(`copy failed: ${safeError(error)}`);
      }
    };

    const sendSavedDraft = (): void => {
      const presentation = options.presentation;
      if (presentation === undefined) {
        renderer.println?.('/draft is unavailable without presentation storage.');
        return;
      }
      const draft = presentation.store.snapshot().draft;
      if (draft === '') {
        renderer.println?.('No saved draft to send.');
        return;
      }
      try {
        if (interactionEnterState(session.interactionState()) === 'running') {
          session.steer(draft);
          presentation.store.setDraft(persistableDraft(''));
        } else {
          const pending = session.prompt(draft);
          presentation.store.setDraft(persistableDraft(''));
          void pending.catch((error) => {
            if (closing) return;
            presentation.store.setDraft(persistableDraft(draft));
            renderer.println?.(`prompt failed: ${safeError(error)}`);
          });
        }
      } catch (error) {
        renderer.println?.(`prompt failed: ${safeError(error)}`);
      }
    };

    const handleLine = async (line: string): Promise<void> => {
      if (closing) return;
      if (respondToApproval(line)) return;
      if (line.trim() === '/abort') {
        if (interactionCanAbort(session.interactionState())) session.abort();
        else renderer.println?.('No active run to abort.');
        return;
      }
      if (await handleProviderTextCommand(line)) return;
      const action = decideEnter(interactionEnterState(session.interactionState()), false, line);
      try {
        switch (action.kind) {
          case 'none':
            return;
          case 'prompt':
            history.push(action.text);
            void session.prompt(action.text).catch((error) => {
              options.presentation?.store.setDraft(persistableDraft(action.text));
              renderer.println?.(`prompt failed: ${safeError(error)}`);
            });
            return;
          case 'steer':
            history.push(action.text);
            session.steer(action.text);
            return;
          case 'follow_up':
            history.push(action.text);
            session.followUp(action.text);
            return;
          case 'command':
            switch (action.command.cmd) {
              case 'quit':
                void shutdown(0, false, false);
                return;
              case 'abort':
                if (interactionCanAbort(session.interactionState())) session.abort();
                else renderer.println?.('No active run to abort.');
                return;
              case 'help':
                renderInteractiveHelp('text').forEach((help) => renderer.println?.(help));
                renderer.println?.('/abort: abort current run · /allow-once, /allow-always, /deny: answer approval');
                return;
              case 'status':
                formatStatusLines(session.usage(), formatModel(session)).forEach((item) => renderer.println?.(item));
                return;
              case 'doctor': {
                const report = collectDoctorReport(options.version ?? 'unknown');
                formatDoctorReportLines(report).forEach((item) => renderer.println?.(item));
                return;
              }
              case 'auth_status':
                if (options.providerCommands === undefined) {
                  renderer.println?.('/auth is unavailable in this mode.');
                } else {
                  formatAuthStatusLines(options.providerCommands.registry)
                    .forEach((item) => renderer.println?.(item));
                }
                return;
              case 'queue':
                formatQueueLines(queues.steering, queues.followUp).forEach((item) => renderer.println?.(item));
                return;
              case 'follow_up':
                if (action.command.text !== '') session.followUp(action.command.text);
                return;
              case 'history_search': {
                const match = history.reverseSearch(action.command.query);
                renderer.println?.(
                  match === undefined
                    ? 'No matching prompt history.'
                    : `history match\n${sanitizeTerminalLine(match)}`,
                );
                return;
              }
              case 'edit':
                await editSavedDraft();
                return;
              case 'file_complete': {
                const presentation = options.presentation;
                if (presentation === undefined) {
                  renderer.println?.('/files is unavailable without a workspace presentation.');
                  return;
                }
                const candidates = workspacePathCandidates(
                  presentation.cwd,
                  action.command.query,
                  50,
                );
                if (candidates.length === 0) renderer.println?.('No matching workspace paths.');
                else candidates.forEach((candidate) => renderer.println?.(`@${candidate}`));
                return;
              }
              case 'stash': {
                const presentation = options.presentation;
                if (presentation === undefined) {
                  renderer.println?.('/stash is unavailable without presentation storage.');
                } else if (action.command.text === '') {
                  renderer.println?.('usage: /stash <text>');
                } else {
                  presentation.store.stash(persistableDraft(action.command.text));
                  renderer.println?.('Draft stashed for this thread.');
                }
                return;
              }
              case 'restore': {
                const restored = options.presentation?.store.restoreStash();
                renderer.println?.(
                  restored === undefined
                    ? 'No stashed draft for this thread.'
                    : `Draft restored. Use /draft send, or review it below:\n${sanitizeTerminalLine(restored.text)}`,
                );
                return;
              }
              case 'draft': {
                const presentation = options.presentation;
                if (presentation === undefined) {
                  renderer.println?.('/draft is unavailable without presentation storage.');
                  return;
                }
                if (action.command.action === 'send') {
                  sendSavedDraft();
                } else if (action.command.action === 'show') {
                  const draft = presentation.store.snapshot().draft;
                  renderer.println?.(draft === '' ? 'No saved draft.' : `saved draft\n${sanitizeTerminalLine(draft)}`);
                } else if (action.command.action === 'clear') {
                  presentation.store.setDraft(persistableDraft(''));
                  renderer.println?.('Saved draft cleared.');
                } else {
                  renderer.println?.('usage: /draft <show|send|clear>');
                }
                return;
              }
              case 'transcript_search':
                if (action.command.query === '') renderer.println?.('usage: /search <query>');
                else printSearchMatch(transcriptSearch.setQuery(action.command.query));
                return;
              case 'search_next':
                printSearchMatch(transcriptSearch.move(1));
                return;
              case 'search_previous':
                printSearchMatch(transcriptSearch.move(-1));
                return;
              case 'latest': {
                const latest = latestAssistantText(session.messages);
                renderer.println?.(latest === undefined ? 'No assistant response yet.' : `latest response\n${latest}`);
                return;
              }
              case 'copy':
                await copyTranscript(action.command.mode);
                return;
              case 'export': {
                const presentation = options.presentation;
                if (presentation === undefined) {
                  renderer.println?.('/export is unavailable without presentation storage.');
                  return;
                }
                try {
                  const destination = exportTranscript(session.messages, {
                    cwd: presentation.cwd,
                    mode: action.command.mode === 'raw' || action.command.mode === 'latest'
                      ? action.command.mode
                      : 'text',
                    ...(action.command.path === '' ? {} : { destination: action.command.path }),
                  });
                  renderer.println?.(`Exported transcript to ${sanitizeTerminalLine(destination)}.`);
                } catch (error) {
                  renderer.println?.(`export failed: ${safeError(error)}`);
                }
                return;
              }
              case 'vim':
                if (action.command.mode !== 'on' && action.command.mode !== 'off') {
                  renderer.println?.('usage: /vim <on|off>');
                } else {
                  options.presentation?.store.setVimEnabled(action.command.mode === 'on');
                  renderer.println?.(
                    `Vim preference ${action.command.mode === 'on' ? 'enabled' : 'disabled'}; ` +
                    'it applies when this thread opens in TUI/classic.',
                  );
                }
                return;
              case 'login':
              case 'model':
              case 'logout':
                return;
              case 'unknown':
                renderer.println?.(`Unknown command: ${sanitizeTerminalLine(action.command.input)} (try /help)`);
                return;
            }
        }
      } catch (error) {
        renderer.println?.(`command failed: ${safeError(error)}`);
      }
    };

    rl.on('line', (line) => {
      commandChain = commandChain.then(() => handleLine(line)).catch((error) => {
        renderer.println?.(`command failed: ${safeError(error)}`);
      });
      commandChain.finally(() => {
        if (!closing) stderr.write('> ');
      }).catch(() => undefined);
    });
    rl.once('close', () => { void shutdown(0, true); });
    process.once('SIGTERM', onTerminate);
    process.once('SIGINT', onInterrupt);
    options.fatalSignal?.addEventListener('abort', onFatalOutput, { once: true });
    if (options.fatalSignal?.aborted === true) onFatalOutput();
  });
}

function formatModel(session: InteractiveSession): string | undefined {
  const model = session.currentModel();
  return model === undefined ? undefined : `${model.provider}/${model.model}`;
}

function safeError(error: unknown): string {
  return sanitizeTerminalLine(error instanceof Error ? error.message : String(error));
}
