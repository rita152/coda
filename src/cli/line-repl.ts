// Append-only interactive surface for accessible/plain modes. It uses canonical terminal line
// input (no alternate screen, cursor rewrites, mouse, animation, or bracketed-paste toggles).

import * as readline from 'node:readline';
import type { QueuedMessage } from '../protocol/index.js';
import { renderInteractiveHelp } from './command-catalog.js';
import type { InteractiveSession } from './interactive-runtime.js';
import type { ProviderRegistry } from './provider-registry.js';
import { applyProviderModelSelection } from './provider-actions.js';
import type { Renderer } from './renderer.js';
import {
  decideEnter,
  formatQueueLines,
  formatStatusLines,
  interactionCanAbort,
  interactionEnterState,
} from './repl.js';
import type { ReplApproval } from './repl.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

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
  const rl = readline.createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });

  renderer.println?.(
    options.mode === 'accessible'
      ? 'Accessible mode: append-only output. Type /help for text commands.'
      : 'Plain mode: append-only output. Type /help for text commands.',
  );
  if (session.currentModel() === undefined) {
    renderer.println?.('Get started: 1) coda auth login  2) coda models --select <provider/model>  3) enter a task');
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
            void session.prompt(action.text).catch((error) => renderer.println?.(`prompt failed: ${safeError(error)}`));
            return;
          case 'steer':
            session.steer(action.text);
            return;
          case 'follow_up':
            session.followUp(action.text);
            return;
          case 'command':
            switch (action.command.cmd) {
              case 'quit':
                void shutdown(0, false, false);
                return;
              case 'help':
                renderInteractiveHelp('text').forEach((help) => renderer.println?.(help));
                renderer.println?.('/abort: abort current run · /allow-once, /allow-always, /deny: answer approval');
                return;
              case 'status':
                formatStatusLines(session.usage(), formatModel(session)).forEach((item) => renderer.println?.(item));
                return;
              case 'queue':
                formatQueueLines(queues.steering, queues.followUp).forEach((item) => renderer.println?.(item));
                return;
              case 'follow_up':
                if (action.command.text !== '') session.followUp(action.command.text);
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
