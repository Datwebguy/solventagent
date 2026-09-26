/**
 * Tracks the UsePod prepaid reserve and attributes spend to individual calls.
 *
 * Each call reports the balance remaining after it settled. Attributing
 * `last - remaining` per call keeps the running sum equal to the true decrease even
 * when calls finish out of order, because `last` only ever moves down on observe.
 * Increases (top-ups) are applied explicitly via credit() or picked up by resync().
 */
export class ReserveMeter {
  private lastMicros: number | undefined;
  private inFlight = 0;

  constructor(private readonly fetchBalanceMicros: () => Promise<number>) {}

  async init(): Promise<number> {
    this.lastMicros = await this.fetchBalanceMicros();
    return this.lastMicros;
  }

  get reserveMicros(): number {
    return this.lastMicros ?? 0;
  }

  get reserveUsd(): number {
    return this.reserveMicros / 1e6;
  }

  begin() {
    this.inFlight++;
  }

  end() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Records a post-call balance and returns the micros attributed to that call. */
  observe(remainingMicros: number): number {
    if (!Number.isFinite(remainingMicros)) return 0;
    const prev = this.lastMicros ?? remainingMicros;
    const spent = Math.max(0, prev - remainingMicros);
    this.lastMicros = Math.min(prev, remainingMicros);
    return spent;
  }

  /** Reads the live balance and attributes any decrease to the call that just finished. */
  async settle(): Promise<number> {
    return this.observe(await this.fetchBalanceMicros());
  }

  /** Our own deposit landed. */
  credit(micros: number) {
    this.lastMicros = (this.lastMicros ?? 0) + micros;
  }

  /**
   * Re-reads the true balance when no calls are in flight. Returns the unexplained
   * change: negative means spend we did not attribute, positive means an outside top-up.
   */
  async resync(): Promise<number> {
    if (this.inFlight > 0) return 0;
    const fresh = await this.fetchBalanceMicros();
    const diff = fresh - (this.lastMicros ?? fresh);
    this.lastMicros = fresh;
    return diff;
  }
}
