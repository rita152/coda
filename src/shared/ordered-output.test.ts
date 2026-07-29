import { describe, expect, test } from 'bun:test';
import { createOrderedOutput } from './ordered-output.js';
import type { OutputSink } from './ordered-output.js';

function deferred(): { promise: Promise<number>; resolve: (value: number) => void } {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createOrderedOutput', () => {
  test('串行等待 write/flush，并保持排队顺序', async () => {
    const firstWrite = deferred();
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const calls: string[] = [];
    const sink: OutputSink = {
      write(chunk) {
        calls.push(`write:${chunk}`);
        if (chunk === 'a') {
          firstStarted();
          return firstWrite.promise;
        }
        return chunk.length;
      },
      flush() {
        calls.push('flush');
        return 0;
      },
    };
    const output = createOrderedOutput(sink);

    output.enqueue('a');
    output.enqueue('b');
    await started;
    expect(calls).toEqual(['write:a']);

    firstWrite.resolve(1);
    await output.drain();
    expect(calls).toEqual(['write:a', 'flush', 'write:b', 'flush']);
  });

  test('首个 sink 错误由 drain/write 稳定传播，后续内容不再写入', async () => {
    const failure = new Error('broken pipe');
    const calls: string[] = [];
    const sink: OutputSink = {
      write(chunk) {
        calls.push(chunk);
        throw failure;
      },
      flush() {
        throw new Error('flush should not run');
      },
    };
    const output = createOrderedOutput(sink);

    output.enqueue('first');
    await expect(output.drain()).rejects.toBe(failure);
    expect(output.failureSignal.aborted).toBe(true);
    expect(output.failureSignal.reason).toBe(failure);
    await expect(output.write('second')).rejects.toBe(failure);
    expect(calls).toEqual(['first']);
  });
});
