/**
 * Small async queue for producer/consumer boundaries in the agent runtime.
 * Unlike a hand-written wake Promise, completion and failure are retained when
 * they happen before the consumer starts waiting.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failed = false;
  private failure: unknown;

  push(item: T) {
    if (this.closed || this.failed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  /** Keep only the newest item when intermediate progress is replaceable. */
  pushLatest(item: T) {
    if (this.closed || this.failed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else {
      this.items.length = 0;
      this.items.push(item);
    }
  }

  close() {
    if (this.closed || this.failed) return;
    this.closed = true;
    this.flushWaiters();
  }

  fail(error: unknown) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.failure = error;
    this.flushWaiters();
  }

  private flushWaiters() {
    while (this.items.length && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: this.items.shift()!, done: false });
    }
    if (!this.items.length && (this.closed || this.failed)) {
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) {
        if (this.failed) waiter.reject(this.failure);
        else waiter.resolve({ value: undefined as T, done: true });
      }
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length) {
      const value = this.items.shift()!;
      return Promise.resolve({ value, done: false });
    }
    if (this.failed) return Promise.reject(this.failure);
    if (this.closed)
      return Promise.resolve({ value: undefined as T, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  return() {
    this.close();
    return Promise.resolve({ value: undefined as T, done: true });
  }
}
