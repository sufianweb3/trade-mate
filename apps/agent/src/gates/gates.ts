import {
  bestAsk, bestBid, D, Decimal, depthWithin, HUNDRED, midPrice, slippagePct, spreadPct, tierFor, toRoe, walkBook,
  type Book, type ExitProfile, type Gates, type SizeResult,
} from "@oisniper/core";
import type { MarketInfo } from "../market/types";
import type { GateResult } from "../store/types";

export interface GateInput {
  gates: Gates;
  profile: ExitProfile;
  book: Book | null;
  now: number;
  snapshotTs: number;
  scrapeIntervalMs: number;
  /** CoinGlass price at signal time converted to exchange units (x multiplier). */
  signalPrice: Decimal | null;
  sizing: SizeResult;
  takerPct: Decimal;
  volume24h: Decimal | null;
  fundingRate: Decimal | null;
  range1mPct: Decimal | null;
  market: MarketInfo;
  liqPrice: Decimal | null;
  slPrice: Decimal | null;
}

export interface GateOutput {
  results: GateResult[];
  pass: boolean;
  entryVwap: Decimal | null;
  entrySlipPct: Decimal | null;
  exitSlipPct: Decimal | null;
  estCostPct: Decimal | null;
}

const s = (d: Decimal | null | undefined, dp = 6) => (d == null ? null : d.toFixed(dp));

/** tp1_dist in price %: gates are expressed as a share of it so they scale with leverage. */
export function tp1Dist(p: ExitProfile): Decimal {
  return toRoe(p.tp1Pct, p.basis, p.leverage).div(p.leverage);
}

/** PRD Section 8. Every gate is evaluated and logged with measured values, even after a failure. */
export function runGates(i: GateInput): GateOutput {
  const g = i.gates;
  const r: GateResult[] = [];
  const add = (gate: string, code: string, pass: boolean, value: string | null, limit: string | null) =>
    r.push({ gate, code, pass, value, limit, variant_id: i.profile.variantId });
  const dist = tp1Dist(i.profile);
  const b = i.book;

  // freshness
  const snapAge = i.now - i.snapshotTs;
  const bookAge = b ? i.now - b.ts : null;
  if (g.freshness) {
    add("snapshot_freshness", "SCRAPER_STALE", snapAge <= 2 * i.scrapeIntervalMs, String(snapAge), String(2 * i.scrapeIntervalMs));
    add("book_freshness", "BOOK_STALE", bookAge != null && bookAge <= g.maxBookAgeMs, bookAge == null ? null : String(bookAge), String(g.maxBookAgeMs));
  }
  const qty = i.sizing.ok ? i.sizing.qty : null;
  const notional = i.sizing.ok ? i.sizing.notional : null;

  let entryVwap: Decimal | null = null;
  let entrySlip: Decimal | null = null;
  let exitSlip: Decimal | null = null;
  if (b) {
    const sp = spreadPct(b);
    // A crossed book (bid >= ask, negative spread) is a stale or broken book, never a cheap entry.
    add("spread", "GATE_SPREAD", sp != null && sp.gt(0) && sp.lte(g.maxSpreadPct), s(sp), String(g.maxSpreadPct));
    const need = notional ? notional.mul(g.entryDepthMult) : null;
    const askDepth = depthWithin(b, "ask", g.depthBandPct);
    const bidDepth = depthWithin(b, "bid", g.depthBandPct);
    add("entry_depth", "GATE_ENTRY_DEPTH", need != null && askDepth.gte(need), s(askDepth, 2), s(need, 2));
    const needExit = notional ? notional.mul(g.exitDepthMult) : null;
    add("exit_depth", "GATE_EXIT_DEPTH", needExit != null && bidDepth.gte(needExit), s(bidDepth, 2), s(needExit, 2));
    const ask = bestAsk(b);
    const bid = bestBid(b);
    if (qty && ask && bid) {
      const we = walkBook(b, "buy", qty, null);
      const wx = walkBook(b, "sell", qty, null);
      entryVwap = we.partial ? null : we.avgPrice;
      entrySlip = entryVwap ? slippagePct("buy", entryVwap, ask) : null;
      exitSlip = !wx.partial && wx.avgPrice ? slippagePct("sell", wx.avgPrice, bid) : null;
    }
    add("entry_slippage", "GATE_ENTRY_SLIPPAGE", entrySlip != null && entrySlip.lte(g.maxEntrySlippagePct), s(entrySlip), String(g.maxEntrySlippagePct));
  } else {
    for (const [gate, code] of [["spread", "GATE_SPREAD"], ["entry_depth", "GATE_ENTRY_DEPTH"], ["exit_depth", "GATE_EXIT_DEPTH"], ["entry_slippage", "GATE_ENTRY_SLIPPAGE"]] as const)
      add(gate, code, false, null, null);
  }

  // cost to target
  const estCost = entrySlip != null && exitSlip != null ? i.takerPct.mul(2).add(entrySlip).add(exitSlip) : null;
  const costShare = estCost ? estCost.div(dist).mul(HUNDRED) : null;
  add("cost_to_target", "GATE_COST_TO_TARGET", costShare != null && costShare.lte(g.maxCostToTargetPct), s(costShare, 4), String(g.maxCostToTargetPct));

  // chase guard: adverse (upward) move since the signal snapshot
  const mid = b ? midPrice(b) : null;
  const move = mid && i.signalPrice && i.signalPrice.gt(0) ? mid.div(i.signalPrice).sub(1).mul(HUNDRED) : null;
  const chase = move ? Decimal.max(move, 0).div(dist).mul(HUNDRED) : null;
  add("chase", "GATE_CHASE", chase != null && chase.lte(g.maxChasePct), s(chase, 4), String(g.maxChasePct));

  // volatility
  const vol = i.range1mPct ? i.range1mPct.div(dist).mul(HUNDRED) : null;
  add("volatility", "GATE_VOLATILITY", vol != null && vol.lte(g.maxVolatilityPct), s(vol, 4), String(g.maxVolatilityPct));

  add("volume_24h", "GATE_VOLUME_24H", i.volume24h != null && i.volume24h.gte(g.minVolume24h), s(i.volume24h, 0), String(g.minVolume24h));

  const fundPct = i.fundingRate ? i.fundingRate.mul(HUNDRED) : null;
  add("funding", "GATE_FUNDING", fundPct != null && fundPct.lte(g.maxFundingPct), s(fundPct), String(g.maxFundingPct));

  // leverage available and tier size
  const lev = i.profile.leverage;
  const tier = notional ? tierFor(i.market.tiers, notional) : null;
  const levOk = lev <= i.market.maxLeverage && (tier == null || tier.maxLeverage >= lev);
  add("leverage", "LEVERAGE_UNAVAILABLE", levOk, String(lev), String(Math.min(i.market.maxLeverage, tier?.maxLeverage ?? i.market.maxLeverage)));

  // liquidation buffer with real tiers
  const entry = entryVwap ?? (b ? bestAsk(b) : null);
  let liqOk = false;
  let minSl: Decimal | null = null;
  if (entry && i.liqPrice && i.slPrice) {
    minSl = i.liqPrice.add(entry.sub(i.liqPrice).mul(D(i.profile.liqBufferPct).div(HUNDRED)));
    liqOk = i.slPrice.gt(minSl);
  }
  add("liq_buffer", "LIQ_BUFFER", liqOk, s(i.slPrice, 10), s(minSl, 10));

  // min notional / lot
  add("min_size", i.sizing.ok ? "MIN_NOTIONAL" : i.sizing.code, i.sizing.ok, s(notional, 4), i.market.minNotional.toString());

  return { results: r, pass: r.every((x) => x.pass), entryVwap, entrySlipPct: entrySlip, exitSlipPct: exitSlip, estCostPct: estCost };
}
