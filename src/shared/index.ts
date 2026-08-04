// 无状态工具函数与会话级小状态载体。不 import 其他 src 目录(ESLint zone 强制)。
export { FileTracker } from './file-tracker.js';
export type { FileTrackerPort, FreshnessCheck } from './file-tracker.js';
export { runtimeHomeDir } from './home.js';
export { killProcessTree } from './kill-process-tree.js';
export { clipHead, clipTail, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './truncate.js';
export type { ClipLimits, ClipResult } from './truncate.js';
export { safeBasename, spillToFile, truncationDir } from './spill.js';
export { parsePartialJson } from './partial-json.js';
export { createOrderedOutput, createStdoutOutput } from './ordered-output.js';
export type { OrderedOutput, OutputSink } from './ordered-output.js';
export { canonicalizePath, isPathInside, resolveToolWorkdir } from './fs-path.js';
export { RuntimeStorageError } from './runtime-storage-error.js';
export { compareUtf8 } from './utf8.js';
