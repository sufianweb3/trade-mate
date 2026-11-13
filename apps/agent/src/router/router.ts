import { bestAsk, bestBid, D, Decimal, depthWithin, HUNDRED, slippagePct, walkBook, type ExchangeId, type Gates } from "@oisniper/core";
import type { MarketHub } from "../market/types";
import type { RouterCandidate } from "../store/types";
import type { SymbolMapper } from "../symbols/mapper";

export interface RouteInput {
  coinglass: string;
  cgPrice: number | null;
  exchanges: ExchangeId[];
  /** Largest notional any profile of this signal will send (Bot 2: max-leverage variant). */
  notional: Decimal;
  /** Adaptive entry: smallest order the fit may send. A venue that cannot fill `notional` but fills this stays in, with the depth penalty. */
  minNotional?: Decimal | null;
  /** Adaptive leverage: configured leverage. Venues offering less are penalised in proportion to the shortfall. */
  fitLeverage?: number | null;
  gates: Gates;
  /** Clock time, for the book-age exclusion. */
  now: number;
  canTrade: (ex: ExchangeId) => boolean;
  takerPct: (ex: ExchangeId, symbol: string) => Decimal;
  hasFreeMargin: (ex: ExchangeId) => boolean;
  /** Subscription reason; the caller releases the chosen venue's book with it when done. */
  reason: string;
}

export interface Venue { exchange: ExchangeId; symbol: string; multiplier: number }

export interface RouteResult {
  /** Best venue (ranked[0]). */
  chosen: Venue | null;
  /**
   * Usable venues, lowest score first, at most MAX_VENUES. Gates run on them in this order and the first that
   * passes is traded, so one venue's wide spread no longer loses a signal another venue could take. The caller
   * releases each ranked venue's book subscription (`reason`) when done.
   */
  ranked: Venue[];
  candidates: RouterCandidate[];
}

/** Venues gated per signal at most (each one is a full gate pass on its own book). */
export const MAX_VENUES = 3;

const DEPTH_PENALTY = D("0.05");
const LATENCY_PENALTY_PER_100MS = D("0.01");
const LEVERAGE_PENALTY = D("0.05");

/**
 * score = est_total_cost_pct (fees + entry slip + exit slip) + penalty_depth + penalty_latency
 * (+ leverage shortfall penalty with adaptive leverage). Lowest wins.
 */
export async function route(hub: MarketHub, mapper: SymbolMapper, i: RouteInput): Promise<RouteResult> {
  const candidates: RouterCandidate[] = [];
  const health = new Map(hub.health().map((h) => [h.exchange, h]));
  const scored: (Venue & { score: Decimal })[] = [];
  // Warm every listed venue's book at once (cold subscribe = REST snapshot): latency is the slowest venue, not the sum.
  await Promise.all(
    i.exchanges.map((ex) => {
      const m = mapper.resolve(i.coinglass, ex, null, null);
      return m.ok && i.canTrade(ex) ? hub.subscribe(ex, m.mapping.symbol, i.reason).catch(() => undefined) : undefined;
    }),
  );
  for (const ex of i.exchanges) {
    const base: RouterCandidate = { exchange: ex, exchange_symbol: null, score: null, est_cost_pct: null, penalty_depth: null, penalty_latency: null, rtt_ms: null, excluded: null };
    const h = health.get(ex);
    if (!h || h.status === "down" || h.status === "maintenance" || h.status === "disabled") {
      candidates.push({ ...base, excluded: `EXCHANGE_${(h?.status ?? "missing").toUpperCase()}` });
      continue;
    }
    if (!i.canTrade(ex)) {
      candidates.push({ ...base, excluded: "EXCHANGE_TRADE_DISABLED" });
      continue;
    }
    if (!i.hasFreeMargin(ex)) {
      candidates.push({ ...base, excluded: "INSUFFICIENT_MARGIN" });
      continue;
    }
    const pre = mapper.resolve(i.coinglass, ex, null, null);
    if (!pre.ok) {
      candidates.push({ ...base, excluded: pre.reason === "UNLISTED" ? "SYMBOL_UNMAPPED" : "SYMBOL_NOT_TRADING" });
      continue;
    }
    const sym = pre.mapping.symbol;
    await hub.subscribe(ex, sym, i.reason).catch(() => undefined);
    const book = hub.book(ex, sym);
    const ask = book ? bestAsk(book) : null;
    const bid = book ? bestBid(book) : null;
    const mid = ask && bid ? ask.add(bid).div(2) : null;
    const verified = mapper.resolve(i.coinglass, ex, i.cgPrice, mid);
    if (!verified.ok) {
      candidates.push({ ...base, exchange_symbol: sym, excluded: verified.reason === "PRICE_MISMATCH" ? "SYMBOL_PRICE_MISMATCH" : "SYMBOL_UNMAPPED" });
      continue;
    }
    if (!book || !ask || !bid || i.now - book.ts > i.gates.maxBookAgeMs) {
      candidates.push({ ...base, exchange_symbol: sym, excluded: "BOOK_STALE" });
      continue;
    }
    // Bid >= ask is a desynced book. It also prices as the cheapest venue, so it must never win the ranking.
    if (!bid.lt(ask)) {
      candidates.push({ ...base, exchange_symbol: sym, excluded: "BOOK_CROSSED" });
      continue;
    }
    const walk = (notional: Decimal) => {
      const qty = notional.div(ask);
      const we = walkBook(book, "buy", qty, null);
      const wx = walkBook(book, "sell", qty, null);
      return we.partial || wx.partial || !we.avgPrice || !wx.avgPrice ? null : { entry: we.avgPrice, exit: wx.avgPrice };
    };
    let w = walk(i.notional);
    let shrunk = false;
    if (!w && i.minNotional && i.minNotional.lt(i.notional)) {
      w = walk(i.minNotional);
      shrunk = !!w;
    }
    if (!w) {
      candidates.push({ ...base, exchange_symbol: sym, excluded: "GATE_ENTRY_DEPTH" });
      continue;
    }
    const taker = i.takerPct(ex, sym);
    const cost = taker.mul(2).add(slippagePct("buy", w.entry, ask)).add(slippagePct("sell", w.exit, bid));
    const need = i.notional.mul(Math.max(i.gates.entryDepthMult, i.gates.exitDepthMult)).mul(2);
    const depth = Decimal.min(depthWithin(book, "ask", i.gates.depthBandPct), depthWithin(book, "bid", i.gates.depthBandPct));
    const pDepth = shrunk || depth.lt(need) ? DEPTH_PENALTY : D(0);
    const rtt = hub.rttMs(ex);
    const pLat = rtt > 300 ? D(rtt - 300).div(100).mul(LATENCY_PENALTY_PER_100MS) : D(0);
    const venueMax = i.fitLeverage ? hub.market(ex, sym)?.maxLeverage ?? 0 : 0;
    const pLev = i.fitLeverage && venueMax > 0 && venueMax < i.fitLeverage ? LEVERAGE_PENALTY.mul(1 - venueMax / i.fitLeverage) : D(0);
    const score = cost.add(pDepth).add(pLat).add(pLev);
    candidates.push({
      ...base, exchange_symbol: sym, score: score.toFixed(6), est_cost_pct: cost.toFixed(6),
      penalty_depth: pDepth.toFixed(4), penalty_latency: pLat.toFixed(4), rtt_ms: rtt,
      ...(i.fitLeverage ? { penalty_leverage: pLev.toFixed(4), max_leverage: venueMax } : {}),
    });
    scored.push({ exchange: ex, symbol: sym, multiplier: verified.mapping.multiplier, score });
  }
  // Stable sort: equal scores keep the configured exchange order.
  const ranked: Venue[] = [...scored].sort((a, b) => a.score.comparedTo(b.score)).slice(0, MAX_VENUES).map(({ exchange, symbol, multiplier }) => ({ exchange, symbol, multiplier }));
  // Release candidate books we will not gate (positions and warm set keep their own references).
  const keep = new Set(ranked.map((v) => v.exchange));
  for (const c of candidates) if (c.exchange_symbol && !keep.has(c.exchange)) hub.unsubscribe(c.exchange, c.exchange_symbol, i.reason);
  return { chosen: ranked[0] ?? null, ranked, candidates };
}

export const pctOf = (a: Decimal, b: Decimal) => a.div(b).mul(HUNDRED);
