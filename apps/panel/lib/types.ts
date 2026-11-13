import type { BotConfig, Kpis } from "@oisniper/core";

export interface OpenRow {
  tradeId: string; botId: string; symbol: string; exchange: string; exchangeSymbol: string; variantId: string; leverage: number;
  entry: string; mark: string | null; qty: string; roePct: string | null; slPrice: string; slRoe: string; tp1Price: string;
  tp1Hit: boolean; liqPrice: string; openedAt: number; unrealized: string | null; armed: boolean;
}
export interface OverviewBot {
  botId: string; name: string; mode: "paper" | "live"; status: string; statusReason: string | null; runId: string;
  startBalance: string | null; totalBalance: string | null; unrealized: string; unlimited: boolean; kpis: Kpis;
  equityCurve: { ts: number; equity: string }[]; open: OpenRow[];
}
export interface StateResp {
  version: string; now: number; killSwitch: boolean; liveRunning: boolean;
  scraper: { status: string; reason: string | null; lastSnapshotTs: number | null; intervalMs: number; source: string; lastHealth: { rowCount: number; parseMs: number; fillRates: Record<string, number>; missingColumns: string[] } | null; mapping: Record<string, string | null> };
  exchangeData?: { status: string; reason: string | null } | null;
  bots: { id: string; name: string; mode: string; status: string; reason: string | null; open: number }[];
}
export interface BotResp {
  id: string; name: string; preset: string; status: string; status_reason: string | null; running: number; current_version_id: string;
  config: BotConfig; run: { id: string; mode: string; start_balance: string | null; cash: string | null; started_at: number };
  runs: { id: string; started_at: number; ended_at: number | null; archived: number; mode: string }[];
  validation: { errors: { code: string; message: string; variantId?: string }[]; warnings: { code: string; message: string; variantId?: string }[] };
  layout: string | null;
}
export interface GateResult { gate: string; code: string; pass: boolean; value: string | null; limit: string | null; variant_id?: string; exchange?: string }
export interface SignalRec {
  signal_id: string; bot_id: string; symbol: string; ts: number; status: string; reject_reasons: string[]; exchange: string | null;
  data_source: string; rematch_count: number; metrics: Record<string, number | null>; gate_results: GateResult[]; opened_trades: number;
  router: { exchange: string; score: string | null; est_cost_pct: string | null; excluded: string | null }[];
  skipped_variants: { variant_id: string; code: string }[];
  cooldown?: { cause: string; until: number | null };
  venue_tries?: { exchange: string; pass: boolean; codes: string[]; leverage: number | null; size_pct: number | null }[];
  fit?: {
    leverage_mode: string; size_mode: string; requested_leverage: number | null; leverage: number | null; size_pct: number | null;
    fitted: boolean; attempts: number; requested_fail_codes: string[]; stopped_by: string | null;
  };
  counterfactual: { chg_15m: string | null; chg_1h: string | null; chg_4h: string | null; first_hit: string | null } | null;
}
export interface TradeRec {
  trade_id: string; bot_id: string; run_id: string; mode: string; variant_id: string; exchange: string; symbol: string; exchange_symbol: string; status: string;
  strategy_version_id: string;
  timing: { signal_time: number; entry_fill_time: number; exit_time: number | null; hold_seconds: number | null; signal_to_fill_ms: number; tp1_time: number | null };
  config: { leverage: number; requested_leverage?: number; size_pct?: number; fitted?: boolean; margin: string; notional: string; liq_price: string; sl_price: string; tp1_price: string; gates: GateResult[] };
  execution: { avg_entry_price: string; slippage_pct: string; entry_fee: string; filled_qty: string; fill_pct: string; latency_ms: number; sim_fill_price: string | null; real_fill_price: string | null };
  exit: { reason: string | null; legs: { leg: string; reason: string; price: string; qty: string; fee: string; slippage_pct: string | null; time: number }[] };
  result: { gross_pnl: string | null; fees: string | null; funding: string; net_pnl: string | null; net_roe_pct: string | null; r_multiple: string | null };
  path: { mfe_pct: string; mae_pct: string; peak_roe: string; tp1_hit: boolean };
  after_exit: { chg_15m: string | null; chg_1h: string | null; chg_4h: string | null };
  signal: Record<string, number | null>;
}
export interface Breakdown { key: string; trades: number; winRatePct: string | null; netPnl: string; profitFactor: string | null; avgRoePct: string | null }
export interface AnalyticsResp {
  trades: number; byExchange: Breakdown[]; byLeverage: Breakdown[]; byHour: Breakdown[]; byOi5m: Breakdown[]; byHold: Breakdown[]; byExitReason: Breakdown[];
  variantMatrix: { leverage: number; variant: string; trades: number; netPnl: string; winRatePct: string | null; profitFactor: string | null; avgRoePct: string | null }[];
}
export interface ExchangeResp {
  exchange: string; needsPassphrase: boolean; testnetAvailable: boolean; markets: number;
  health: { status: string; wsConnected: boolean; rttMs: number | null; clockOffsetMs: number | null; subscriptions: number; error: string | null } | null;
  key: { masked: string; testnet: boolean; status: string; tradeEnabled: boolean; takerPct: string | null; reason: string | null; warnings: string[]; permissions: { read: boolean | null; trade: boolean | null; withdraw: boolean | null; ipWhitelist: boolean | null } | null } | null;
}
