import type { ExchangeId, MetricRow } from "@oisniper/core";

/** Money values are decimal strings. Times are UTC epoch ms. Field names are snake_case (export contract). */
export interface GateResult {
  gate: string;
  code: string;
  pass: boolean;
  value: string | null;
  limit: string | null;
  variant_id?: string;
  /** Venue whose book the gate ran on (absent on signals logged before venue fallback). */
  exchange?: ExchangeId;
}

/** One venue the router ranked and the gates ran on, in order. The first that passes is traded. */
export interface VenueTry {
  exchange: ExchangeId;
  pass: boolean;
  /** Gate / lock codes that failed on this venue (empty when it passed). */
  codes: string[];
  /** Adaptive leverage / size chosen on this venue (null = nothing passed or adaptive off). */
  leverage: number | null;
  size_pct: number | null;
}

/** Adaptive entry outcome for a signal (single-profile bots). Mode "off" = configured leverage and size only. */
export interface FitInfo {
  leverage_mode: "off" | "fit";
  size_mode: "off" | "fit";
  requested_leverage: number | null;
  /** Leverage actually used (null = no trade). */
  leverage: number | null;
  /** Share of the configured margin used (null = no trade). */
  size_pct: number | null;
  /** true when leverage or size differs from the configured values. */
  fitted: boolean;
  attempts: number;
  /** Gate codes that failed at the configured leverage and size (what the fit worked around). */
  requested_fail_codes: string[];
  /** Gate that no leverage or size could fix, when the search stopped early. */
  stopped_by: string | null;
}

export const NO_FIT: FitInfo = {
  leverage_mode: "off", size_mode: "off", requested_leverage: null, leverage: null, size_pct: null, fitted: false,
  attempts: 0, requested_fail_codes: [], stopped_by: null,
};

export interface RouterCandidate {
  exchange: ExchangeId;
  exchange_symbol: string | null;
  score: string | null;
  est_cost_pct: string | null;
  penalty_depth: string | null;
  penalty_latency: string | null;
  rtt_ms: number | null;
  excluded: string | null;
  /** Adaptive leverage only: shortfall penalty and the venue's max leverage (0 = unknown). */
  penalty_leverage?: string;
  max_leverage?: number;
}

export interface MarketAtEntry {
  best_bid: string | null;
  best_ask: string | null;
  spread_pct: string | null;
  depth: Record<string, string>;
  volume_24h: string | null;
  range_1m_pct: string | null;
  mark_price: string | null;
  index_price: string | null;
  funding_rate: string | null;
  next_funding_time: number | null;
  btc_chg_5m: number | null;
  btc_chg_1h: number | null;
}

export interface ExitLegRecord {
  leg: "TP1_PARTIAL" | "EXIT";
  reason: ExitReason;
  price: string;
  qty: string;
  fee: string;
  slippage_pct: string | null;
  time: number;
  trigger_price: string | null;
}

export type ExitReason =
  | "SL"
  | "TP1_PARTIAL"
  | "TRAIL"
  | "TP_FULL"
  | "LIQUIDATION"
  | "MAX_HOLD"
  | "KILL_SWITCH"
  | "MANUAL"
  | "DUST_CLOSE"
  | "SL_PLACEMENT_FAILED"
  | "DELISTED";

export interface TradeRecord {
  trade_id: string;
  bot_id: string;
  run_id: string;
  mode: "paper" | "live";
  strategy_version_id: string;
  signal_id: string;
  variant_id: string;
  variant_name: string;
  exchange: ExchangeId;
  symbol: string;
  exchange_symbol: string;
  status: "open" | "closed";
  timing: {
    signal_time: number;
    order_sent_time: number;
    entry_fill_time: number;
    tp1_time: number | null;
    exit_time: number | null;
    hold_seconds: number | null;
    signal_to_fill_ms: number;
    /** Latency stages (epoch ms). order_sent_time / entry_fill_time above are order_sent_ts / fill_ts. */
    source_data_ts: number;
    detected_ts: number;
    gates_done_ts: number | null;
    order_ack_ts: number;
    sl_placed_ts: number | null;
  };
  /** Snapshot source the trade was taken on. */
  data_source: string;
  signal: MetricRow;
  /** The other source's metrics for the same symbol at signal time. */
  signal_alt: MetricRow | null;
  market: MarketAtEntry;
  config: {
    leverage: number;
    /** Leverage in the strategy config; differs from `leverage` when adaptive leverage fitted the trade. */
    requested_leverage: number;
    /** Share of the configured margin used (100 unless adaptive size shrank the order). */
    size_pct: number;
    /** true when adaptive entry changed leverage or size. */
    fitted: boolean;
    basis: "roe" | "price";
    sl_pct: number;
    tp1_pct: number;
    tp1_close_pct: number;
    trail_enabled: boolean;
    lock_pct: number;
    trail_distance_pct: number;
    activate_pct: number | null;
    max_hold_hours: number;
    trigger_price: "mark" | "last";
    margin: string;
    notional: string;
    liq_price: string;
    sl_price: string;
    tp1_price: string;
    taker_fee_pct: string;
    /** true = max leverage / tiers taken from the lowest public limit on other venues (no own data). */
    leverage_unverified: boolean;
    limits_source: string;
    gates: GateResult[];
  };
  execution: {
    client_order_id: string;
    requested_qty: string;
    filled_qty: string;
    fill_pct: string;
    avg_entry_price: string;
    expected_price: string;
    slippage_pct: string;
    slippage_usd: string;
    entry_fee: string;
    latency_ms: number;
    sim_fill_price: string | null;
    real_fill_price: string | null;
    sim_gap_pct: string | null;
    below_min_fill: boolean;
  };
  exit: { reason: ExitReason | null; legs: ExitLegRecord[] };
  result: {
    gross_pnl: string | null;
    fees: string | null;
    funding: string;
    net_pnl: string | null;
    net_roe_pct: string | null;
    net_price_pct: string | null;
    r_multiple: string | null;
  };
  path: {
    mfe_pct: string;
    mae_pct: string;
    time_to_mfe_s: number | null;
    time_to_mae_s: number | null;
    peak_roe: string;
    tp1_hit: boolean;
  };
  after_exit: { chg_15m: string | null; chg_1h: string | null; chg_4h: string | null };
  /** Live management state (persisted so a restart can resume). */
  state: {
    qty_open: string;
    margin_open: string;
    sl_price: string;
    sl_roe: string;
    armed: boolean;
    tp1_filled: boolean;
    tp1_skipped: boolean;
    stop_order_id: string | null;
    tp1_order_id: string | null;
    last_tick_ts: number;
    last_funding_ts: number;
    data_gap: boolean;
    sl_moves: number;
  };
}

export interface SignalRecord {
  signal_id: string;
  bot_id: string;
  run_id: string;
  strategy_version_id: string;
  mode: "paper" | "live";
  symbol: string;
  ts: number;
  snapshot_id: string | null;
  /** shadow = the other data source would have fired here (comparison mode, never traded). */
  status: "opened" | "rejected" | "cooldown" | "pending" | "shadow";
  reject_reasons: string[];
  exchange: ExchangeId | null;
  rematch_count: number;
  /** Snapshot source the signal came from: coinglass, exchange or exchange:<venue>. */
  data_source: string;
  metrics: MetricRow;
  /** Same symbol from the other source at signal time (null when that source had no row). */
  metrics_alt: MetricRow | null;
  latency: { source_data_ts: number; detected_ts: number; gates_done_ts: number | null };
  rule_results: { metric: string; enabled: boolean; value: number | null; pass: boolean }[];
  gate_results: GateResult[];
  router: RouterCandidate[];
  opened_trades: number;
  skipped_variants: { variant_id: string; code: string }[];
  /** Adaptive leverage / size outcome (absent on signals logged before the feature). */
  fit?: FitInfo;
  /** Venues gated in router order (absent before venue fallback, or when rejected before the router). */
  venue_tries?: VenueTry[];
  /** Set when blocked by cooldown: why and until when (null = until 12h after the open position closes). */
  cooldown?: { cause: "open_position" | "entry" | "close"; until: number | null };
  counterfactual: {
    ref_price: string | null;
    chg_15m: string | null;
    chg_1h: string | null;
    chg_4h: string | null;
    first_hit: "TP1" | "SL" | "NONE" | null;
    leverage: number | null;
  } | null;
}
