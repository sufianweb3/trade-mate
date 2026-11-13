import type { BotConfig, ExchangeId, MetricRow, MetricsSnapshot } from "@oisniper/core";
import type { Bus } from "../bus";
import type { ExecutionAdapter } from "../execution/types";
import { log } from "../log";
import type { MarketHub, MarketInfo } from "../market/types";
import type { PositionManager } from "../positions/positionManager";
import { newTradeRecord } from "../positions/tradeRecord";
import type { Store } from "../store/store";
import { NO_FIT, type SignalRecord } from "../store/types";
import { newId } from "../util/ids";
import { liqFor, type marketAtEntry, sendEntry, slFor, tp1For } from "./entry";
import { otherKind, sourceKind, type SourceKind } from "./sources";

/** A fresh signal record with both sources' metrics (comparison mode) and the detection timestamps. */
export function newSignalRecord(o: {
  botId: string; runId: string; versionId: string; now: number; cfg: BotConfig; snap: MetricsSnapshot; m: MetricRow;
  rules: SignalRecord["rule_results"]; latestRow: (kind: SourceKind, symbol: string) => MetricRow | null;
}): SignalRecord {
  const { snap, m } = o;
  return {
    signal_id: newId("sig"), bot_id: o.botId, run_id: o.runId, strategy_version_id: o.versionId, mode: o.cfg.mode,
    symbol: m.symbol, ts: o.now, snapshot_id: snap.id, status: "pending", reject_reasons: [], exchange: null, rematch_count: 0,
    data_source: snap.source, metrics: m, metrics_alt: o.latestRow(otherKind(sourceKind(snap.source)), m.symbol),
    latency: { source_data_ts: snap.dataTs ?? snap.ts, detected_ts: o.now, gates_done_ts: null },
    rule_results: o.rules, gate_results: [], router: [], opened_trades: 0, skipped_variants: [], counterfactual: null,
    fit: { ...NO_FIT, leverage_mode: o.cfg.adaptive.leverage, size_mode: o.cfg.adaptive.size },
  };
}

export interface OpenDeps {
  botId: string;
  cfg: BotConfig;
  adapter: ExecutionAdapter;
  hub: MarketHub;
  store: Store;
  bus: Bus;
  pm: PositionManager;
}

/** Send one profile's entry and hand the filled trade to the position manager. False = skipped (code on the signal). */
export async function openOne(
  d: OpenDeps, sig: SignalRecord, c: Parameters<typeof sendEntry>[2], n: number, ex: ExchangeId, symbol: string,
  market: MarketInfo, mkt: ReturnType<typeof marketAtEntry>,
): Promise<boolean> {
  const tradeId = newId("trd");
  const cid = `${d.botId}-${sig.signal_id.slice(-8)}-e-${n}`;
  try {
    const { fill, expected } = await sendEntry(d.adapter, d.hub, c, ex, symbol, cid, tradeId, d.cfg.execution.maxSlippagePct);
    if (fill.status === "rejected" || !fill.avgPrice) {
      sig.skipped_variants.push({ variant_id: c.profile.variantId, code: fill.code ?? "ORDER_NOT_FILLED" });
      return false;
    }
    const entry = fill.avgPrice;
    const t = newTradeRecord({
      tradeId, botId: d.botId, runId: sig.run_id, mode: d.cfg.mode, versionId: sig.strategy_version_id, signal: sig, profile: c.profile,
      exchange: ex, symbol: sig.symbol, exchangeSymbol: symbol, fill, expectedPrice: expected, market: mkt,
      gates: c.gates.results, takerPct: d.adapter.takerPct(ex, symbol), liqPrice: liqFor(market, entry, fill.filledQty, c.profile.leverage),
      slPrice: slFor(c.profile, entry, market.tickSize), tp1Price: tp1For(c.profile, entry, market.tickSize),
      minFillPct: d.cfg.execution.minFillPct, realFillPrice: fill.realFillPrice,
      leverageVerified: market.leverageVerified, limitsSource: market.limitsSource, fit: c.fit,
    });
    if (c.fit.requestedLeverage !== c.profile.leverage || c.fit.sizePct !== 100)
      d.store.records.addEvent(tradeId, fill.sentAt, "ADAPTIVE_FIT", { requested_leverage: c.fit.requestedLeverage, leverage: c.profile.leverage, size_pct: c.fit.sizePct });
    d.store.records.addEvent(tradeId, fill.sentAt, "ENTRY_SENT", { client_order_id: cid, qty: c.qty.toString(), cap: fill.capPrice.toString() });
    await d.pm.adopt(t, c.profile);
    d.bus.emit("trade:opened", { botId: d.botId, tradeId });
    log.info({ botId: d.botId, runId: sig.run_id, tradeId, signalId: sig.signal_id, symbol, ex, variant: c.profile.variantId, leverage: c.profile.leverage, requestedLeverage: c.fit.requestedLeverage, sizePct: c.fit.sizePct }, "trade opened");
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "EXCHANGE_ERROR";
    sig.skipped_variants.push({ variant_id: c.profile.variantId, code });
    return false;
  }
}
