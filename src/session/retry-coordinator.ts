// Per-thread retry coordinator: owns attempt state and cancellable backoff, while retry policy
// classification remains the pure decideRetry function in retry.ts.

import type { AssistantMessage } from '../protocol/index.js';
import type { ResolvedRetryOptions, RetryOptions } from './retry.js';
import { decideRetry, resolveRetryOptions } from './retry.js';

export type RetryCoordinatorDecision =
  | { readonly retry: false }
  | {
      readonly retry: true;
      readonly attempt: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    };

export class RetryCoordinator {
  readonly #options: ResolvedRetryOptions;
  #attempt = 0;

  constructor(options?: RetryOptions) {
    this.#options = resolveRetryOptions(options);
  }

  get maxAttempts(): number {
    return this.#options.maxAttempts;
  }

  observeSuccessfulTurn(): void {
    this.#attempt = 0;
  }

  resetForModelChange(): void {
    this.#attempt = 0;
  }

  decide(message: AssistantMessage | undefined): RetryCoordinatorDecision {
    if (message === undefined) return { retry: false };
    const decision = decideRetry(message, this.#attempt, this.#options);
    if (!decision.retry) return { retry: false };
    return {
      retry: true,
      attempt: ++this.#attempt,
      delayMs: decision.delayMs,
      errorMessage: message.errorMessage ?? 'provider error',
    };
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
    return this.#options.sleep(delayMs, signal);
  }
}
