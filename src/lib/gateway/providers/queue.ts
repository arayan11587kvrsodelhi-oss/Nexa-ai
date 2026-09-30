/**
 * NEXA AI Gateway — async queue.
 *
 * The existing NEXA adapters deliver tokens through a callback
 * (`emitEvent`), while the gateway contract is an `AsyncIterable`. This queue is
 * the single, tested bridge between the two, so no adapter has to invent its own
 * buffering (and no token can be delivered twice or dropped).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: unknown = null;

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  /** Signal normal completion. Idempotent. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  /** Signal failure. The error is rethrown to the consumer once drained. */
  public fail(error: unknown): void {
    if (!this.failure) this.failure = error;
    this.close();
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for (;;) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.closed) break;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) break;
      yield next.value;
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
  }
}
