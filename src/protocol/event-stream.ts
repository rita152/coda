// EventStream:流事件的载体(规格见 docs/03-internal-protocol.md 第 5 节)。
// 手写 push 队列 + waiting resolver:有消费者正在 await 时 push 直接 resolve 其
// Promise(零延迟路径),否则事件进内部 FIFO buffer。无背压(buffer 无上界,上游
// 天然有界——单条 LLM 流式响应)。

// 惰性求值(每次调用时判定);非 Bun 环境默认视为开发模式。
function warnDev(message: string): void {
  const nodeEnv = (globalThis as {
    readonly process?: { readonly env?: { readonly NODE_ENV?: string } };
  }).process?.env?.NODE_ENV;
  if (nodeEnv === 'production') {
    return;
  }
  console.warn(message);
}

type Waiter<TEvent> = (r: IteratorResult<TEvent, undefined>) => void;

export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  private buffer: TEvent[] = [];
  private waiters: Waiter<TEvent>[] = [];
  private ended = false;
  private readonly resultPromise: Promise<TResult>;
  private resolveResult!: (r: TResult) => void;

  constructor() {
    this.resultPromise = new Promise<TResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  /** 非阻塞,永不 throw。end() 之后的 push 被忽略(开发模式警告)。 */
  push(event: TEvent): void {
    if (this.ended) {
      warnDev('[EventStream] push() after end() ignored');
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  /**
   * 只生效一次,第二次调用忽略 + 警告。使所有进行中与后续的迭代收到 {done: true},
   * 并 resolve result()。已 buffer 的事件仍会先于 done 被迭代到。
   */
  end(result: TResult): void {
    if (this.ended) {
      warnDev('[EventStream] end() called twice, ignored');
      return;
    }
    this.ended = true;
    // 不变量:waiters 非空 ⇒ buffer 为空,直接以 done 收尾等待中的迭代。
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter<TEvent>;
      waiter({ value: undefined, done: true });
    }
    this.resolveResult(result);
  }

  /**
   * 任意时刻可调、可多次调(同一个缓存 Promise);end() 前调用则挂起直到 end。
   * 永不 reject——错误场景 resolve 的是编码了错误的 TResult。
   */
  result(): Promise<TResult> {
    return this.resultPromise;
  }

  /**
   * 单消费者语义:多个迭代器共享同一队列会互相"偷"事件(刻意不支持,广播在
   * 消费侧做)。消费者 break 不影响 result(),也不停止生产者(取消走 AbortSignal)。
   * 迭代器永不 throw。
   */
  [Symbol.asyncIterator](): AsyncIterator<TEvent, undefined> {
    // per-iterator 状态:closed 标志(return() 后 next() 恒 done,遵守 async iterator 协议)
    // 与本迭代器注册的 pending waiter 集合(return() 时从队列摘除并以 done 决议,
    // 防止被放弃的 resolver 残留在 waiters 中吞掉后续 push 的事件)。
    let closed = false;
    const pending = new Set<Waiter<TEvent>>();
    return {
      next: (): Promise<IteratorResult<TEvent, undefined>> => {
        if (closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as TEvent, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          const waiter: Waiter<TEvent> = (r) => {
            pending.delete(waiter);
            resolve(r);
          };
          pending.add(waiter);
          this.waiters.push(waiter);
        });
      },
      // for-await 中 break 会调用 return():仅关闭本迭代器,不消费事件、不终止流。
      return: (): Promise<IteratorResult<TEvent, undefined>> => {
        closed = true;
        for (const waiter of [...pending]) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
