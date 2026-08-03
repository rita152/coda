import { describe, expect, it } from 'bun:test';
import type { StoredThreadLocator, ThreadId } from '../runtime/index.js';
import {
  CliResumeSelectionError,
  pickRuntimeThreadInteractive,
  selectCliResumeTarget,
} from './runtime-resume.js';
import { PassThrough } from 'node:stream';

describe('runtime thread resume selection', () => {
  it('uses Runtime order for --continue', async () => {
    const newest = locator('thread-new');
    const old = locator('thread-old');
    expect(await selectCliResumeTarget([newest, old], { continue_: true })).toBe(newest);
  });

  it('resolves an opaque thread id directly', async () => {
    const target = locator('thread-a');
    expect(await selectCliResumeTarget([target], {
      continue_: false,
      resume: 'thread-a',
    })).toBe(target);
  });

  it('rejects duplicate thread ids rather than guessing an owner workspace', async () => {
    const left = locator('same-thread');
    const right = locator('same-thread');
    const selected = selectCliResumeTarget([left, right], {
      continue_: false,
      resume: 'same-thread',
    });
    await expect(selected).rejects.toBeInstanceOf(CliResumeSelectionError);
    await expect(selected).rejects.toMatchObject({ code: 'ambiguous_thread_id' });
  });

  it('renders only the sanitized canonical ThreadId in the non-interactive picker', async () => {
    const attack = '\x1b]52;c;RECOVERY_SECRET\x07\x1b[31mvisible\x1b[0m';
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });

    await expect(pickRuntimeThreadInteractive([locator(`thread-${attack}`)], { input, output }))
      .resolves.toBeUndefined();
    expect(written).toContain('visible');
    expect(written).not.toContain('RECOVERY_SECRET');
    expect(written).not.toContain('\x1b');
    expect(written).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});

function locator(threadId: string): StoredThreadLocator {
  return { threadId: threadId as ThreadId } as StoredThreadLocator;
}
