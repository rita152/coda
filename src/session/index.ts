// session 层出口:JSONL 会话存储、恢复、usage 聚合;retry/compaction 在 M7。
// 规格见 docs/08-session-persistence.md。只依赖 protocol/shared/agent(ESLint zone)。
export { Session } from './session.js';
export type {
  CompactionOptions,
  RetryOptions,
  SessionEvent,
  SessionListener,
  SessionOptions,
} from './session.js';
export {
  defaultSessionDir,
  listSessions,
  loadSession,
  newSessionId,
  PROTOCOL_VERSION,
  SessionStore,
  STORE_VERSION,
  syntheticSummaryMessage,
} from './store.js';
export type {
  CompactionRecord,
  LoadedSession,
  MessageRecord,
  MetaRecord,
  SessionListItem,
  SessionRecord,
} from './store.js';
export { UsageTracker } from './usage.js';
export type { ModelPricing, SessionUsage } from './usage.js';
