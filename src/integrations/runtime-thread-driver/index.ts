// Canonical checkpoint-only ThreadDriver composition. The Runtime journal is the sole durable
// authority: create and resume differ only in which checkpoint the Supervisor supplies.

import type {
  ModelConfig,
  PermissionCeilingSnapshot,
  StreamFn,
  ThreadId,
  WorkspaceId,
} from '../../protocol/index.js';
import { strictJsonSnapshot } from '../../protocol/index.js';
import {
  emptyCheckpoint,
  RuntimeThreadDriver,
  RuntimeThreadExecution,
} from '../../session/index.js';
import type {
  ModelPricing,
  RuntimeThreadDriverAttachment,
  RuntimeThreadDriverFactory,
  RuntimeThreadExecutionOptions,
  ThreadDriverCheckpoint,
  ThreadDriverHostServices,
} from '../../session/index.js';
import type { CompactionOptions } from '../../session/compactor.js';
import type { RetryOptions } from '../../session/retry.js';

export interface RuntimeThreadAttachmentContext {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly model: ModelConfig;
  readonly permissionCeiling: PermissionCeilingSnapshot;
}

export interface RuntimeThreadAttachmentConfiguration {
  /** Provider adapter snapshot dedicated to compaction summary calls. */
  readonly compactionStreamFn: StreamFn;
  readonly pricing?: ModelPricing;
  readonly retry?: RetryOptions;
  readonly compaction?: CompactionOptions;
}

export interface RuntimeThreadDriverFactoryOptions {
  /** Called once per attachment; mutable retry/compaction state is never shared across threads. */
  readonly configure: (
    context: Readonly<RuntimeThreadAttachmentContext>,
  ) => Readonly<RuntimeThreadAttachmentConfiguration>;
}

export function createRuntimeThreadDriverFactory(
  options: RuntimeThreadDriverFactoryOptions,
): RuntimeThreadDriverFactory {
  return {
    create: async (input, host) => constructDriver(
      options,
      input,
      host,
      input.initialCheckpoint ?? emptyCheckpoint(input.model.ref),
    ),
    resume: async (input, host) => constructDriver(
      options,
      input,
      host,
      input.committedCheckpoint,
    ),
  };
}

function constructDriver(
  options: RuntimeThreadDriverFactoryOptions,
  input: RuntimeThreadAttachmentContext,
  host: ThreadDriverHostServices,
  checkpointInput: Readonly<ThreadDriverCheckpoint>,
): RuntimeThreadDriverAttachment {
  const checkpoint = strictJsonSnapshot(checkpointInput) as unknown as Readonly<ThreadDriverCheckpoint>;
  const configured = options.configure({
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    model: input.model,
    permissionCeiling: input.permissionCeiling,
  });
  const state: { driver?: RuntimeThreadDriver } = {};
  const requireDriver = (): RuntimeThreadDriver => {
    if (state.driver === undefined) throw new Error('Runtime execution used before driver construction');
    return state.driver;
  };
  const executionOptions: RuntimeThreadExecutionOptions = {
    model: input.model,
    checkpoint,
    compactionStreamFn: configured.compactionStreamFn,
    truncationScope: input.threadId,
    runtimeTurnProvider: {
      capture: (turnInput) => requireDriver().runtimeTurnProvider.capture(turnInput),
    },
    eventSink: (events) => requireDriver().commitExecutionEvents(events),
    ...(configured.pricing !== undefined && { pricing: configured.pricing }),
    ...(configured.retry !== undefined && { retry: configured.retry }),
    ...(configured.compaction !== undefined && { compaction: configured.compaction }),
  };
  const execution = new RuntimeThreadExecution(executionOptions);
  const driver = new RuntimeThreadDriver({ threadId: input.threadId, host, execution });
  state.driver = driver;
  return { driver, initialCheckpoint: checkpoint };
}
