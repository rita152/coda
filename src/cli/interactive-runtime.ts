// Narrow human-frontend contract implemented by RuntimeFrontendSession. There is no direct
// Session factory or identity-free execution path: every mutation is translated to RuntimeOp.

import type {
  AgentMessage,
  ModelConfig,
  ModelRef,
  UserMessage,
} from '../protocol/index.js';
import type {
  CliInteractionState,
  CliRuntimeEventListener,
  CliThreadUsage,
} from './frontend-types.js';

export interface InteractiveSession {
  interactionState(): CliInteractionState;
  currentModel(): ModelRef | undefined;
  setModel(model: ModelConfig): void | Promise<void>;
  clearModel(): void;
  usage(): CliThreadUsage;
  readonly messages: readonly AgentMessage[];
  subscribe(listener: CliRuntimeEventListener): () => void;
  subscribeSessionAttached(
    listener: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string | UserMessage): void;
  followUp(text: string | UserMessage): void;
  abort(): void;
  close(): Promise<void>;
}

/** TUI and human one-shot output depend only on this Runtime-backed view. */
export type CliSession = Pick<
  InteractiveSession,
  | 'interactionState'
  | 'currentModel'
  | 'usage'
  | 'messages'
  | 'subscribe'
  | 'prompt'
  | 'steer'
  | 'followUp'
  | 'abort'
  | 'close'
>;
