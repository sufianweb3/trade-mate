import type { Adaptive } from "@oisniper/core";

/** Common exchange leverage steps. The venue's own max and tier caps are added per symbol. */
export const LEVERAGE_LADDER = [125, 100, 75, 50, 40, 30, 25, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
/** Share of the configured margin, largest first. */
export const SIZE_LADDER = [100, 75, 50, 35, 25, 15, 10, 5, 1];
/** Gates no leverage or size change can fix: once one fails, searching further only wastes the event loop. */
export const UNFIXABLE_GATES = new Set(["snapshot_freshness", "book_freshness", "spread", "volume_24h", "funding"]);

/**
 * Leverages the coin allows, best first: the coin's max capped at the requested leverage, then lower steps down
 * to minLeverage. Unknown max (0) or leverage fit off = the requested leverage only.
 */
export function leverageCandidates(requested: number, venueMax: number, tierCaps: number[], ad: Adaptive): number[] {
  if (ad.leverage !== "fit" || venueMax <= 0) return [requested];
  const cap = Math.min(requested, venueMax);
  const all = [cap, ...tierCaps, ...LEVERAGE_LADDER].filter((l) => Number.isInteger(l) && l >= ad.minLeverage && l <= cap);
  return [...new Set(all)].sort((a, b) => b - a);
}

/** Failures that only a lower leverage fixes. Anything else at the coin's leverage is not dodged by dropping it. */
const LEVERAGE_GATES = new Set(["leverage", "liq_buffer"]);

/** Size shares (% of configured margin) to try, largest first. */
export function sizeCandidates(ad: Adaptive): number[] {
  if (ad.size !== "fit") return [100];
  const ladder = SIZE_LADDER.filter((p) => p >= ad.minSizePct);
  return [...new Set([...ladder, ad.minSizePct])].sort((a, b) => b - a);
}

export interface AttemptResult<T> {
  pass: boolean;
  failedGates: string[];
  value: T;
}

export interface Attempt<T> extends AttemptResult<T> {
  leverage: number;
  sizePct: number;
}

export interface FitOutcome<T> {
  chosen: Attempt<T> | null;
  /** Requested leverage at full size. */
  first: Attempt<T>;
  /** Last attempt made (the floor reached, or where an unfixable gate stopped the search). */
  last: Attempt<T>;
  attempts: number;
  stoppedBy: string | null;
}

/**
 * 1. The configured leverage at full size (logged: it explains why a fit was needed).
 * 2. The coin's own leverage (capped at the configured one), shrinking the size for thin books.
 * 3. Only when the leverage itself fails (tier cap, liquidation buffer) the next lower leverage, sizes again.
 * Depth, slippage, cost, chase or volatility at the coin's leverage end the search: a lower leverage would only
 * pass them by widening the ROE stop and target in price, which is a different trade than the one configured.
 * Lowering leverage or size never raises the dollar risk of a trade.
 */
export function fitSearch<T>(requested: number, leverages: number[], sizes: number[], evaluate: (leverage: number, sizePct: number) => AttemptResult<T>): FitOutcome<T> {
  let attempts = 0;
  const run = (leverage: number, sizePct: number): Attempt<T> => {
    attempts++;
    return { ...evaluate(leverage, sizePct), leverage, sizePct };
  };
  const first = run(requested, 100);
  let last = first;
  const done = (chosen: Attempt<T> | null, stoppedBy: string | null): FitOutcome<T> => ({ chosen, first, last, attempts, stoppedBy });
  if (first.pass) return done(first, null);
  const blocked = (a: Attempt<T>) => a.failedGates.find((g) => UNFIXABLE_GATES.has(g)) ?? null;
  if (blocked(first)) return done(null, blocked(first));
  for (const leverage of leverages) {
    for (const sizePct of sizes) {
      if (leverage === requested && sizePct === 100) continue;
      last = run(leverage, sizePct);
      if (last.pass) return done(last, null);
      if (blocked(last)) return done(null, blocked(last));
    }
    // Smallest size still fails at this leverage: go lower only if the leverage is what fails.
    if (!last.failedGates.some((g) => LEVERAGE_GATES.has(g))) break;
  }
  return done(null, null);
}
