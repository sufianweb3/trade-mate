import { ceilToStep, D, Decimal, floorToStep, walkBook, type Book } from "@oisniper/core";

/** IOC cap: buy = ref * (1 + slip), rounded down to tick; sell = ref * (1 - slip), rounded up. */
export function iocCap(side: "buy" | "sell", ref: Decimal, maxSlippagePct: number, tick: Decimal): Decimal {
  const f = D(maxSlippagePct).div(100);
  return side === "buy" ? floorToStep(ref.mul(D(1).add(f)), tick) : ceilToStep(ref.mul(D(1).sub(f)), tick);
}

/** Pure exchange-grade fill: VWAP walk with IOC cap. Shared by SimAdapter and Live shadow sim. */
export function simulateIoc(book: Book, side: "buy" | "sell", qty: Decimal, cap: Decimal) {
  return walkBook(book, side, qty, cap);
}

/** Stop-market: walk the whole book side (no cap) at trigger + latency. Gaps fill at real book prices. */
export function simulateMarket(book: Book, side: "buy" | "sell", qty: Decimal) {
  return walkBook(book, side, qty, null);
}
