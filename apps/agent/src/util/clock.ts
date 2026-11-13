/** Injectable clock so the engine runs the same in real time and in deterministic simulations. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic clock for scenarios and tests. Time only moves via advance(). */
export class VirtualClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  private seq = 0;

  constructor(start = Date.UTC(2026, 0, 5, 8, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => this.setTimeout(r, ms));
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn, every: null });
    return () => this.clear(id);
  }

  setInterval(fn: () => void, ms: number): () => void {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn, every: Math.max(1, ms) });
    return () => this.clear(id);
  }

  private clear(id: number) {
    this.timers = this.timers.filter((x) => x.id !== id);
  }

  /** Let pending promise chains settle. */
  async settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await flush();
  }

  /** Advance virtual time, firing due timers in order and letting async work settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await this.settle();
    for (;;) {
      let next: Timer | undefined;
      for (const x of this.timers) if (x.at <= target && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      if (next.every != null) next.at += next.every;
      else this.clear(next.id);
      next.fn();
      await this.settle();
    }
    this.t = target;
    await this.settle();
  }
}
