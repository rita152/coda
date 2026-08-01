// Per-thread compaction coordinator. It owns threshold/overflow counters and the immutable active
// compaction view; Agent messages remain owned by Agent and are only read through method inputs.

import type {
  AgentMessage,
  AssistantMessage,
  Context,
  ModelConfig,
  StreamFn,
  UserMessage,
} from '../protocol/index.js';
import {
  HARD_TRUNCATION_SUMMARY,
  resolveCompactionOptions,
  selectTailStart,
  summarize,
} from './compactor.js';
import type { CompactionOptions, ResolvedCompactionOptions } from './compactor.js';
import type { CompactionRecord } from './store.js';
import { syntheticSummaryMessage } from './store.js';

interface CompactionState {
  readonly tailStartId: string;
  readonly synthetic: UserMessage;
}

export type CompactionCoordinatorDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'compact'; readonly reason: 'threshold' | 'overflow'; readonly hardTruncate: boolean }
  | { readonly kind: 'fatal'; readonly message: string };

export interface CompactionPlan {
  readonly tailStart: number;
  readonly tailMessage?: AgentMessage;
  readonly dropped: readonly AgentMessage[];
  readonly contextTokens: number;
}

export class CompactionCoordinator {
  readonly #options: ResolvedCompactionOptions;
  #pendingThreshold = false;
  #overflowCompactions = 0;
  #state: CompactionState | undefined;
  #lastCheckpoint: CompactionRecord | undefined;

  constructor(options?: CompactionOptions) {
    this.#options = resolveCompactionOptions(options);
  }

  get enabled(): boolean {
    return this.#options.enabled;
  }

  get keepRatio(): number {
    return this.#options.keepRatio;
  }

  get summaryMaxTokens(): number {
    return this.#options.summaryMaxTokens;
  }

  checkpoint(): Readonly<CompactionRecord> | undefined {
    return this.#lastCheckpoint === undefined ? undefined : { ...this.#lastCheckpoint };
  }

  restore(record: CompactionRecord): void {
    this.#lastCheckpoint = { ...record };
    this.#state = {
      tailStartId: record.tailStartId,
      synthetic: syntheticSummaryMessage(record),
    };
  }

  install(record: CompactionRecord): void {
    this.restore(record);
  }

  transform(ctx: Context): Context {
    const state = this.#state;
    if (state === undefined) return ctx;
    const index = ctx.messages.findIndex((message) => message.id === state.tailStartId);
    return index < 0
      ? ctx
      : { ...ctx, messages: [state.synthetic, ...ctx.messages.slice(index)] };
  }

  shouldStopAfterTurn(model: ModelConfig, contextTokens: number): boolean {
    if (!this.#options.enabled) return false;
    const contextLimit = model.limits?.context;
    if (contextLimit === undefined) return false;
    const reserveOutput = model.defaults?.maxOutputTokens ?? 0;
    const budget = this.#options.threshold * (contextLimit - reserveOutput);
    if (contextTokens <= budget) return false;
    this.#pendingThreshold = true;
    return true;
  }

  observeSuccessfulTurn(): void {
    this.#overflowCompactions = 0;
  }

  resetForModelChange(): void {
    this.#pendingThreshold = false;
    this.#overflowCompactions = 0;
  }

  decideRunEnd(
    reason: 'completed' | 'aborted' | 'error',
    lastAssistant: AssistantMessage | undefined,
    model: ModelConfig,
  ): CompactionCoordinatorDecision {
    if (reason === 'completed') {
      const compact = this.#pendingThreshold;
      this.#pendingThreshold = false;
      return compact
        ? { kind: 'compact', reason: 'threshold', hardTruncate: false }
        : { kind: 'none' };
    }
    this.#pendingThreshold = false;
    if (reason === 'aborted' || lastAssistant?.errorDetails?.kind !== 'overflow'
      || !this.#options.enabled || model.limits?.context === undefined) {
      return { kind: 'none' };
    }
    this.#overflowCompactions++;
    if (this.#overflowCompactions >= 3) {
      return {
        kind: 'fatal',
        message:
          'Context overflow persists after compaction and hard truncation. ' +
          'The remaining conversation is too large for this model — switch to a model with a larger context window.',
      };
    }
    return {
      kind: 'compact',
      reason: 'overflow',
      hardTruncate: this.#overflowCompactions >= 2,
    };
  }

  plan(transcript: readonly AgentMessage[], contextTokens: number): CompactionPlan {
    const tailStart = selectTailStart(transcript, contextTokens * this.#options.keepRatio);
    return {
      tailStart,
      ...(transcript[tailStart] !== undefined && { tailMessage: transcript[tailStart] }),
      dropped: transcript.slice(0, tailStart),
      contextTokens,
    };
  }

  async summarize(
    streamFn: StreamFn,
    model: ModelConfig,
    dropped: readonly AgentMessage[],
    signal: AbortSignal,
    hardTruncate: boolean,
  ): Promise<string> {
    if (hardTruncate) return HARD_TRUNCATION_SUMMARY;
    return summarize(streamFn, model, dropped, {
      summaryMaxTokens: this.#options.summaryMaxTokens,
      signal,
    });
  }
}
