import { D, Decimal, HUNDRED, ZERO } from "../decimal";

/** [price, base qty] */
export type Level = [Decimal, Decimal];

export interface Book {
  ts: number;
  /** Descending by price. */
  bids: Level[];
  /** Ascending by price. */
  asks: Level[];
}

export interface WalkResult {
  filledQty: Decimal;
  /** VWAP. null when nothing filled. */
  avgPrice: Decimal | null;
  notional: Decimal;
  worstPrice: Decimal | null;
  levelsUsed: number;
  partial: boolean;
}

/**
 * Walk one side of the book for `qty`, respecting an IOC price cap.
 * buy walks asks upward (stops above cap), sell walks bids downward (stops below cap).
 * Within one order consumed levels are removed (self-impact).
 */
export function walkBook(book: Book, side: "buy" | "sell", qty: Decimal, cap: Decimal | null): WalkResult {
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = qty;
  let filled = ZERO;
  let notional = ZERO;
  let worst: Decimal | null = null;
  let used = 0;
  for (const [price, size] of levels) {
    if (remaining.lte(0)) break;
    if (cap) {
      if (side === "buy" && price.gt(cap)) break;
      if (side === "sell" && price.lt(cap)) break;
    }
    const take = size.lt(remaining) ? size : remaining;
    if (take.lte(0)) continue;
    filled = filled.add(take);
    notional = notional.add(take.mul(price));
    remaining = remaining.sub(take);
    worst = price;
    used++;
  }
  return {
    filledQty: filled,
    avgPrice: filled.isZero() ? null : notional.div(filled),
    notional,
    worstPrice: worst,
    levelsUsed: used,
    partial: remaining.gt(0),
  };
}

export function bestBid(b: Book): Decimal | null {
  return b.bids[0]?.[0] ?? null;
}
export function bestAsk(b: Book): Decimal | null {
  return b.asks[0]?.[0] ?? null;
}
export function midPrice(b: Book): Decimal | null {
  const bb = bestBid(b);
  const ba = bestAsk(b);
  return bb && ba ? bb.add(ba).div(2) : null;
}

/** (ask - bid) / mid in percent. */
export function spreadPct(b: Book): Decimal | null {
  const bb = bestBid(b);
  const ba = bestAsk(b);
  const mid = midPrice(b);
  return bb && ba && mid ? ba.sub(bb).div(mid).mul(HUNDRED) : null;
}

/** USDT depth on one side within bandPct of mid. */
export function depthWithin(b: Book, side: "bid" | "ask", bandPct: Decimal.Value): Decimal {
  const mid = midPrice(b);
  if (!mid) return ZERO;
  const band = mid.mul(D(bandPct).div(HUNDRED));
  let sum = ZERO;
  if (side === "ask") {
    const lim = mid.add(band);
    for (const [p, q] of b.asks) {
      if (p.gt(lim)) break;
      sum = sum.add(p.mul(q));
    }
  } else {
    const lim = mid.sub(band);
    for (const [p, q] of b.bids) {
      if (p.lt(lim)) break;
      sum = sum.add(p.mul(q));
    }
  }
  return sum;
}

/** Slippage of a VWAP vs a reference price, percent, signed so that worse = positive. */
export function slippagePct(side: "buy" | "sell", vwap: Decimal, ref: Decimal): Decimal {
  const diff = side === "buy" ? vwap.sub(ref) : ref.sub(vwap);
  return diff.div(ref).mul(HUNDRED);
}

export function parseLevels(raw: readonly (readonly [number | string, number | string])[] | readonly unknown[][]): Level[] {
  const out: Level[] = [];
  for (const row of raw) {
    const p = row[0];
    const q = row[1];
    if ((typeof p === "number" || typeof p === "string") && (typeof q === "number" || typeof q === "string")) {
      out.push([D(p), D(q)]);
    }
  }
  return out;
}
