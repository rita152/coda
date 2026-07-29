// Bun FileSink 的有序文本输出适配器。enqueue 保持渲染调用栈同步，drain 在事件边界
// 提供背压；底层 write/flush 无论返回 number 还是 Promise 都会被完整等待。

export interface OutputSink {
  write(chunk: string): number | Promise<number>;
  flush(): number | Promise<number>;
}

export interface OrderedOutput {
  /** 首个底层写入失败时 abort，reason 即原错误；成功路径永不触发。 */
  readonly failureSignal: AbortSignal;
  /** 按调用顺序排队；写入会立即在内部 promise 链上启动。 */
  enqueue(chunk: string): void;
  /** enqueue 并等待截至本次调用已排队的全部内容落入底层 sink。 */
  write(chunk: string): Promise<void>;
  /** 等待截至本次调用已排队的全部内容；首个写入错误会稳定地向后传播。 */
  drain(): Promise<void>;
}

export function createOrderedOutput(sink: OutputSink): OrderedOutput {
  const failureController = new AbortController();
  let pending: Promise<void> = Promise.resolve();
  let failed = false;
  let failure: unknown;

  const enqueue = (chunk: string): void => {
    pending = pending.then(async () => {
      if (failed) return;
      try {
        await sink.write(chunk);
        await sink.flush();
      } catch (err) {
        failed = true;
        failure = err;
        failureController.abort(err);
      }
    });
  };

  const drain = async (): Promise<void> => {
    await pending;
    if (failed) throw failure;
  };

  return {
    failureSignal: failureController.signal,
    enqueue,
    async write(chunk: string): Promise<void> {
      enqueue(chunk);
      await drain();
    },
    drain,
  };
}

/** 进程 stdout 的 Bun-native 单写入者；TTY 能力探测仍由调用方的 compatibility 层负责。 */
export function createStdoutOutput(): OrderedOutput {
  return createOrderedOutput(Bun.stdout.writer());
}
