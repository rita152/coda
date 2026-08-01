// Phase-1 compatibility exports. Thread execution is canonically owned by `session`.

export {
  ThreadDriverHostController,
  ThreadRuntime,
  ThreadRuntime as Phase1ThreadRuntime,
} from '../session/thread-runtime.js';
export type { ThreadRuntimeOptions } from '../session/thread-runtime.js';
