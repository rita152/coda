// per-path 写操作串行队列(pi-mono withFileMutationQueue 的移植,工具 Executor 语义见 docs/07-tools.md)。
// parallel 工具批次(以及未来放开并行写配置)下,同一路径的 edit/write 互斥执行。
// 移植要点(pi 的教训):不在 abort 事件回调里 reject——那会让队列锁提前释放,
// 后续写操作在前一个未完成时闯入;abort 由执行体自身在每个 await 后检查 signal。

const tails = new Map<string, Promise<unknown>>();

/** 按 resolve 后的绝对路径串行化 fn;fn 的异常正常向外传播,不破坏队列。 */
export async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(absPath) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前序失败不阻塞后续(错误已由前序调用方消费)
  // 队列尾登记 settle 后的哨兵;若自己仍是尾则清条目,防 Map 无界增长
  const sentinel = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(absPath, sentinel);
  void sentinel.then(() => {
    if (tails.get(absPath) === sentinel) tails.delete(absPath);
  });
  return run;
}
