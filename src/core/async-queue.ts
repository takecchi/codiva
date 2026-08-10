/**
 * A push-based async iterable. Used as the streaming-input generator for the
 * SDK's query(): the session pushes user messages onto it over time and the SDK
 * consumes them, keeping a single session alive across many turns.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  /**
   * まだ誰にも取り出されていない要素数。`Session` がエージェント切替でストリームを
   * 畳んだあと、「積んだままの指示が残っているか」を同期的に知るために使う
   * （残っていれば新しいエージェントで消費し直す）。
   */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * まだ誰にも渡していない要素を**取り出して空にする**。エージェント切替で
   * このキューを閉じるとき、積み残しの指示を新しいキューへ移し替えるために使う
   * （閉じたキューからも `[Symbol.asyncIterator]` は buffer を先に吐き出すので、
   * 移さないと**古いエージェントが実行してしまう**。捨てると指示が消える）。
   */
  drain(): T[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}
