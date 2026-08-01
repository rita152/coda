#!/usr/bin/env bun
// Side-effect-free executable boundary. Help, version, completion, and usage errors resolve here
// before config/storage/provider/Runtime/OpenTUI modules are imported.

import packageJson from '../../package.json';
import {
  CliUsageError,
  parseCliInvocation,
  renderCliHelp,
  renderCliUsageError,
  renderCompletion,
} from './command-catalog.js';
import { sanitizeTerminalLine } from './terminal-sanitize.js';

export async function bootstrap(argv: readonly string[]): Promise<number> {
  let invocation;
  try {
    invocation = parseCliInvocation(argv);
  } catch (error) {
    const message = error instanceof CliUsageError
      ? renderCliUsageError(error)
      : `[coda] ${sanitizeTerminalLine(error instanceof Error ? error.message : String(error))}`;
    process.stderr.write(`${message}\n`);
    return 2;
  }

  switch (invocation.command.kind) {
    case 'help':
      process.stdout.write(`${renderCliHelp(packageJson.version, invocation.command.commandPath)}\n`);
      return 0;
    case 'version':
      process.stdout.write(`coda ${packageJson.version}\n`);
      return 0;
    case 'completion':
      process.stdout.write(`${renderCompletion(invocation.command.shell)}\n`);
      return 0;
    default: {
      const { runCli } = await import('./main.js');
      return runCli(invocation, packageJson.version);
    }
  }
}

if (import.meta.main) {
  try {
    // Keep the executable module itself pending until the selected product path settles.
    // A detached `.then()` lets Bun exit when a provider is between JS-only async boundaries,
    // which can truncate a real one-shot immediately after assistant message_start.
    process.exitCode = await bootstrap(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[coda] fatal: ${sanitizeTerminalLine(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  }
}
