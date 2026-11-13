import { METRIC_KEYS } from "@oisniper/core";

export interface DictEntry {
  field: string;
  unit: string;
  meaning: string;
}

const METRIC_MEANING: Record<string, [string, string]> = {
  oi_value: ["USD", "Open interest value"],
  price: ["USD", "Last price on CoinGlass"],
  funding_rate: ["% per interval", "Funding rate shown on CoinGlass"],
  ls_ratio: ["ratio", "Long/short account ratio"],
};
function metricMeaning(k: string): [string, string] {
  if (METRIC_MEANING[k]) return METRIC_MEANING[k]!;
  const [, kind, tf] = k.match(/^(oi_chg|vol_chg|price_chg|vol)_(\w+)$/) ?? [];
  if (kind === "oi_chg") return ["%", `Open interest change over ${tf}`];
  if (kind === "vol_chg") return ["%", `Volume change over ${tf}`];
  if (kind === "price_chg") return ["%", `Price change over ${tf}`];
  if (kind === "vol") return ["USD", `Traded volume over ${tf}`];
  return ["", k];
}

const metricEntries = (prefix: string, note: string): DictEntry[] =>
  METRIC_KEYS.map((k) => {
    const [unit, meaning] = metricMeaning(k);
    return { field: `${prefix}${k}`, unit, meaning: `${meaning} (${note}; null = not shown, never 0)` };
  });

const DEPTH = ["0.1", "0.3", "0.5", "1"].flatMap((b) => [
  { field: `market.depth.bid_${b}`, unit: "USDT", meaning: `Bid-side depth within ${b}% of mid at entry` },
  { field: `market.depth.ask_${b}`, unit: "USDT", meaning: `Ask-side depth within ${b}% of mid at entry` },
]);

/** Every exported column: meaning, unit and how it is computed. Kept in sync by test/export.test.ts. */
export const TRADE_DICTIONARY: DictEntry[] = [
  { field: "trade_id", unit: "id", meaning: "Unique trade (one position; Bot 2 = one variant)" },
  { field: "bot_id", unit: "id", meaning: "Bot: paper (Bot 1 Sniper, simulator), real (Bot 1 Sniper, live), test (Bot 2 Research Grid)" },
  { field: "run_id", unit: "id", meaning: "Paper account lifetime between resets, or one live session" },
  { field: "mode", unit: "enum", meaning: "paper or live" },
  { field: "strategy_version_id", unit: "id", meaning: "Immutable config version used at entry (see strategy_versions.json)" },
  { field: "signal_id", unit: "id", meaning: "Signal that opened the trade (see signals.csv)" },
  { field: "variant_id", unit: "id", meaning: "Leverage x trail profile, e.g. 50x-T2 (Bot 1: 50x)" },
  { field: "variant_name", unit: "text", meaning: "Trail profile name (base, Fixed, Breakeven, Lock10, Runner, Early trail)" },
  { field: "exchange", unit: "enum", meaning: "Venue chosen by the router" },
  { field: "symbol", unit: "text", meaning: "CoinGlass base symbol" },
  { field: "exchange_symbol", unit: "text", meaning: "Exchange unified perp symbol (may carry a 1000 multiplier)" },
  { field: "status", unit: "enum", meaning: "open or closed" },
  { field: "timing.signal_time", unit: "epoch ms UTC", meaning: "When the rule matched" },
  { field: "timing.order_sent_time", unit: "epoch ms UTC", meaning: "Entry order sent" },
  { field: "timing.entry_fill_time", unit: "epoch ms UTC", meaning: "Entry fill" },
  { field: "timing.tp1_time", unit: "epoch ms UTC", meaning: "TP1 fill (null if not hit)" },
  { field: "timing.exit_time", unit: "epoch ms UTC", meaning: "Final exit leg" },
  { field: "timing.hold_seconds", unit: "s", meaning: "exit_time - entry_fill_time" },
  { field: "timing.signal_to_fill_ms", unit: "ms", meaning: "entry_fill_time - signal_time (latency target 1.5s warm / 3s cold)" },
  { field: "timing.source_data_ts", unit: "epoch ms UTC", meaning: "Latency stage 1: when the source produced the data (CoinGlass table change / exchange API response)" },
  { field: "timing.detected_ts", unit: "epoch ms UTC", meaning: "Latency stage 2: rule match detected by the engine" },
  { field: "timing.gates_done_ts", unit: "epoch ms UTC", meaning: "Latency stage 3: router + all gates evaluated" },
  { field: "timing.order_ack_ts", unit: "epoch ms UTC", meaning: "Latency stage 5: venue acknowledged the entry order (paper: send + simulated latency)" },
  { field: "timing.sl_placed_ts", unit: "epoch ms UTC", meaning: "Latency stage 7: protective stop accepted by the venue (target: under 500ms after fill)" },
  { field: "data_source", unit: "enum", meaning: "Signal source the trade was taken on: coinglass, exchange (aggregated OI) or exchange:<venue>" },
  { field: "signal.symbol", unit: "text", meaning: "Symbol at signal" },
  ...metricEntries("signal.", "snapshot of the trade's data source at signal"),
  { field: "signal_alt.symbol", unit: "text", meaning: "Symbol in the other data source" },
  ...metricEntries("signal_alt.", "the OTHER data source at signal time (comparison mode)"),
  { field: "market.best_bid", unit: "price", meaning: "Best bid at entry decision" },
  { field: "market.best_ask", unit: "price", meaning: "Best ask at entry decision" },
  { field: "market.spread_pct", unit: "%", meaning: "(ask - bid) / mid" },
  ...DEPTH,
  { field: "market.volume_24h", unit: "USDT", meaning: "Exchange-reported 24h quote volume" },
  { field: "market.range_1m_pct", unit: "%", meaning: "High-low range of the last 60s / mid" },
  { field: "market.mark_price", unit: "price", meaning: "Mark price at entry" },
  { field: "market.index_price", unit: "price", meaning: "Index price at entry" },
  { field: "market.funding_rate", unit: "fraction per interval", meaning: "Exchange funding rate at entry (0.0001 = 0.01%)" },
  { field: "market.next_funding_time", unit: "epoch ms UTC", meaning: "Next funding timestamp (interval differs per symbol)" },
  { field: "market.btc_chg_5m", unit: "%", meaning: "BTC 5m price change on CoinGlass at signal" },
  { field: "market.btc_chg_1h", unit: "%", meaning: "BTC 1h price change on CoinGlass at signal" },
  { field: "config.leverage", unit: "x", meaning: "Leverage used for the trade" },
  { field: "config.requested_leverage", unit: "x", meaning: "Leverage in the strategy config (differs from config.leverage when adaptive leverage fitted the trade)" },
  { field: "config.size_pct", unit: "%", meaning: "Share of the configured margin used (100 unless adaptive size shrank the order)" },
  { field: "config.fitted", unit: "bool", meaning: "Adaptive entry changed leverage or size from the config" },
  { field: "config.basis", unit: "enum", meaning: "TP/SL basis: roe (% of margin) or price (% move)" },
  { field: "config.sl_pct", unit: "% (basis)", meaning: "Initial stop distance" },
  { field: "config.tp1_pct", unit: "% (basis)", meaning: "TP1 distance" },
  { field: "config.tp1_close_pct", unit: "%", meaning: "Share of position closed at TP1" },
  { field: "config.trail_enabled", unit: "bool", meaning: "Trailing after TP1" },
  { field: "config.lock_pct", unit: "% (basis)", meaning: "SL level after TP1 (0 + breakeven = entry + round-trip fees)" },
  { field: "config.trail_distance_pct", unit: "% (basis)", meaning: "SL = peak - distance after TP1, only moves up" },
  { field: "config.activate_pct", unit: "% (basis)", meaning: "Trailing activation without TP1 (Bot 2 T4)" },
  { field: "config.max_hold_hours", unit: "h", meaning: "Force close after (0 = off)" },
  { field: "config.trigger_price", unit: "enum", meaning: "SL/TP trigger source: mark or last" },
  { field: "config.margin", unit: "USDT", meaning: "Isolated margin = filled notional / leverage" },
  { field: "config.notional", unit: "USDT", meaning: "avg_entry_price x filled_qty" },
  { field: "config.liq_price", unit: "price", meaning: "Liquidation price from exchange formula and maintenance tier" },
  { field: "config.sl_price", unit: "price", meaning: "Initial stop price (rounded up to tick)" },
  { field: "config.tp1_price", unit: "price", meaning: "TP1 price (rounded up to tick)" },
  { field: "config.taker_fee_pct", unit: "%", meaning: "Taker fee applied to every fill" },
  { field: "config.leverage_unverified", unit: "bool", meaning: "true = venue limits unknown; max leverage and tiers are the lowest public limit across Bybit/OKX/Gate" },
  { field: "config.limits_source", unit: "enum", meaning: "market, exchange_public, exchange_private (key brackets) or cross_venue_min" },
  { field: "config.gates", unit: "json", meaning: "Gate results [{gate, code, pass, value, limit}] with measured values" },
  { field: "execution.client_order_id", unit: "id", meaning: "Idempotent client order id {bot}-{signal}-{leg}-{n}" },
  { field: "execution.requested_qty", unit: "base qty", meaning: "Qty sent (rounded down to lot)" },
  { field: "execution.filled_qty", unit: "base qty", meaning: "Qty filled" },
  { field: "execution.fill_pct", unit: "%", meaning: "filled / requested" },
  { field: "execution.avg_entry_price", unit: "price", meaning: "VWAP entry fill" },
  { field: "execution.expected_price", unit: "price", meaning: "Best ask when the order was sent" },
  { field: "execution.slippage_pct", unit: "%", meaning: "(avg - expected) / expected, positive = worse" },
  { field: "execution.slippage_usd", unit: "USDT", meaning: "(avg - expected) x filled_qty" },
  { field: "execution.entry_fee", unit: "USDT", meaning: "Taker fee on entry" },
  { field: "execution.latency_ms", unit: "ms", meaning: "Simulated (paper) or measured (live) order latency" },
  { field: "execution.sim_fill_price", unit: "price", meaning: "SimAdapter fill (paper fill, or live shadow sim)" },
  { field: "execution.real_fill_price", unit: "price", meaning: "Exchange fill (live only)" },
  { field: "execution.sim_gap_pct", unit: "%", meaning: "(sim - real) / real, live calibration" },
  { field: "execution.below_min_fill", unit: "bool", meaning: "Fill below min_fill_pct (kept and managed)" },
  { field: "exit.reason", unit: "enum", meaning: "SL, TRAIL, TP_FULL, LIQUIDATION, MAX_HOLD, KILL_SWITCH, MANUAL, DUST_CLOSE, SL_PLACEMENT_FAILED" },
  { field: "exit.legs", unit: "json", meaning: "Exit legs [{leg, reason, price, qty, fee, slippage_pct, time, trigger_price}]" },
  { field: "result.gross_pnl", unit: "USDT", meaning: "sum((exit - entry) x qty)" },
  { field: "result.fees", unit: "USDT", meaning: "Entry + exit fees (incl. liquidation clearance)" },
  { field: "result.funding", unit: "USDT", meaning: "Funding paid (positive) or received (negative)" },
  { field: "result.net_pnl", unit: "USDT", meaning: "gross - fees - funding" },
  { field: "result.net_roe_pct", unit: "%", meaning: "net / margin" },
  { field: "result.net_price_pct", unit: "%", meaning: "net / notional" },
  { field: "result.r_multiple", unit: "R", meaning: "net / initial risk (margin x SL ROE)" },
  { field: "path.mfe_pct", unit: "% price", meaning: "Max favorable excursion (mark) during the trade" },
  { field: "path.mae_pct", unit: "% price", meaning: "Max adverse excursion (mark) during the trade" },
  { field: "path.time_to_mfe_s", unit: "s", meaning: "Seconds from entry to MFE" },
  { field: "path.time_to_mae_s", unit: "s", meaning: "Seconds from entry to MAE" },
  { field: "path.peak_roe", unit: "% ROE", meaning: "Highest ROE reached" },
  { field: "path.tp1_hit", unit: "bool", meaning: "TP1 filled" },
  { field: "after_exit.chg_15m", unit: "%", meaning: "Price change 15m after exit vs final exit price" },
  { field: "after_exit.chg_1h", unit: "%", meaning: "Price change 1h after exit" },
  { field: "after_exit.chg_4h", unit: "%", meaning: "Price change 4h after exit" },
];

export const SIGNAL_DICTIONARY: DictEntry[] = [
  { field: "signal_id", unit: "id", meaning: "Unique signal" },
  { field: "bot_id", unit: "id", meaning: "Bot instance" },
  { field: "run_id", unit: "id", meaning: "Run" },
  { field: "strategy_version_id", unit: "id", meaning: "Config version" },
  { field: "mode", unit: "enum", meaning: "paper or live" },
  { field: "symbol", unit: "text", meaning: "CoinGlass base symbol" },
  { field: "ts", unit: "epoch ms UTC", meaning: "Match time" },
  { field: "snapshot_id", unit: "id", meaning: "Scrape snapshot" },
  { field: "status", unit: "enum", meaning: "opened, rejected, cooldown, or shadow (the non-trading source would have fired; never traded)" },
  { field: "data_source", unit: "enum", meaning: "Source of this signal: coinglass, exchange (aggregated OI) or exchange:<venue>" },
  { field: "latency.source_data_ts", unit: "epoch ms UTC", meaning: "When the source produced the data" },
  { field: "latency.detected_ts", unit: "epoch ms UTC", meaning: "When the rule match was detected" },
  { field: "latency.gates_done_ts", unit: "epoch ms UTC", meaning: "When router + gates finished (null if rejected earlier)" },
  { field: "reject_reasons", unit: "json", meaning: "Reason codes (gate, risk, cooldown)" },
  { field: "exchange", unit: "enum", meaning: "Router venue (null if none)" },
  { field: "rematch_count", unit: "count", meaning: "Consecutive re-matches folded into this signal" },
  { field: "opened_trades", unit: "count", meaning: "Positions opened (Bot 2: variants)" },
  { field: "metrics.symbol", unit: "text", meaning: "Symbol in this signal's data source" },
  ...metricEntries("metrics.", "snapshot of this signal's data source"),
  { field: "metrics_alt.symbol", unit: "text", meaning: "Symbol in the other data source" },
  ...metricEntries("metrics_alt.", "the OTHER data source at the same time (comparison mode)"),
  { field: "rule_results", unit: "json", meaning: "Each rule row: metric, enabled, value, pass" },
  { field: "gate_results", unit: "json", meaning: "Each gate per variant with measured value and limit" },
  { field: "router", unit: "json", meaning: "Router candidates with score, est_cost_pct, penalties, exclusions (BOOK_CROSSED = bid >= ask, BOOK_STALE = older than max book age)" },
  { field: "venue_tries", unit: "json", meaning: "Venues gated in router order (up to 3) [{exchange, pass, codes, leverage, size_pct}]; the first that passes trades. Gate results carry the exchange they ran on" },
  { field: "skipped_variants", unit: "json", meaning: "Variants not opened with the first failing code" },
  { field: "fit.leverage_mode", unit: "enum", meaning: "Adaptive leverage: off (configured leverage only) or fit" },
  { field: "fit.size_mode", unit: "enum", meaning: "Adaptive size: off (configured margin only) or fit" },
  { field: "fit.requested_leverage", unit: "x", meaning: "Configured leverage (null when the signal never reached gates or the bot is a grid)" },
  { field: "fit.leverage", unit: "x", meaning: "Leverage the adaptive search chose (null = nothing passed)" },
  { field: "fit.size_pct", unit: "%", meaning: "Share of configured margin the search chose (null = nothing passed)" },
  { field: "fit.fitted", unit: "bool", meaning: "Leverage or size differs from the config" },
  { field: "fit.attempts", unit: "count", meaning: "Leverage x size combinations evaluated" },
  { field: "fit.requested_fail_codes", unit: "json", meaning: "Gate codes that failed at the configured leverage and size" },
  { field: "fit.stopped_by", unit: "gate", meaning: "Gate no leverage or size can fix (spread, stale book, volume, funding) that ended the search" },
  { field: "cooldown.cause", unit: "enum", meaning: "Cooldown cause: open_position, entry (<12h since entry) or close (<12h since close)" },
  { field: "cooldown.until", unit: "epoch ms UTC", meaning: "When the cooldown ends (null while a position is open)" },
  { field: "counterfactual.ref_price", unit: "price", meaning: "Reference mark at rejection" },
  { field: "counterfactual.chg_15m", unit: "%", meaning: "Price change 15m after rejection" },
  { field: "counterfactual.chg_1h", unit: "%", meaning: "Price change 1h after rejection" },
  { field: "counterfactual.chg_4h", unit: "%", meaning: "Price change 4h after rejection" },
  { field: "counterfactual.first_hit", unit: "enum", meaning: "TP1, SL or NONE: which level would have hit first (30s sampling)" },
  { field: "counterfactual.leverage", unit: "x", meaning: "Leverage used for the counterfactual levels" },
];

export function dictionaryMarkdown(): string {
  const table = (rows: DictEntry[]) =>
    ["| Field | Unit | Meaning |", "|---|---|---|", ...rows.map((r) => `| \`${r.field}\` | ${r.unit} | ${r.meaning} |`)].join("\n");
  return [
    "# OI Sniper v2 Data Dictionary",
    "",
    "Money values are decimal strings computed with decimal.js. Times are UTC epoch ms. Percentages are in percent units (0.05 = 0.05%).",
    "",
    "## trades.csv / trades.jsonl",
    "",
    table(TRADE_DICTIONARY),
    "",
    "`trades.jsonl` additionally contains `events`: the full trade_events timeline (orders, fills, SL moves, errors).",
    "",
    "## signals.csv",
    "",
    table(SIGNAL_DICTIONARY),
    "",
    "`signals.jsonl` holds the same signals as nested JSON, one per line: `gate_results` has every gate of every variant (leverage × trail profile) with measured value and limit, plus `router` candidates, `rule_results`, `skipped_variants` and `counterfactual`.",
    "",
  ].join("\n");
}
