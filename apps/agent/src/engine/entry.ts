import {
  bestAsk, bestBid, D, Decimal, LIQ_FORMULA, liqPriceLong, marginFor, priceAtRoe, sizeOrder, tierFor, ceilToStep, toRoe,
  midPrice, type BotConfig, type ExchangeId, type ExitProfile, type MetricsSnapshot, type MetricRow, type SizeResult,
} from "@oisniper/core";
import { runGates, type GateOutput } from "../gates/gates";
import type { ExecutionAdapter, FillResult } from "../execution/types";
import type { MarketHub, MarketInfo } from "../market/types";
import { NO_FIT, type FitInfo, type GateResult, type MarketAtEntry } from "../store/types";
import { fitSearch, leverageCandidates, sizeCandidates } from "./fit";

export interface Candidate {
  /** Profile actually traded (leverage already fitted). */
  profile: ExitProfile;
  qty: Decimal;
  notional: Decimal;
  liq: Decimal;
  sl: Decimal;
  gates: GateOutput;
  /** Configured leverage and the share of the configured margin used. */
  fit: { requestedLeverage: number; sizePct: number };
}

interface Eval {
  profile: ExitProfile;
  sizing: SizeResult;
  liq: Decimal | null;
  sl: Decimal | null;
  gates: GateOutput;
}

export interface PlanInput {
  cfg: BotConfig;
  profiles: ExitProfile[];
  hub: MarketHub;
  adapter: ExecutionAdapter;
  exchange: ExchangeId;
  symbol: string;
  market: MarketInfo;
  snapshot: MetricsSnapshot;
  scrapeIntervalMs: number;
  signalPrice: Decimal | null;
  balance: Decimal | null;
  now: number;
}

/** Liquidation price for a long with this exchange's formula and tier. */
export function liqFor(m: MarketInfo, entry: Decimal, qty: Decimal, leverage: number): Decimal {
  const notional = entry.mul(qty);
  const tier = tierFor(m.tiers, notional) ?? m.tiers[m.tiers.length - 1]!;
  return liqPriceLong({ formula: LIQ_FORMULA[m.exchange], entry, qty, margin: notional.div(leverage), tier });
}

export function slFor(p: ExitProfile, entry: Decimal, tick: Decimal): Decimal {
  return ceilToStep(priceAtRoe(entry, toRoe(p.slPct, p.basis, p.leverage).neg(), p.leverage), tick);
}
export function tp1For(p: ExitProfile, entry: Decimal, tick: Decimal): Decimal {
  return ceilToStep(priceAtRoe(entry, toRoe(p.tp1Pct, p.basis, p.leverage), p.leverage), tick);
}

export interface PlanResult {
  accepted: Candidate[];
  rejected: { profile: ExitProfile; codes: string[] }[];
  gateResults: GateResult[];
  /** Adaptive outcome (single-profile bots); NO_FIT-shaped with mode "off" otherwise. */
  fit: FitInfo;
}

/**
 * Size and gate every profile against the same book snapshot. With adaptive entry on (single-profile bots only,
 * enforced by the validator) the profile is re-evaluated at lower leverage / smaller size until every gate passes.
 * Gate results keep the configured attempt (why a fit was needed) and the chosen or floor attempt, labelled
 * "<variant>-><lev>x@<size>%".
 */
export function planProfiles(i: PlanInput): PlanResult {
  const book = i.hub.book(i.exchange, i.symbol);
  const ask = book ? bestAsk(book) : null;
  const accepted: Candidate[] = [];
  const rejected: { profile: ExitProfile; codes: string[] }[] = [];
  const gateResults: GateResult[] = [];
  const baseMargin = marginFor(i.cfg.sizing, i.balance);
  const f = i.hub.funding(i.exchange, i.symbol);
  const ad = i.cfg.adaptive;
  const adaptive = (ad.leverage === "fit" || ad.size === "fit") && i.profiles.length === 1;

  const evaluate = (p0: ExitProfile, leverage: number, sizePct: number): Eval => {
    const p = leverage === p0.leverage ? p0 : { ...p0, leverage };
    const margin = sizePct === 100 ? baseMargin : baseMargin.mul(sizePct).div(100);
    const sizing: SizeResult = ask
      ? sizeOrder({ margin, leverage, price: ask, qtyStep: i.market.qtyStep, minQty: i.market.minQty, minNotional: i.market.minNotional, maxQty: null })
      : { ok: false, code: "LOT_SIZE", detail: {} };
    const liq = sizing.ok && ask ? liqFor(i.market, ask, sizing.qty, leverage) : null;
    const sl = sizing.ok && ask ? slFor(p, ask, i.market.tickSize) : null;
    const gates = runGates({
      gates: i.cfg.gates, profile: p, book, now: i.now, snapshotTs: i.snapshot.ts, scrapeIntervalMs: i.scrapeIntervalMs,
      signalPrice: i.signalPrice, sizing, takerPct: i.adapter.takerPct(i.exchange, i.symbol), volume24h: i.hub.volume24h(i.exchange, i.symbol),
      fundingRate: f?.rate ?? null, range1mPct: i.hub.range1mPct(i.exchange, i.symbol), market: i.market, liqPrice: liq, slPrice: sl,
    });
    return { profile: p, sizing, liq, sl, gates };
  };
  const accept = (e: Eval, requestedLeverage: number, sizePct: number): boolean => {
    if (!e.gates.pass || !e.sizing.ok || !e.liq || !e.sl) return false;
    accepted.push({ profile: e.profile, qty: e.sizing.qty, notional: e.sizing.notional, liq: e.liq, sl: e.sl, gates: e.gates, fit: { requestedLeverage, sizePct } });
    return true;
  };
  const failCodes = (e: Eval) => e.gates.results.filter((r) => !r.pass).map((r) => r.code);

  if (!adaptive) {
    for (const p of i.profiles) {
      const e = evaluate(p, p.leverage, 100);
      gateResults.push(...e.gates.results);
      if (!accept(e, p.leverage, 100)) rejected.push({ profile: p, codes: failCodes(e) });
    }
    return { accepted, rejected, gateResults, fit: { ...NO_FIT, leverage_mode: ad.leverage, size_mode: ad.size } };
  }

  const p = i.profiles[0]!;
  const levs = leverageCandidates(p.leverage, i.market.maxLeverage, i.market.tiers.map((t) => t.maxLeverage), ad);
  const out = fitSearch(p.leverage, levs, sizeCandidates(ad), (lev, size) => {
    const e = evaluate(p, lev, size);
    return { pass: e.gates.pass && e.sizing.ok && !!e.liq && !!e.sl, failedGates: e.gates.results.filter((r) => !r.pass).map((r) => r.gate), value: e };
  });
  const label = (a: { leverage: number; sizePct: number }) => `${p.variantId}->${a.leverage}x@${a.sizePct}%`;
  gateResults.push(...out.first.value.gates.results);
  const other = out.chosen ?? out.last;
  if (other !== out.first) gateResults.push(...other.value.gates.results.map((r) => ({ ...r, variant_id: label(other) })));
  const fit: FitInfo = {
    leverage_mode: ad.leverage, size_mode: ad.size, requested_leverage: p.leverage,
    leverage: out.chosen?.leverage ?? null, size_pct: out.chosen?.sizePct ?? null,
    fitted: !!out.chosen && (out.chosen.leverage !== p.leverage || out.chosen.sizePct !== 100),
    attempts: out.attempts, requested_fail_codes: failCodes(out.first.value), stopped_by: out.stoppedBy,
  };
  if (!out.chosen || !accept(out.chosen.value, p.leverage, out.chosen.sizePct)) rejected.push({ profile: p, codes: failCodes(other.value) });
  return { accepted, rejected, gateResults, fit };
}

const BANDS = ["0.1", "0.3", "0.5", "1"];

export function marketAtEntry(hub: MarketHub, ex: ExchangeId, symbol: string, btc: MetricRow | undefined): MarketAtEntry {
  const b = hub.book(ex, symbol);
  const t = hub.lastTick(ex, symbol);
  const f = hub.funding(ex, symbol);
  const depth: Record<string, string> = {};
  if (b) {
    const mid = midPrice(b);
    for (const band of BANDS) {
      let bid = D(0);
      let ask = D(0);
      if (mid) {
        const lo = mid.mul(D(1).sub(D(band).div(100)));
        const hi = mid.mul(D(1).add(D(band).div(100)));
        for (const [p, q] of b.bids) if (p.gte(lo)) bid = bid.add(p.mul(q));
        for (const [p, q] of b.asks) if (p.lte(hi)) ask = ask.add(p.mul(q));
      }
      depth[`bid_${band}`] = bid.toFixed(2);
      depth[`ask_${band}`] = ask.toFixed(2);
    }
  }
  const bb = b ? bestBid(b) : null;
  const ba = b ? bestAsk(b) : null;
  return {
    best_bid: bb?.toString() ?? null,
    best_ask: ba?.toString() ?? null,
    spread_pct: bb && ba ? ba.sub(bb).div(ba.add(bb).div(2)).mul(100).toFixed(6) : null,
    depth,
    volume_24h: hub.volume24h(ex, symbol)?.toFixed(0) ?? null,
    range_1m_pct: hub.range1mPct(ex, symbol)?.toFixed(6) ?? null,
    mark_price: t?.mark.toString() ?? null,
    index_price: t?.index?.toString() ?? null,
    funding_rate: f?.rate.toString() ?? null,
    next_funding_time: f?.nextTime ?? null,
    btc_chg_5m: btc?.price_chg_5m ?? null,
    btc_chg_1h: btc?.price_chg_1h ?? null,
  };
}

export async function sendEntry(adapter: ExecutionAdapter, hub: MarketHub, c: Candidate, ex: ExchangeId, symbol: string, cid: string, tradeId: string, maxSlippagePct: number): Promise<{ fill: FillResult; expected: Decimal }> {
  const book = hub.book(ex, symbol);
  const ref = (book && bestAsk(book)) ?? c.gates.entryVwap ?? D(0);
  await adapter.prepare(ex, symbol, c.profile.leverage);
  const fill = await adapter.placeIoc({
    clientOrderId: cid, tradeId, exchange: ex, symbol, side: "buy", qty: c.qty, refPrice: ref, maxSlippagePct,
    reduceOnly: false, leverage: c.profile.leverage,
  });
  return { fill, expected: ref };
}
