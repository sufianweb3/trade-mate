import { computePnl, D, Decimal, HUNDRED, ZERO, type ExitProfile, type ExchangeId } from "@oisniper/core";
import type { FillResult } from "../execution/types";
import type { ExitLegRecord, GateResult, MarketAtEntry, SignalRecord, TradeRecord } from "../store/types";

export interface NewTradeInput {
  tradeId: string;
  botId: string;
  runId: string;
  mode: "paper" | "live";
  versionId: string;
  signal: SignalRecord;
  profile: ExitProfile;
  exchange: ExchangeId;
  symbol: string;
  exchangeSymbol: string;
  fill: FillResult;
  expectedPrice: Decimal;
  market: MarketAtEntry;
  gates: GateResult[];
  takerPct: Decimal;
  liqPrice: Decimal;
  slPrice: Decimal;
  tp1Price: Decimal;
  minFillPct: number;
  realFillPrice: Decimal | null;
  leverageVerified: boolean;
  limitsSource: string;
  /** Configured leverage and size share when adaptive entry fitted the trade (profile.leverage is the one used). */
  fit: { requestedLeverage: number; sizePct: number };
}

export function newTradeRecord(i: NewTradeInput): TradeRecord {
  const f = i.fill;
  const avg = f.avgPrice!;
  const notional = avg.mul(f.filledQty);
  const margin = notional.div(i.profile.leverage);
  const slipPct = avg.sub(i.expectedPrice).div(i.expectedPrice).mul(HUNDRED);
  const slipUsd = avg.sub(i.expectedPrice).mul(f.filledQty);
  const fillPct = f.filledQty.div(f.requestedQty).mul(HUNDRED);
  const simGap =
    i.realFillPrice && f.simFillPrice ? f.simFillPrice.sub(i.realFillPrice).div(i.realFillPrice).mul(HUNDRED).toString() : null;
  const p = i.profile;
  return {
    trade_id: i.tradeId,
    bot_id: i.botId,
    run_id: i.runId,
    mode: i.mode,
    strategy_version_id: i.versionId,
    signal_id: i.signal.signal_id,
    variant_id: p.variantId,
    variant_name: p.variantName,
    exchange: i.exchange,
    symbol: i.symbol,
    exchange_symbol: i.exchangeSymbol,
    status: "open",
    timing: {
      signal_time: i.signal.ts,
      order_sent_time: f.sentAt,
      entry_fill_time: f.ts,
      tp1_time: null,
      exit_time: null,
      hold_seconds: null,
      signal_to_fill_ms: f.ts - i.signal.ts,
      source_data_ts: i.signal.latency.source_data_ts,
      detected_ts: i.signal.latency.detected_ts,
      gates_done_ts: i.signal.latency.gates_done_ts,
      order_ack_ts: f.ackTs,
      sl_placed_ts: null,
    },
    data_source: i.signal.data_source,
    signal: i.signal.metrics,
    signal_alt: i.signal.metrics_alt,
    market: i.market,
    config: {
      leverage: p.leverage,
      requested_leverage: i.fit.requestedLeverage,
      size_pct: i.fit.sizePct,
      fitted: i.fit.requestedLeverage !== p.leverage || i.fit.sizePct !== 100,
      basis: p.basis,
      sl_pct: p.slPct,
      tp1_pct: p.tp1Pct,
      tp1_close_pct: p.tp1ClosePct,
      trail_enabled: p.trailEnabled,
      lock_pct: p.lockPct,
      trail_distance_pct: p.trailDistancePct,
      activate_pct: p.activatePct,
      max_hold_hours: p.maxHoldHours,
      trigger_price: p.triggerPrice,
      margin: margin.toString(),
      notional: notional.toString(),
      liq_price: i.liqPrice.toString(),
      sl_price: i.slPrice.toString(),
      tp1_price: i.tp1Price.toString(),
      taker_fee_pct: i.takerPct.toString(),
      leverage_unverified: !i.leverageVerified,
      limits_source: i.limitsSource,
      gates: i.gates,
    },
    execution: {
      client_order_id: f.clientOrderId,
      requested_qty: f.requestedQty.toString(),
      filled_qty: f.filledQty.toString(),
      fill_pct: fillPct.toFixed(4),
      avg_entry_price: avg.toString(),
      expected_price: i.expectedPrice.toString(),
      slippage_pct: slipPct.toFixed(6),
      slippage_usd: slipUsd.toFixed(8),
      entry_fee: f.fee.toString(),
      latency_ms: f.latencyMs,
      sim_fill_price: f.simFillPrice?.toString() ?? null,
      real_fill_price: i.realFillPrice?.toString() ?? null,
      sim_gap_pct: simGap,
      below_min_fill: fillPct.lt(i.minFillPct),
    },
    exit: { reason: null, legs: [] },
    result: { gross_pnl: null, fees: null, funding: "0", net_pnl: null, net_roe_pct: null, net_price_pct: null, r_multiple: null },
    path: { mfe_pct: "0", mae_pct: "0", time_to_mfe_s: null, time_to_mae_s: null, peak_roe: "0", tp1_hit: false },
    after_exit: { chg_15m: null, chg_1h: null, chg_4h: null },
    state: {
      qty_open: f.filledQty.toString(),
      margin_open: margin.toString(),
      sl_price: i.slPrice.toString(),
      sl_roe: (-p.slPct).toString(),
      armed: false,
      tp1_filled: false,
      tp1_skipped: false,
      stop_order_id: null,
      tp1_order_id: null,
      last_tick_ts: f.ts,
      last_funding_ts: f.ts,
      data_gap: false,
      sl_moves: 0,
    },
  };
}

export function legRecord(
  leg: ExitLegRecord["leg"],
  reason: ExitLegRecord["reason"],
  price: Decimal,
  qty: Decimal,
  fee: Decimal,
  ref: Decimal | null,
  time: number,
): ExitLegRecord {
  return {
    leg,
    reason,
    price: price.toString(),
    qty: qty.toString(),
    fee: fee.toString(),
    // sell-side slippage vs trigger / reference: positive = worse
    slippage_pct: ref ? ref.sub(price).div(ref).mul(HUNDRED).toFixed(6) : null,
    time,
    trigger_price: ref?.toString() ?? null,
  };
}

/** Fill in result fields once the position is flat. */
export function finalizeResult(t: TradeRecord): void {
  const entry = D(t.execution.avg_entry_price);
  const margin = D(t.config.margin);
  const r = computePnl({
    entryPrice: entry,
    entryFee: D(t.execution.entry_fee),
    legs: t.exit.legs.map((l) => ({ price: D(l.price), qty: D(l.qty), fee: D(l.fee) })),
    funding: D(t.result.funding),
    margin,
  });
  const notional = D(t.config.notional);
  const risk = margin.mul(t.config.sl_pct).div(HUNDRED).mul(t.config.basis === "price" ? t.config.leverage : 1);
  t.result = {
    gross_pnl: r.gross.toFixed(8),
    fees: r.fees.toFixed(8),
    funding: D(t.result.funding).toFixed(8),
    net_pnl: r.net.toFixed(8),
    net_roe_pct: r.netRoePct.toFixed(4),
    net_price_pct: notional.isZero() ? "0" : r.net.div(notional).mul(HUNDRED).toFixed(6),
    r_multiple: risk.isZero() ? null : r.net.div(risk).toFixed(4),
  };
  t.status = "closed";
  const exitTime = t.exit.legs.length ? t.exit.legs[t.exit.legs.length - 1]!.time : t.timing.entry_fill_time;
  t.timing.exit_time = exitTime;
  t.timing.hold_seconds = Math.round((exitTime - t.timing.entry_fill_time) / 1000);
  t.state.qty_open = "0";
  t.state.margin_open = "0";
}

export const zeroIfNull = (v: string | null): Decimal => (v == null ? ZERO : D(v));
