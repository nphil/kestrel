/** A small map that remembers at most `limit` entries. Reading an entry makes it the newest, and adding one past the limit forgets the one that
 * has gone unused the longest. What a tab keeps between visits to a page (a species' lists, its facts, its recordings, who took a photo) lives in
 * one of these, so a panel left open for days stays the size it was on the first. */
export class Lru<K, V> {
  private readonly items = new Map<K, V>();
  readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("an Lru keeps at least one entry");
    this.limit = limit;
  }

  get size(): number { return this.items.size; }

  /** The entry, now the newest; undefined when there is none. */
  get(key: K): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  /** Keeps `value` as the newest entry, and forgets the one unused longest when that makes more than `limit`. */
  set(key: K, value: V): this {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.limit) this.items.delete(this.items.keys().next().value as K);
    return this;
  }

  delete(key: K): boolean { return this.items.delete(key); }

  clear(): void { this.items.clear(); }

  /** Every kept value, the one unused longest first, without making any of them newer. */
  values(): IterableIterator<V> { return this.items.values(); }
}
