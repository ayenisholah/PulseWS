export type MonotonicClock = () => number;

const defaultClock: MonotonicClock = () => performance.now();

export class TokenBucket {
  private availableTokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly clock: MonotonicClock = defaultClock,
  ) {
    this.availableTokens = ratePerSecond;
    this.lastRefillAt = clock();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.availableTokens < 1) {
      return false;
    }

    this.availableTokens -= 1;
    return true;
  }

  private refill(): void {
    const now = this.clock();
    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1_000;
    this.lastRefillAt = now;
    this.availableTokens = Math.min(
      this.ratePerSecond,
      this.availableTokens + elapsedSeconds * this.ratePerSecond,
    );
  }
}
