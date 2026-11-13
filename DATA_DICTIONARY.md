# OI Sniper v2 Data Dictionary

Money values are decimal strings computed with decimal.js. Times are UTC epoch ms. Percentages are in percent units (0.05 = 0.05%).

## trades.csv / trades.jsonl

| Field | Unit | Meaning |
|---|---|---|
| `trade_id` | id | Unique trade (one position; Bot 2 = one variant) |
| `bot_id` | id | Bot: paper (Bot 1 Sniper, simulator), real (Bot 1 Sniper, live), test (Bot 2 Research Grid) |
| `run_id` | id | Paper account lifetime between resets, or one live session |
| `mode` | enum | paper or live |
| `strategy_version_id` | id | Immutable config version used at entry (see strategy_versions.json) |
| `signal_id` | id | Signal that opened the trade (see signals.csv) |
| `variant_id` | id | Leverage x trail profile, e.g. 50x-T2 (Bot 1: 50x) |
| `variant_name` | text | Trail profile name (base, Fixed, Breakeven, Lock10, Runner, Early trail) |
| `exchange` | enum | Venue chosen by the router |
| `symbol` | text | CoinGlass base symbol |
| `exchange_symbol` | text | Exchange unified perp symbol (may carry a 1000 multiplier) |
| `status` | enum | open or closed |
| `timing.signal_time` | epoch ms UTC | When the rule matched |
| `timing.order_sent_time` | epoch ms UTC | Entry order sent |
| `timing.entry_fill_time` | epoch ms UTC | Entry fill |
| `timing.tp1_time` | epoch ms UTC | TP1 fill (null if not hit) |
| `timing.exit_time` | epoch ms UTC | Final exit leg |
| `timing.hold_seconds` | s | exit_time - entry_fill_time |
| `timing.signal_to_fill_ms` | ms | entry_fill_time - signal_time (latency target 1.5s warm / 3s cold) |
| `timing.source_data_ts` | epoch ms UTC | Latency stage 1: when the source produced the data (CoinGlass table change / exchange API response) |
| `timing.detected_ts` | epoch ms UTC | Latency stage 2: rule match detected by the engine |
| `timing.gates_done_ts` | epoch ms UTC | Latency stage 3: router + all gates evaluated |
| `timing.order_ack_ts` | epoch ms UTC | Latency stage 5: venue acknowledged the entry order (paper: send + simulated latency) |
| `timing.sl_placed_ts` | epoch ms UTC | Latency stage 7: protective stop accepted by the venue (target: under 500ms after fill) |
| `data_source` | enum | Signal source the trade was taken on: coinglass, exchange (aggregated OI) or exchange:<venue> |
| `signal.symbol` | text | Symbol at signal |
| `signal.oi_value` | USD | Open interest value (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_5m` | % | Open interest change over 5m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_15m` | % | Open interest change over 15m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_30m` | % | Open interest change over 30m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_1h` | % | Open interest change over 1h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_4h` | % | Open interest change over 4h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.oi_chg_24h` | % | Open interest change over 24h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_5m` | USD | Traded volume over 5m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_1h` | USD | Traded volume over 1h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_4h` | USD | Traded volume over 4h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_24h` | USD | Traded volume over 24h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_chg_5m` | % | Volume change over 5m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_chg_1h` | % | Volume change over 1h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_chg_4h` | % | Volume change over 4h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.vol_chg_24h` | % | Volume change over 24h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price` | USD | Last price on CoinGlass (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price_chg_5m` | % | Price change over 5m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price_chg_15m` | % | Price change over 15m (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price_chg_1h` | % | Price change over 1h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price_chg_4h` | % | Price change over 4h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.price_chg_24h` | % | Price change over 24h (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.funding_rate` | % per interval | Funding rate shown on CoinGlass (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal.ls_ratio` | ratio | Long/short account ratio (snapshot of the trade's data source at signal; null = not shown, never 0) |
| `signal_alt.symbol` | text | Symbol in the other data source |
| `signal_alt.oi_value` | USD | Open interest value (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_5m` | % | Open interest change over 5m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_15m` | % | Open interest change over 15m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_30m` | % | Open interest change over 30m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_1h` | % | Open interest change over 1h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_4h` | % | Open interest change over 4h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.oi_chg_24h` | % | Open interest change over 24h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_5m` | USD | Traded volume over 5m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_1h` | USD | Traded volume over 1h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_4h` | USD | Traded volume over 4h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_24h` | USD | Traded volume over 24h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_chg_5m` | % | Volume change over 5m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_chg_1h` | % | Volume change over 1h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_chg_4h` | % | Volume change over 4h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.vol_chg_24h` | % | Volume change over 24h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price` | USD | Last price on CoinGlass (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price_chg_5m` | % | Price change over 5m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price_chg_15m` | % | Price change over 15m (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price_chg_1h` | % | Price change over 1h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price_chg_4h` | % | Price change over 4h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.price_chg_24h` | % | Price change over 24h (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.funding_rate` | % per interval | Funding rate shown on CoinGlass (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `signal_alt.ls_ratio` | ratio | Long/short account ratio (the OTHER data source at signal time (comparison mode); null = not shown, never 0) |
| `market.best_bid` | price | Best bid at entry decision |
| `market.best_ask` | price | Best ask at entry decision |
| `market.spread_pct` | % | (ask - bid) / mid |
| `market.depth.bid_0.1` | USDT | Bid-side depth within 0.1% of mid at entry |
| `market.depth.ask_0.1` | USDT | Ask-side depth within 0.1% of mid at entry |
| `market.depth.bid_0.3` | USDT | Bid-side depth within 0.3% of mid at entry |
| `market.depth.ask_0.3` | USDT | Ask-side depth within 0.3% of mid at entry |
| `market.depth.bid_0.5` | USDT | Bid-side depth within 0.5% of mid at entry |
| `market.depth.ask_0.5` | USDT | Ask-side depth within 0.5% of mid at entry |
| `market.depth.bid_1` | USDT | Bid-side depth within 1% of mid at entry |
| `market.depth.ask_1` | USDT | Ask-side depth within 1% of mid at entry |
| `market.volume_24h` | USDT | Exchange-reported 24h quote volume |
| `market.range_1m_pct` | % | High-low range of the last 60s / mid |
| `market.mark_price` | price | Mark price at entry |
| `market.index_price` | price | Index price at entry |
| `market.funding_rate` | fraction per interval | Exchange funding rate at entry (0.0001 = 0.01%) |
| `market.next_funding_time` | epoch ms UTC | Next funding timestamp (interval differs per symbol) |
| `market.btc_chg_5m` | % | BTC 5m price change on CoinGlass at signal |
| `market.btc_chg_1h` | % | BTC 1h price change on CoinGlass at signal |
| `config.leverage` | x | Leverage used for the trade |
| `config.requested_leverage` | x | Leverage in the strategy config (differs from config.leverage when adaptive leverage fitted the trade) |
| `config.size_pct` | % | Share of the configured margin used (100 unless adaptive size shrank the order) |
| `config.fitted` | bool | Adaptive entry changed leverage or size from the config |
| `config.basis` | enum | TP/SL basis: roe (% of margin) or price (% move) |
| `config.sl_pct` | % (basis) | Initial stop distance |
| `config.tp1_pct` | % (basis) | TP1 distance |
| `config.tp1_close_pct` | % | Share of position closed at TP1 |
| `config.trail_enabled` | bool | Trailing after TP1 |
| `config.lock_pct` | % (basis) | SL level after TP1 (0 + breakeven = entry + round-trip fees) |
| `config.trail_distance_pct` | % (basis) | SL = peak - distance after TP1, only moves up |
| `config.activate_pct` | % (basis) | Trailing activation without TP1 (Bot 2 T4) |
| `config.max_hold_hours` | h | Force close after (0 = off) |
| `config.trigger_price` | enum | SL/TP trigger source: mark or last |
| `config.margin` | USDT | Isolated margin = filled notional / leverage |
| `config.notional` | USDT | avg_entry_price x filled_qty |
| `config.liq_price` | price | Liquidation price from exchange formula and maintenance tier |
| `config.sl_price` | price | Initial stop price (rounded up to tick) |
| `config.tp1_price` | price | TP1 price (rounded up to tick) |
| `config.taker_fee_pct` | % | Taker fee applied to every fill |
| `config.leverage_unverified` | bool | true = venue limits unknown; max leverage and tiers are the lowest public limit across Bybit/OKX/Gate |
| `config.limits_source` | enum | market, exchange_public, exchange_private (key brackets) or cross_venue_min |
| `config.gates` | json | Gate results [{gate, code, pass, value, limit}] with measured values |
| `execution.client_order_id` | id | Idempotent client order id {bot}-{signal}-{leg}-{n} |
| `execution.requested_qty` | base qty | Qty sent (rounded down to lot) |
| `execution.filled_qty` | base qty | Qty filled |
| `execution.fill_pct` | % | filled / requested |
| `execution.avg_entry_price` | price | VWAP entry fill |
| `execution.expected_price` | price | Best ask when the order was sent |
| `execution.slippage_pct` | % | (avg - expected) / expected, positive = worse |
| `execution.slippage_usd` | USDT | (avg - expected) x filled_qty |
| `execution.entry_fee` | USDT | Taker fee on entry |
| `execution.latency_ms` | ms | Simulated (paper) or measured (live) order latency |
| `execution.sim_fill_price` | price | SimAdapter fill (paper fill, or live shadow sim) |
| `execution.real_fill_price` | price | Exchange fill (live only) |
| `execution.sim_gap_pct` | % | (sim - real) / real, live calibration |
| `execution.below_min_fill` | bool | Fill below min_fill_pct (kept and managed) |
| `exit.reason` | enum | SL, TRAIL, TP_FULL, LIQUIDATION, MAX_HOLD, KILL_SWITCH, MANUAL, DUST_CLOSE, SL_PLACEMENT_FAILED |
| `exit.legs` | json | Exit legs [{leg, reason, price, qty, fee, slippage_pct, time, trigger_price}] |
| `result.gross_pnl` | USDT | sum((exit - entry) x qty) |
| `result.fees` | USDT | Entry + exit fees (incl. liquidation clearance) |
| `result.funding` | USDT | Funding paid (positive) or received (negative) |
| `result.net_pnl` | USDT | gross - fees - funding |
| `result.net_roe_pct` | % | net / margin |
| `result.net_price_pct` | % | net / notional |
| `result.r_multiple` | R | net / initial risk (margin x SL ROE) |
| `path.mfe_pct` | % price | Max favorable excursion (mark) during the trade |
| `path.mae_pct` | % price | Max adverse excursion (mark) during the trade |
| `path.time_to_mfe_s` | s | Seconds from entry to MFE |
| `path.time_to_mae_s` | s | Seconds from entry to MAE |
| `path.peak_roe` | % ROE | Highest ROE reached |
| `path.tp1_hit` | bool | TP1 filled |
| `after_exit.chg_15m` | % | Price change 15m after exit vs final exit price |
| `after_exit.chg_1h` | % | Price change 1h after exit |
| `after_exit.chg_4h` | % | Price change 4h after exit |

`trades.jsonl` additionally contains `events`: the full trade_events timeline (orders, fills, SL moves, errors).

## signals.csv

| Field | Unit | Meaning |
|---|---|---|
| `signal_id` | id | Unique signal |
| `bot_id` | id | Bot instance |
| `run_id` | id | Run |
| `strategy_version_id` | id | Config version |
| `mode` | enum | paper or live |
| `symbol` | text | CoinGlass base symbol |
| `ts` | epoch ms UTC | Match time |
| `snapshot_id` | id | Scrape snapshot |
| `status` | enum | opened, rejected, cooldown, or shadow (the non-trading source would have fired; never traded) |
| `data_source` | enum | Source of this signal: coinglass, exchange (aggregated OI) or exchange:<venue> |
| `latency.source_data_ts` | epoch ms UTC | When the source produced the data |
| `latency.detected_ts` | epoch ms UTC | When the rule match was detected |
| `latency.gates_done_ts` | epoch ms UTC | When router + gates finished (null if rejected earlier) |
| `reject_reasons` | json | Reason codes (gate, risk, cooldown) |
| `exchange` | enum | Router venue (null if none) |
| `rematch_count` | count | Consecutive re-matches folded into this signal |
| `opened_trades` | count | Positions opened (Bot 2: variants) |
| `metrics.symbol` | text | Symbol in this signal's data source |
| `metrics.oi_value` | USD | Open interest value (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_5m` | % | Open interest change over 5m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_15m` | % | Open interest change over 15m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_30m` | % | Open interest change over 30m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_1h` | % | Open interest change over 1h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_4h` | % | Open interest change over 4h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.oi_chg_24h` | % | Open interest change over 24h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_5m` | USD | Traded volume over 5m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_1h` | USD | Traded volume over 1h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_4h` | USD | Traded volume over 4h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_24h` | USD | Traded volume over 24h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_chg_5m` | % | Volume change over 5m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_chg_1h` | % | Volume change over 1h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_chg_4h` | % | Volume change over 4h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.vol_chg_24h` | % | Volume change over 24h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price` | USD | Last price on CoinGlass (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price_chg_5m` | % | Price change over 5m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price_chg_15m` | % | Price change over 15m (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price_chg_1h` | % | Price change over 1h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price_chg_4h` | % | Price change over 4h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.price_chg_24h` | % | Price change over 24h (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.funding_rate` | % per interval | Funding rate shown on CoinGlass (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics.ls_ratio` | ratio | Long/short account ratio (snapshot of this signal's data source; null = not shown, never 0) |
| `metrics_alt.symbol` | text | Symbol in the other data source |
| `metrics_alt.oi_value` | USD | Open interest value (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_5m` | % | Open interest change over 5m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_15m` | % | Open interest change over 15m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_30m` | % | Open interest change over 30m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_1h` | % | Open interest change over 1h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_4h` | % | Open interest change over 4h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.oi_chg_24h` | % | Open interest change over 24h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_5m` | USD | Traded volume over 5m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_1h` | USD | Traded volume over 1h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_4h` | USD | Traded volume over 4h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_24h` | USD | Traded volume over 24h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_chg_5m` | % | Volume change over 5m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_chg_1h` | % | Volume change over 1h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_chg_4h` | % | Volume change over 4h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.vol_chg_24h` | % | Volume change over 24h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price` | USD | Last price on CoinGlass (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price_chg_5m` | % | Price change over 5m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price_chg_15m` | % | Price change over 15m (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price_chg_1h` | % | Price change over 1h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price_chg_4h` | % | Price change over 4h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.price_chg_24h` | % | Price change over 24h (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.funding_rate` | % per interval | Funding rate shown on CoinGlass (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `metrics_alt.ls_ratio` | ratio | Long/short account ratio (the OTHER data source at the same time (comparison mode); null = not shown, never 0) |
| `rule_results` | json | Each rule row: metric, enabled, value, pass |
| `gate_results` | json | Each gate per variant with measured value and limit |
| `router` | json | Router candidates with score, est_cost_pct, penalties, exclusions (BOOK_CROSSED = bid >= ask, BOOK_STALE = older than max book age) |
| `venue_tries` | json | Venues gated in router order (up to 3) [{exchange, pass, codes, leverage, size_pct}]; the first that passes trades. Gate results carry the exchange they ran on |
| `skipped_variants` | json | Variants not opened with the first failing code |
| `fit.leverage_mode` | enum | Adaptive leverage: off (configured leverage only) or fit |
| `fit.size_mode` | enum | Adaptive size: off (configured margin only) or fit |
| `fit.requested_leverage` | x | Configured leverage (null when the signal never reached gates or the bot is a grid) |
| `fit.leverage` | x | Leverage the adaptive search chose (null = nothing passed) |
| `fit.size_pct` | % | Share of configured margin the search chose (null = nothing passed) |
| `fit.fitted` | bool | Leverage or size differs from the config |
| `fit.attempts` | count | Leverage x size combinations evaluated |
| `fit.requested_fail_codes` | json | Gate codes that failed at the configured leverage and size |
| `fit.stopped_by` | gate | Gate no leverage or size can fix (spread, stale book, volume, funding) that ended the search |
| `cooldown.cause` | enum | Cooldown cause: open_position, entry (<12h since entry) or close (<12h since close) |
| `cooldown.until` | epoch ms UTC | When the cooldown ends (null while a position is open) |
| `counterfactual.ref_price` | price | Reference mark at rejection |
| `counterfactual.chg_15m` | % | Price change 15m after rejection |
| `counterfactual.chg_1h` | % | Price change 1h after rejection |
| `counterfactual.chg_4h` | % | Price change 4h after rejection |
| `counterfactual.first_hit` | enum | TP1, SL or NONE: which level would have hit first (30s sampling) |
| `counterfactual.leverage` | x | Leverage used for the counterfactual levels |

`signals.jsonl` holds the same signals as nested JSON, one per line: `gate_results` has every gate of every variant (leverage × trail profile) with measured value and limit, plus `router` candidates, `rule_results`, `skipped_variants` and `counterfactual`.
