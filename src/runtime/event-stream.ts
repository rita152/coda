// Phase-1 compatibility surface. The workspace-owned implementation moved to the session layer in
// Phase 2; runtime callers should prefer EventHub while existing imports remain source compatible.

export { EventHub, EventHub as WorkspaceEventStream } from '../session/event-hub.js';
export type {
  EventHubOptions,
  EventSubscriptionOptions,
  EventHubOptions as WorkspaceEventStreamOptions,
} from '../session/event-hub.js';
