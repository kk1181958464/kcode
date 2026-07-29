/**
 * Serializes writes while retaining only the newest pending value. This keeps a
 * burst of progress events from building an unbounded disk-write backlog.
 */
export class LatestWriteQueue<T> {
  private pending: T | undefined;
  private running: Promise<void> | undefined;
  private failure: unknown;

  constructor(private readonly write: (value: T) => Promise<void>) {}

  enqueue(value: T) {
    this.pending = value;
    if (!this.running) this.running = this.run();
  }

  async waitForIdle() {
    while (this.running) await this.running;
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
  }

  private async run() {
    try {
      while (this.pending !== undefined) {
        const value = this.pending;
        this.pending = undefined;
        await this.write(value);
      }
    } catch (error) {
      this.pending = undefined;
      this.failure = error;
    } finally {
      this.running = undefined;
      if (this.pending !== undefined) this.running = this.run();
    }
  }
}
