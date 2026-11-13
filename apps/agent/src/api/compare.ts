import type { App } from "../app";
import { sourceKind, type SourceKind } from "../engine/sources";
import type { SignalSummary } from "../store/records";
import type { TradeRecord } from "../store/types";

const PAIR_MS = 15 * 60_000;

export interface SourceStats {
  signals: number;
  traded: number;
  shadow: number;
  /** Counterfactual win rate: TP1 hit before SL, over signals whose +4h window finished. */
  cfWinRatePct: number | null;
  cfDone: number;
  /** Average ROE: real trades when the bot traded this source, else counterfactual estimate. */
  avgRoePct: number | null;
  avgRoeBasis: "trades" | "counterfactual" | null;
}

/** Estimated ROE of a signal from its counterfactual: TP1 -> +tp1, SL -> -sl, neither -> price move at +4h x leverage. */
function cfRoe(s: SignalSummary, tp1: number, sl: number): number | null {
  const cf = s.counterfactual;
  if (!cf || cf.first_hit == null) return null;
  if (cf.first_hit === "TP1") return tp1;
  if (cf.first_hit === "SL") return -sl;
  return cf.chg_4h != null && cf.leverage != null ? Number(cf.chg_4h) * cf.leverage : null;
}

const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 100) / 100 : null);

/** CoinGlass vs Exchange: counts, overlap, counterfactual win rate, ROE and which source fired first. */
export function sourceComparison(app: App, botId: string) {
  const bot = app.bots.get(botId);
  const cfg = bot.config();
  // Summaries only: parsing every full signal here blocked the event loop for seconds on a day-old Test bot.
  const sigs = app.store.records.signalSummaries(botId);
  const trades = app.store.records.listTrades({ botId, status: "closed" });
  const by: Record<SourceKind, SignalSummary[]> = { coinglass: [], exchange: [] };
  for (const s of sigs) if (s.data_source) by[sourceKind(s.data_source)].push(s);
  const stats = (k: SourceKind): SourceStats => {
    const list = by[k];
    const done = list.filter((s) => s.counterfactual?.first_hit != null);
    const tradesK = trades.filter((t: TradeRecord) => t.data_source && sourceKind(t.data_source) === k);
    const roeTrades = tradesK.map((t) => Number(t.result.net_roe_pct)).filter(Number.isFinite);
    const roeCf = done.map((s) => cfRoe(s, cfg.exits.tp1Pct, cfg.exits.slPct)).filter((x): x is number => x != null);
    return {
      signals: list.length,
      traded: list.filter((s) => s.status === "opened").length,
      shadow: list.filter((s) => s.status === "shadow").length,
      cfWinRatePct: pctOf(done.filter((s) => s.counterfactual?.first_hit === "TP1").length, done.length),
      cfDone: done.length,
      avgRoePct: roeTrades.length ? avg(roeTrades) : avg(roeCf),
      avgRoeBasis: roeTrades.length ? "trades" : roeCf.length ? "counterfactual" : null,
    };
  };
  // pair the first CoinGlass and Exchange signal per symbol within 15 minutes of each other
  const pairs: { symbol: string; leadSec: number }[] = [];
  const usedEx = new Set<string>();
  const exBySym = new Map<string, SignalSummary[]>();
  for (const x of by.exchange) exBySym.set(x.symbol, [...(exBySym.get(x.symbol) ?? []), x]);
  for (const c of [...by.coinglass].sort((a, b) => a.ts - b.ts)) {
    const e = (exBySym.get(c.symbol) ?? [])
      .filter((x) => !usedEx.has(x.signal_id) && Math.abs(x.ts - c.ts) <= PAIR_MS)
      .sort((a, b) => Math.abs(a.ts - c.ts) - Math.abs(b.ts - c.ts))[0];
    if (!e) continue;
    usedEx.add(e.signal_id);
    pairs.push({ symbol: c.symbol, leadSec: Math.round((c.ts - e.ts) / 1000) }); // > 0: exchange fired first
  }
  const union = by.coinglass.length + by.exchange.length - pairs.length;
  const leads = pairs.map((p) => p.leadSec);
  return {
    botId,
    tradesOn: cfg.dataSource.kind,
    coinglass: stats("coinglass"),
    exchange: stats("exchange"),
    overlap: { pairs: pairs.length, pct: pctOf(pairs.length, union) },
    lead: {
      /** Positive: Exchange fired first by this many seconds on average. */
      avgSec: avg(leads),
      exchangeFirst: leads.filter((x) => x > 0).length,
      coinglassFirst: leads.filter((x) => x < 0).length,
      same: leads.filter((x) => x === 0).length,
    },
    recentPairs: pairs.slice(-20),
  };
}
