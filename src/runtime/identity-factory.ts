// Default IDs use secure randomness only when an explicit Runtime action asks for a new identity.

import { deriveOpId } from '../protocol/index.js';
import type {
  ExternalOpId,
  RunId,
  ThreadId,
  TurnId,
} from '../protocol/index.js';
import type { RuntimeIdentityFactory } from './ports.js';

export function createDefaultRuntimeIdentityFactory(): RuntimeIdentityFactory {
  return {
    newThreadId(): ThreadId {
      return `th_${crypto.randomUUID()}` as ThreadId;
    },
    newRunId(): RunId {
      return `run_${crypto.randomUUID()}` as RunId;
    },
    newTurnId(): TurnId {
      return `turn_${crypto.randomUUID()}` as TurnId;
    },
    newOpId(): ExternalOpId {
      return `op_e_${crypto.randomUUID().replaceAll('-', '')}` as ExternalOpId;
    },
    newProcessEpoch(): string {
      return `epoch_${crypto.randomUUID()}`;
    },
    deriveOpId,
  };
}
