// Default IDs use secure randomness only when an explicit Runtime action asks for a new identity.

import { deriveOpId } from '../protocol/index.js';
import type {
  ExternalOpId,
  RunId,
  RuntimeIdentityValidationError,
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

// Preserve a type-only reference so package declaration emit documents the factory-fault class
// without instantiating it on the import path.
export type DefaultIdentityFactoryFault = RuntimeIdentityValidationError;
