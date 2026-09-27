/**
 * Map that evicts its oldest entries once the estimated size of the stored
 * values exceeds a byte budget. Used for undo snapshots, which hold full file
 * contents and would otherwise live for the whole app session.
 */
export class BoundedSnapshotMap<V> extends Map<string, V> {
  private sizes = new Map<string, number>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {
    super();
  }

  get bytes() {
    return this.totalBytes;
  }

  override set(key: string, value: V): this {
    // Delete first so a re-set moves the key to the newest position.
    this.delete(key);
    super.set(key, value);
    const size = this.sizeOf(value);
    this.sizes.set(key, size);
    this.totalBytes += size;
    for (const oldest of this.keys()) {
      if (this.totalBytes <= this.maxBytes || oldest === key) break;
      this.delete(oldest);
    }
    return this;
  }

  override delete(key: string): boolean {
    const size = this.sizes.get(key);
    if (size !== undefined) {
      this.totalBytes -= size;
      this.sizes.delete(key);
    }
    return super.delete(key);
  }

  override clear(): void {
    this.sizes?.clear();
    this.totalBytes = 0;
    super.clear();
  }
}

/** Approximate in-memory size of text snapshots (UTF-16). */
export const textSnapshotBytes = (value: { before: string; after: string }) =>
  (value.before.length + value.after.length) * 2;
