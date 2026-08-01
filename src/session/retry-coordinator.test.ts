import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '../protocol/index.js';
import { RetryCoordinator } from './retry-coordinator.js';

const errorMessage: AssistantMessage = {
  role: 'assistant',
  id: 'assistant-error',
  timestamp: 0,
  content: [],
  model: { provider: 'faux', api: 'faux', model: 'test' },
  stopReason: 'error',
  usage: { input: 1, output: 0 },
  errorMessage: 'temporary',
  errorDetails: { kind: 'http', status: 503, retryable: true },
};

describe('RetryCoordinator', () => {
  test('owns attempt progression and resets only at a successful turn/model boundary', () => {
    const coordinator = new RetryCoordinator({
      maxAttempts: 2,
      baseDelayMs: 100,
      jitter: () => 0.5,
    });
    expect(coordinator.decide(errorMessage)).toMatchObject({ retry: true, attempt: 1, delayMs: 100 });
    expect(coordinator.decide(errorMessage)).toMatchObject({ retry: true, attempt: 2, delayMs: 200 });
    expect(coordinator.decide(errorMessage)).toEqual({ retry: false });

    coordinator.observeSuccessfulTurn();
    expect(coordinator.decide(errorMessage)).toMatchObject({ retry: true, attempt: 1 });
    coordinator.resetForModelChange();
    expect(coordinator.decide(errorMessage)).toMatchObject({ retry: true, attempt: 1 });
  });

  test('delegates cancellable sleep without coupling it to the pure policy', async () => {
    const calls: number[] = [];
    const coordinator = new RetryCoordinator({
      sleep: async (delayMs, signal) => {
        calls.push(delayMs);
        return signal.aborted;
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.sleep(42, controller.signal)).resolves.toBe(true);
    expect(calls).toEqual([42]);
  });
});
