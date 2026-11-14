/**
 * When the agent process exits unexpectedly, restart it quickly (open positions are only managed while it runs),
 * but stop retrying when it keeps crashing so the user sees an error instead of a silent loop.
 */
export type RestartDecision = { kind: "restart"; delayMs: number } | { kind: "give_up"; crashes: number };

export class RestartPolicy {
  private crashes: number[] = [];

  constructor(
    private readonly delaysMs: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000],
    private readonly windowMs = 5 * 60_000,
    private readonly maxCrashes = 5,
  ) {}

  recordCrash(now: number): RestartDecision {
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);
    if (this.crashes.length > this.maxCrashes) return { kind: "give_up", crashes: this.crashes.length };
    const i = Math.min(this.crashes.length - 1, this.delaysMs.length - 1);
    return { kind: "restart", delayMs: this.delaysMs[i]! };
  }

  /** A manual restart from the user starts a fresh count. */
  reset(): void {
    this.crashes = [];
  }
}
