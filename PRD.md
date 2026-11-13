# OI Sniper v2: Product Requirements Document

> Local-first crypto futures trading bot with a Vercel-hosted control panel.
> Signals from CoinGlass (scraped locally). Execution on Binance, Bybit, OKX, Gate.io, KuCoin and MEXC.
> Two modes: **Paper** (exchange-grade simulation) and **Live** (real orders with user API keys).
> Free, no accounts, no paywall, no backend.

| Field | Value |
|---|---|
| Version | 2.0 |
| Owner | Abu Sufian |
| Status | Ready to build |
| Market | USDT-margined perpetual futures |
| Direction (V1) | Long only (short is a config field, disabled until V2) |

---

## 1. Goals and Non-Goals

### Goals
1. Anyone opens the Vercel panel, runs a local agent once and trades from their own device. Keys, data and scraping never leave the device.
2. Paper mode behaves like a real exchange: real order books, real fees, real funding, real latency, partial fills, liquidation and rejection rules.
3. Paper and Live share **one code path**. Only the execution adapter differs.
4. Two bots run in parallel with independent accounts, settings and history.
5. Every signal and trade is logged with enough context that an AI can find better settings from the export alone.
6. Clean, Apple-style UI with a fully customizable strategy builder.

### Non-Goals (V1)
- Accounts, login, cloud sync, payments or a hosted backend
- Short trades (schema supports it, UI hides it)
- Spot trading, grid/DCA bots, copy trading
- Mobile app (panel is responsive, that is enough)
- Historical backtester (V2; the logged data is designed to feed it)

---

## 2. Gaps Found in the Brief and Fixes

These are decisions made in this PRD. Each one changes the build, so read them first.

| # | Gap or conflict | Why it matters | Fix in this PRD |
|---|---|---|---|
| 1 | **TP/SL 20% "of entry" at 50x** | At 50x a long is liquidated after a ~1.6% price drop. A 20% price SL can never trigger; the position is liquidated first. Your example ($1 entry, SL $0.80, TP $1.20) only works at ≤4x. | TP/SL basis is a setting: **ROE % (default)** or **Price %**. ROE matches what exchanges show as PnL %. Validator rejects any config where SL sits beyond the liquidation price. UI shows the live conversion (e.g. "20% ROE = 0.40% price at 50x, liq at -1.61%"). |
| 2 | **Fees at high leverage** | Round-trip taker fees ≈ 0.10% of notional. At 50x that is 5% ROE, at 100x it is 10% ROE: half of a 20% TP. | Cost-to-target gate (Section 8). Every trade logs fees in $ and ROE so you can see this in the data. |
| 3 | **"SL Trail 30%" definition** | Ambiguous. | Formalized as **lock level + trail distance** (Section 7). Your example maps exactly: TP1 +20%, lock SL at +10%, then trail 10 points behind the peak. |
| 4 | **Sell % after TP1** has no Bot 1 default | Required to run. | Default **50%**. |
| 5 | **Fund per trade** missing for Bot 1 | Required to size orders. | Default **10% of balance as margin**, max 5 open positions. |
| 6 | "Volume (1H)" listed twice | Typo. | Volume timeframes: **5m, 1h, 4h, 24h** (all collected; any can be used in rules). |
| 7 | **Bot 2 "Unlimited fund"** and **multiple leverages / trails** | Impossible in Live. One-way futures accounts hold one position per symbol, so 35 variants of BTC cannot coexist. | Bot 2 is a **Research Grid**: in Paper it opens one virtual position per (leverage × trail variant) for each signal. In Live it runs **one** variant the user picks, with a capital cap. |
| 8 | **Two live bots on one account** | Both buying the same symbol merges into one position and corrupts both bots' accounting. | Symbol lock per exchange account across bots. Recommend one sub-account (separate API key) per live bot. |
| 9 | **OKX** listed for data but not for live trading | Inconsistent. | OKX added to live (needs API passphrase). |
| 10 | **MEXC futures API** | MEXC suspended futures place/cancel endpoints for regular users for long periods (most recently Dec 2025 to Apr 2026). Innovation Zone pairs are still excluded. | Capability probe at connect time. If order endpoints fail, MEXC stays data + paper only and the UI says why. |
| 11 | **Bot runs on a laptop** | Sleep, Wi-Fi drops or a closed lid leaves a high-leverage position unmanaged. | Live mode always places an **exchange-native reduce-only stop** immediately after fill. Trailing moves that order. Agent reconciles on restart and blocks system sleep while positions are open. |
| 12 | **Vercel panel talking to a local bot** | Chrome 142+ and Brave gate public-site → localhost requests behind a permission prompt; Safari is stricter. | Panel uses `fetch(..., { targetAddressSpace: "loopback" })` to trigger the prompt with clear onboarding copy. Fallback: the agent serves the same panel at `http://localhost:7777` (no prompt needed). |
| 13 | **"No setup" is impossible** | Code running on the user's device must be installed once. | V1: one-line installer (PowerShell / shell) + `npx` package. V2: signed Windows installer with tray icon and auto-start. |
| 14 | **CoinGlass scraping** | Not an API: layout changes break it, Cloudflare may challenge it and their ToS may prohibit automated access. | Header-mapped DOM parsing (never column position), selector health checks, stale-data kill switch, visible-browser mode so the user can clear a challenge once. Optional exchange-OI cross-check (off by default). Personal-use, low frequency. |
| 15 | **Missing safety rails** | Real money. | Kill switch, max daily loss, max drawdown halt, max open positions, symbol blacklist, live-mode confirmation, API key permission check (no withdrawals). |
| 16 | **Missing tuning data** | "Profit/loss" alone cannot tell you what to change. | Log MFE/MAE, time to TP1, price path after exit, rejected signals with reasons and counterfactual outcome, config version per trade. |
| 17 | **Contract sizes differ** | OKX, Gate, KuCoin and MEXC trade in contracts with multipliers; Binance/Bybit in base units. `PEPE` on CoinGlass is `1000PEPE` on Binance. | Symbol mapper + contract-size normalization in one module with tests. |
| 18 | **Funding fees** | Ignored funding makes paper PnL optimistic on held positions. | Paper applies real funding at each funding timestamp. |
| 19 | **Paper reset deletes learning data** | You lose the data you want to analyze. | Reset **archives** the current run and starts a new one. History stays exportable per run. |

---

## 3. Architecture

### 3.1 Overview

```
┌──────────────────────────── User's browser ────────────────────────────┐
│  Panel (Next.js static export)                                          │
│  served from Vercel  OR  from the agent at http://localhost:7777        │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket to 127.0.0.1:7777 (pairing token)
┌───────────────▼──────────────────── User's device ─────────────────────┐
│  Local Agent (Node 22, single process)                                  │
│                                                                         │
│  CoinGlass Scraper ──► Signal Engine ──► Pre-Trade Gates ──► Router     │
│   (Playwright)          (rules, cooldown)  (liquidity, cost)  (venue)   │
│                                                              │          │
│  Market Data Hub ◄──── ccxt (REST + WS) ────────────────────►│          │
│   books, trades, mark, funding, fees, limits                 ▼          │
│                                              Execution Adapter          │
│                                              ├─ SimAdapter  (Paper)     │
│                                              └─ LiveAdapter (Live)      │
│                                                     │                   │
│  Position Manager (TP1, trailing, SL) ◄─────────────┘                   │
│  Risk Manager (limits, kill switch)                                     │
│  Store (SQLite)   Key Vault (OS keychain + AES-GCM)   API server        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Principles
- **Vercel hosts static files only.** No serverless functions, no database, no analytics that could see trading data.
- **The agent is the source of truth.** All settings, keys, history and state live in the agent's SQLite file.
- **One engine, two adapters.** Signal, gates, sizing, position management and logging are identical in Paper and Live. Only `ExecutionAdapter` changes.
- **Lean.** One process, typed in-memory event bus, SQLite. No Redis, no queues, no microservices.
- **Bots are instances.** The engine supports N bot instances. V1 ships two presets: Bot 1 "Sniper" and Bot 2 "Research Grid".

### 3.3 Signal-to-order flow

1. Scraper refreshes CoinGlass every `scrape_interval` (default 30s) and emits a `MetricsSnapshot` for all symbols.
2. Signal Engine evaluates each bot's rules. Matches become `Signal` records (logged even if later rejected).
3. Cooldown and risk checks run (cheap, local).
4. Router picks the venue (Section 10). Market Data Hub subscribes to that symbol's L2 book if not already subscribed.
5. Gates run on fresh book data (Section 8). Failures are logged with reason codes.
6. Sizing computes qty with exchange rounding and limits.
7. Execution adapter places the entry. On fill, Position Manager places SL (Live: exchange-native) and starts tracking.
8. Every state change writes a `trade_event`.

**Latency target:** scrape parsed → order sent ≤ 1.5s (book already warm) or ≤ 3s (cold subscribe).

---

## 4. Panel ↔ Agent Connection and Security

### 4.1 Install and pair
1. User opens the panel. If no agent is detected, the onboarding screen shows the one-line installer for Windows / macOS / Linux.
2. Agent starts, binds **127.0.0.1:7777 only**, prints a 6-word pairing phrase and opens the panel URL with `?pair=<token>`.
3. Panel stores `agentUrl` + `token` in `localStorage`. Every request sends `Authorization: Bearer <token>`.
4. Panel triggers the browser's local-network permission with `fetch(agentUrl + "/health", { targetAddressSpace: "loopback" })` and shows a guide if denied.
5. Fallback link: "Open panel locally" → `http://localhost:7777`.

### 4.2 Agent HTTP rules
- CORS allowlist: the Vercel production origin, `http://localhost:7777`, `http://127.0.0.1:7777`.
- Respond to preflight with `Access-Control-Allow-Private-Network: true`.
- Reject requests without a valid token (constant-time compare). Rotate token from Settings.
- Realtime: WebSocket `/ws` (opened after the first successful fetch). Fallback: SSE, then 2s polling.

### 4.3 API keys
- Stored encrypted (AES-256-GCM). Data key lives in the OS keychain (`@napi-rs/keyring`); fallback is a user passphrase via scrypt.
- Never returned to the panel (masked `abcd••••wxyz` only). Never logged. Never sent anywhere except the exchange.
- On connect: validate key, read permissions where the exchange exposes them. **Refuse keys with withdrawal permission.** Warn if no IP whitelist.
- Required permissions: read + futures trade.

### 4.4 Multi-user
"Multiple people" means each person runs their own agent and opens the same panel URL. There is no shared state and no server. Strategy presets can be shared as JSON files (export/import).

---

## 5. Data Sources

### 5.1 CoinGlass scraper (signals)

| Requirement | Spec |
|---|---|
| Engine | Playwright Chromium, persistent profile in agent data dir |
| Mode | Headless by default; "Show browser" toggle for clearing a Cloudflare challenge once |
| Method | Keep the page open, re-read the rendered table on an interval. Do not reload unless stale. Map columns by **header text**, never by index. If the page's own network responses are readable JSON, parse those instead (faster, sturdier). |
| Interval | 30s default (min 15s, max 120s) |
| Metrics collected (all symbols, always) | OI value $; OI change % 5m, 15m, 30m, 1h, 4h, 24h; Volume $ and change % 5m, 1h, 4h, 24h; Price; Price change % 5m, 15m, 1h, 4h, 24h; Funding rate (if shown); Long/short ratio (if shown) |
| Missing timeframe | Stored as `null`, never `0`. Rules on a `null` metric evaluate false. |
| Health | Each snapshot records parse time, row count and per-column fill rate. If row count drops > 50% or a required column is missing → status `DEGRADED`, new entries paused, open positions keep being managed. |
| Staleness | Snapshot older than `2 × interval` → no new entries |
| Storage | Raw snapshots kept 7 days (rolling) for debugging and backfill of trade context |

### 5.2 Exchange market data (execution realism)

Public endpoints only, via ccxt (REST + WebSocket):

| Data | Use |
|---|---|
| Markets: tick size, lot size, min notional, contract size, max leverage | Sizing and validation |
| Leverage / risk-limit tiers (maintenance margin) | Liquidation price, max position size |
| L2 order book (WS, 50+ levels) | Depth, spread, slippage, fills |
| Trades stream | Trigger detection, wick handling |
| Mark price + index price | SL triggers and liquidation (mark) |
| Funding rate + next funding time | Gates and paper funding charges |
| Taker / maker fees | Base tier from market info; Live uses the account's real tier |
| 24h ticker | Volume filter |
| Server time | Clock offset and latency measurement |

Book subscriptions are on-demand: a symbol is subscribed when it becomes a candidate and kept while a position is open, plus a "warm set" of the top 30 symbols by CoinGlass OI change to keep latency low.

### 5.3 Symbol mapping
- One `SymbolMapper` maps CoinGlass base symbol → each exchange's unified perp symbol (`BTC` → `BTC/USDT:USDT`, `PEPE` → `1000PEPE/USDT:USDT` on Binance).
- Detect multiplier prefixes (`1000`, `10000`, `1M`) and verify by price ratio against CoinGlass price (±2%). Mismatch → symbol excluded and logged.
- Manual overrides editable in Settings.

---

## 6. Strategy Engine

### 6.1 Rule builder (UI and schema)

Each metric row: `enabled` toggle, operator (`≥`, `≤`, `between`), value(s).

| Group | Metrics |
|---|---|
| Open Interest change % | 5m, 15m, 30m, 1h, 4h, 24h |
| Volume change % | 5m, 1h, 4h, 24h |
| Price change % | 5m, 15m, 1h, 4h, 24h |
| Extra filters | Min OI value $, min 24h volume $, max funding rate, symbol whitelist / blacklist, min listing age (days) |

V1 logic: all enabled rows are combined with AND. Disabled rows are still collected and logged. Optional rule groups ("at least N of these rows") replace the AND for the rows they contain; rows outside a group stay AND-ed.

### 6.2 Strategy versioning
Every save creates an immutable `strategy_version` (hash of the config). Every signal and trade stores the version id. Exports include all versions used.

### 6.3 Cooldown (your 12h rule)
A bot will **not** open a trade on symbol S if:
- it has an open position on S (any exchange), **or**
- its last entry on S was less than `cooldown_hours` ago (default **12**), measured from entry time.

Scope: per bot, per base symbol, across all exchanges. Persisted in SQLite so restarts do not reset it. Bot 2's grid counts as one entry per signal.

### 6.4 Signal dedupe
A symbol that keeps matching on consecutive scrapes produces one signal per cooldown window. Re-matches are counted on the signal record (`rematch_count`).

---

## 7. Position Management

### 7.1 TP/SL basis

| Basis | Meaning | Example (entry $1.000, 50x) |
|---|---|---|
| **ROE % (default)** | % of margin, what the exchange shows as PnL % | +20% ROE = +0.40% price = $1.0040 |
| Price % | % move in price | +20% price = $1.20 (only valid at ≤4x for a 20% SL) |

Validator (blocks Save and Start):
- `SL price > liquidation price + liq_buffer` (default buffer: 25% of the distance from entry to liq).
- Warn when `round-trip fees ≥ 30% of TP1`.

### 7.2 Exit logic

| Field | Meaning | Bot 1 default |
|---|---|---|
| `sl_pct` | Initial stop | 20 |
| `tp1_pct` | First target | 20 |
| `trail_enabled` | Trailing after TP1 | true |
| `tp1_close_pct` | % of position closed at TP1 (100 if trail off) | 50 |
| `lock_pct` | SL moves here when TP1 hits | +10 |
| `trail_distance_pct` | After TP1, SL = peak − distance (only moves up) | 10 |
| `breakeven_fees` | If lock is 0, place SL at entry + fees | true |
| `max_hold_hours` | Force close (0 = off) | 0 |
| `trigger_price` | `mark` or `last` | mark |

**Your "30% trail" mapped:** SL starts at -20%, moves up 30 points to +10% when TP1 hits, then trails 10 points behind the highest point reached.

**Worked example (Bot 1, ROE basis, 50x, $50 margin, $2,500 notional, entry $1.0000):**

| Event | ROE | Price | Action |
|---|---|---|---|
| Entry | 0% | 1.0000 | SL placed at 0.9960 |
| Liquidation (est.) | -80% | 0.9839 | Never reached; SL is above it |
| TP1 | +20% | 1.0040 | Close 50%, SL → 1.0020 (+10%) |
| Peak | +35% | 1.0070 | SL → 1.0050 (+25%) |
| Pullback | +25% | 1.0050 | Remaining 50% closed |
| Fees | ≈ -5% | | 0.05% taker × 2 sides on notional |

### 7.3 Live mode protection
- After the entry fill: place reduce-only **stop-market** SL on the exchange (trigger by mark price) and reduce-only TP1 order for `tp1_close_pct`.
- Trailing: amend or cancel-replace the exchange stop when SL should move. Throttle: max 1 update per 2s per position, only if it moves ≥ 1 tick.
- If the SL order fails to place: retry 3x within 2s, then **market-close the position** and alert. A live position without an exchange stop must never exist for more than 3 seconds.
- On agent start: reconcile positions and open orders with every connected exchange before doing anything else. Unknown positions are shown as "external" and never touched.

---

## 8. Pre-Trade Gates (Paper and Live, every trade)

Gates scale with leverage by expressing price limits as a share of the TP1 price distance (`tp1_dist`). At 50x with TP1 20% ROE, `tp1_dist` = 0.40%.

| Gate | Check | Bot 1 default |
|---|---|---|
| Data freshness | CoinGlass snapshot ≤ 2 × interval; book update ≤ 2s old | on |
| Spread | `(ask - bid) / mid` | ≤ 0.2% (was 0.05%, changed 2026-11-10) |
| Entry depth | Ask-side $ within 0.3% of mid ≥ N × order notional | N = 5 (was 20, changed 2026-11-10) |
| Exit depth | Bid-side $ within 0.3% of mid ≥ N × order notional (proves you can sell) | N = 5 (was 20, changed 2026-11-10) |
| Entry slippage | VWAP of walking the asks for full qty vs best ask | ≤ 0.2% (was 0.05%, changed 2026-11-10) |
| Cost to target | (round-trip fees + est. entry slip + est. exit slip) / `tp1_dist` | ≤ 40% |
| Chase guard | Price move since signal snapshot / `tp1_dist` | ≤ 50% |
| Volatility | Last 1m high-low range / `tp1_dist` (avoids entering into a spike that wicks through SL) | ≤ 300% |
| 24h volume | Exchange-reported | ≥ $10M |
| Funding | Current rate for longs | ≤ 0.10% per interval |
| Leverage available | Symbol max leverage ≥ requested and size within tier | must pass |
| Liquidation buffer | Per Section 7.1 | must pass |
| Min notional / lot | After rounding, qty > 0 and notional ≥ min | must pass |
| Risk limits | Section 11 | must pass |

Every failed gate writes a `signal` row with `status = rejected` and `reject_reasons[]` plus the measured values, so you can loosen or tighten gates from data.

---

## 9. Execution

### 9.1 Order style (both modes)
Entry and market exits are sent as **limit IOC** at `best price ± max_slippage` (a protected market order). Unfilled remainder is cancelled. If filled qty < `min_fill_pct` (default 80%) the partial position is kept and managed normally; if below min notional it is closed.

### 9.2 Paper: exchange simulator (SimAdapter)

The simulator must produce the same fills, fees and failures a real account would.

| Mechanic | Spec |
|---|---|
| Book | Live L2 book from the chosen exchange, kept in a ring buffer of timestamped snapshots (last 10s) |
| Latency | Fill evaluated against the book at `t_send + latency`, where latency = measured one-way RTT to that exchange (EWMA) + 50ms processing. Configurable override. |
| Fill | Walk the book level by level, VWAP price, respecting the IOC price cap. Partial fills when depth runs out. |
| Self-impact | Within one order, consumed levels are removed. Across orders, the book is assumed to refill (documented limitation). |
| Fees | Taker fee on every fill. Default = exchange base tier; user can set their VIP tier per exchange. |
| Funding | At each funding timestamp: `notional_at_mark × funding_rate`, longs pay positive rates |
| Mark price | From exchange mark price stream; used for unrealized PnL, SL trigger (if `mark`) and liquidation |
| SL / TP trigger | Evaluated on every mark / trade tick, not candles. On trigger, exit is simulated as stop-market: walk bids at `t_trigger + latency`. Gaps fill at the real book price, not the stop price. |
| Liquidation | Exchange-specific formula with maintenance-margin tiers. If mark crosses liq before SL: position liquidated, margin lost, liquidation fee charged. |
| Exchange rules | Tick / lot rounding, min notional, max leverage, tier max size, reduce-only. Violations reject with the same error codes the live adapter maps to. |
| Balance | Isolated margin. Margin + entry fee reserved on open. Insufficient balance rejects. |
| Outages | If the exchange WS for a position disconnects > 5s, mark position `DATA_GAP`; on reconnect, replay trades in the gap to check if SL / TP was crossed. |

**Calibration (shadow sim):** in Live mode, the SimAdapter also computes the fill it *would* have produced for every live order. The log stores `sim_fill_price` vs `real_fill_price`. The dashboard shows the average gap so you can prove paper is realistic.

### 9.3 Live: LiveAdapter

| Requirement | Spec |
|---|---|
| Library | ccxt (unified REST + WS) |
| Exchanges | Binance USDT-M, Bybit linear, OKX swap, Gate.io USDT futures, KuCoin Futures, MEXC contract (if capability probe passes) |
| Account setup per symbol | Isolated margin, one-way position mode, set leverage, before the first order |
| Idempotency | Client order id = `{bot}-{signalId}-{leg}-{n}`; retries reuse it |
| Rate limits | Per-exchange token bucket; ccxt `enableRateLimit` on |
| Clock | Sync server time every 10 min; use `recvWindow` where supported |
| Errors | Map exchange errors to internal codes (`INSUFFICIENT_MARGIN`, `MIN_NOTIONAL`, `PRICE_FILTER`, `REDUCE_ONLY_REJECTED`, `RATE_LIMIT`, `MAINTENANCE`, ...) |
| Fills | From private WS order/fill stream; REST poll fallback every 3s |
| Balance | "Start balance" = available USDT in futures wallet when the live run starts. `max_capital` caps what the bot may use. |
| Testnets | Integration tests run against Binance futures testnet, Bybit testnet and OKX demo trading |

### 9.4 Live mode activation
- User selects exchanges, enters keys, passes validation.
- Start requires a confirmation dialog: exchange(s), max capital, leverage, per-trade margin and typing `LIVE`.
- Persistent red/orange "LIVE" banner on every page while any live bot runs.

---

## 10. Exchange Router

For "Exchange: ALL" (Bot 1) the router scores every enabled exchange that lists the perp:

```
score = est_total_cost_pct (fees + entry slip + exit slip)
       + penalty_depth (if depth < 2x gate requirement)
       + penalty_latency (RTT above 300ms)
```

Lowest score wins. Live mode only considers exchanges with connected, healthy keys and enough free margin. The chosen venue and every candidate's score are logged.

---

## 11. Risk Controls (per bot)

| Control | Default Bot 1 | Default Bot 2 (paper) |
|---|---|---|
| Max open positions | 5 | unlimited |
| Max positions per symbol | 1 | one grid per 15 min entry (grids stack while open) |
| Max daily loss | 15% of day-start balance → pause until next UTC day | off |
| Max drawdown from peak equity | 40% → stop bot | off |
| Max capital (Live) | required field | required field |
| Consecutive loss pause | 5 losses → pause 1h | off |
| Kill switch | Global button: stop all bots, cancel orders, market-close all positions (asks confirmation) | same |
| Sleep guard | Prevent OS sleep while any position is open | same |

---

## 12. Bot 1: "Sniper" (default preset)

| Setting | Default |
|---|---|
| Direction | Long |
| OI change 5m | ≥ 2% |
| Price change 5m | ≥ 0.02% |
| Volume change 1h | ≥ 40% |
| All other metrics | collected, rule disabled |
| Leverage | 50x |
| TP/SL basis | ROE % |
| SL | 20% |
| TP1 | 20%, close 50% |
| Trailing | on, lock +10%, distance 10 |
| Paper initial funds | $500 |
| Margin per trade | 10% of balance (alt: fixed $) |
| Exchanges | ALL (router) |
| Cooldown | 12h |
| Gates | Section 8 defaults |

---

## 13. Bot 2: "Research Grid"

Purpose: take every signal and test many leverage and exit combinations at once so the data shows which combination wins.

| Setting | Default |
|---|---|
| Direction | Long |
| Rules | At least 3 of OI change 5m, 15m, 30m, 1h, 4h > 0%, and at least 1 of Volume change 5m, 1h, 4h > 0%. Price rules off (still collected). |
| Leverage set | 5x, 10x, 15x, 20x, 30x, 50x |
| TP/SL basis | ROE % |
| TP / SL | 20% / 20% |
| Margin per variant | $100 |
| Paper funds | Unlimited (equity tracked from $0 as cumulative PnL) |
| Exchange | ALL (router picks one venue per signal; all variants fill on it) |
| Cooldown | 15 min per symbol from the last entry; re-enters even while that symbol's positions are open (paper only) |
| Gates | Section 8, evaluated per leverage (a variant failing the cost gate is skipped and logged) |

**Trail variants (each runs at every leverage, so 6 × 5 = 30 virtual positions per signal):**

| Id | Name | TP1 close | Lock after TP1 | Trail distance |
|---|---|---|---|---|
| T0 | Fixed | 100% | n/a | n/a |
| T1 | Breakeven | 50% | 0% + fees | 10 |
| T2 | Lock10 (Bot 1 style) | 50% | +10% | 10 |
| T3 | Runner | 25% | +5% | 15 |
| T4 | Early trail | 0% (activate at +10%) | +2% | 8 |

- Variants that exceed the symbol's max leverage are skipped with `LEVERAGE_UNAVAILABLE`.
- Fills for all variants are simulated against the same book snapshot as independent orders (each walks the book on its own).
- Dashboard adds a **variant matrix**: rows = leverage, columns = trail variant, cells = net PnL, win rate, profit factor, avg ROE.
- **Live mode:** user picks exactly one leverage + one trail variant and sets `max_capital`. Grid is paper only.

---

## 14. Panel and UI

### 14.1 Design language
- Apple-style: system font stack (`-apple-system, "SF Pro Text", Inter, sans-serif`), neutral grays, one accent color, 14 to 20px radii, soft shadows, translucent blurred top bar, generous spacing.
- Light and dark themes, follows OS by default.
- Controls: segmented controls, toggles, steppers on numeric inputs, inline helper text that shows live conversions ("= 0.40% price", "liq -1.61%", "fees 5% ROE").
- Mode badge on every bot: **PAPER** (blue) or **LIVE** (red/orange + top banner).
- Motion: subtle (150 to 250ms), respects `prefers-reduced-motion`.
- Numbers use tabular figures. Green / red plus +/- sign (not color only).

### 14.2 Pages

| Page | Contents |
|---|---|
| **Overview** | Bot switcher (Bot 1, Bot 2, All). KPI cards: Total Balance, Start Balance, Net PnL $ and %, Unrealized PnL, Trades (W/L), Win Rate, Profit Factor, Expectancy per trade, Max Drawdown, Fees paid, Funding paid, Avg slippage, Avg sim-vs-real gap (Live). Equity curve (PnL graph) with range selector. Open positions table with live ROE, SL, TP1, liq price, time in trade. |
| **Bots** | One tab per bot: Start / Stop, mode (Paper / Live), strategy rule builder, exits, leverage, sizing, gates, risk limits, exchanges, cooldown. Save creates a version. "Reset stats" (paper) archives the run. Import / export preset JSON. |
| **Signals** | Live feed of matches: symbol, metrics, status (opened / rejected / cooldown), reject reasons with measured values. Filter by bot and reason. |
| **History** | Trade table with filters (bot, run, exchange, symbol, leverage, variant, result, date). Row expands to full detail and event timeline. Export button. |
| **Analytics** | Breakdowns: by exchange, by leverage, by hour of day, by OI 5m bucket, by holding time, by exit reason. Bot 2 variant matrix. |
| **Exchanges** | Connect keys per exchange, status, permissions found, fee tier, latency, capability (trade enabled or not). |
| **Health** | Agent version, uptime, CoinGlass scraper status (last parse age, rows, column fill), WS status per exchange, clock offset, error log. |
| **Settings** | Agent URL and token, theme, dashboard layout, scrape interval, symbol mapping overrides, data folder, notifications. |

### 14.3 Customization
- Overview cards can be shown, hidden and reordered (drag). Layout saved in the agent per bot.
- Columns in History and Signals tables can be toggled.

### 14.4 Notifications (P1)
Optional Telegram bot token + chat id: trade opened, TP1, closed, gate-blocked streak, scraper degraded, kill switch, live SL placement failure.

---

## 15. Logging and Export

### 15.1 Trade record (both modes, all fields stored)

| Group | Fields |
|---|---|
| Identity | trade_id, bot_id, run_id, mode, strategy_version_id, signal_id, variant_id (Bot 2), exchange, symbol, exchange_symbol |
| Timing | signal_time, order_sent_time, entry_fill_time, tp1_time, exit_time, hold_seconds, signal_to_fill_ms |
| Signal snapshot | OI value; OI change 5m, 15m, 30m, 1h, 4h, 24h; Volume and change 5m, 1h, 4h, 24h; Price and change 5m, 15m, 1h, 4h, 24h; funding; long/short ratio. **All timeframes always**, even unused ones. |
| Market at entry | best bid, best ask, spread %, depth $ at ±0.1/0.3/0.5/1% both sides, 24h volume, 1m range, mark price, index price, funding rate, next funding time, BTC 5m and 1h change |
| Config at entry | leverage, basis, sl, tp1, tp1_close, lock, trail distance, margin, notional, liq price, gates and their measured values |
| Execution | requested qty, filled qty, fill %, avg entry price, expected price, slippage % and $, entry fee, latency used, sim_fill_price (Live), real_fill_price (Live) |
| Exit | exit reason (`SL`, `TP1_PARTIAL`, `TRAIL`, `TP_FULL`, `LIQUIDATION`, `MAX_HOLD`, `KILL_SWITCH`, `MANUAL`), each exit leg's price, qty, fee, slippage |
| Result | gross PnL $, fees $, funding $, net PnL $, net ROE %, net price % , R multiple |
| Path | MFE % and MAE % (max favorable / adverse excursion), time to MFE, time to MAE, peak ROE, did TP1 hit |
| After exit | Price change at +15m, +1h, +4h after exit (filled in by a background job) to judge early or late exits |
| Events | Full `trade_events` timeline: orders, fills, SL moves, errors |

### 15.2 Signal record
Every match, including rejected ones: metrics snapshot, gate results with measured values, router scores, status, reject reasons. For rejected signals (paper and live), a background job records **counterfactual** price change at +15m, +1h, +4h and whether TP1 or SL would have hit first. This tells you whether a gate is saving you or costing you.

### 15.3 Export ("AI Analysis Pack")
One click from History → `oisniper-export-<bot>-<run>-<date>.zip`:

| File | Contents |
|---|---|
| `trades.csv` | One flat row per trade (nested fields flattened with dot notation) |
| `trades.jsonl` | Full nested records incl. events |
| `signals.csv` | All signals incl. rejected and counterfactuals |
| `strategy_versions.json` | Every config version referenced |
| `summary.json` | KPIs for the selection |
| `DATA_DICTIONARY.md` | Every column: meaning, unit, how it is computed |
| `ANALYSIS_PROMPT.md` | Ready-to-paste prompt asking an AI to find better thresholds, leverage and exits from these files |

Filters apply to the export (date range, bot, run, mode, exchange).

---

## 16. Edge Cases

| Case | Handling |
|---|---|
| CoinGlass layout change | Header mapping fails → `DEGRADED`, entries paused, alert |
| Cloudflare challenge | Scraper reports `CHALLENGE`; user clicks "Show browser" and solves once |
| Same coin pumps on 3 exchanges | One trade (cooldown is per base symbol) |
| Symbol delisted / settling | Exclude symbols with status not `trading`; close open paper positions at last book; live positions alerted |
| Exchange maintenance | Router skips it; open positions keep exchange SL; alert |
| Price gaps through SL | Fill at real book price after trigger (paper and live) |
| Agent crash / PC reboot | Live: exchange SL protects; reconcile on start. Paper: resume, replay missed trades from exchange REST to resolve SL/TP during downtime |
| Partial fill below min notional | Close remainder immediately, log as `DUST_CLOSE` |
| TP1 qty below min lot | Skip partial, keep full position, trailing still activates |
| Leverage not allowed | Clamp is **off**; skip with reason (clamping silently changes risk) |
| Funding timestamp while position open | Charged in paper, read from exchange in live |
| Clock drift > 1s | Resync; block live orders until synced |
| Both bots signal same symbol (live, same account) | First bot locks it; second logs `SYMBOL_LOCKED` |
| User edits strategy while positions open | Open positions keep the version they opened with; new entries use the new version |
| Browser closed | Agent keeps running; panel only displays |
| Multiplier symbols (`1000PEPE`) | Mapper + price-ratio check; mismatch → excluded |

---

## 17. Tech Stack and Repo Layout

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces |
| Panel | Next.js (App Router, `output: "export"`), TypeScript, Tailwind CSS, shadcn/ui, Framer Motion, TanStack Query, Zustand, TradingView `lightweight-charts`, dnd-kit |
| Agent | Node 22 LTS, TypeScript, Fastify + `@fastify/websocket`, ccxt, Playwright, better-sqlite3 + Drizzle ORM, zod, decimal.js, pino |
| Shared | `packages/core`: zod schemas, types, strategy evaluation, liq / fee / slippage math (used by agent and by panel for live previews) |
| Tests | Vitest; order-book fixtures; testnet integration suite |
| Packaging | V1: npm package + PowerShell / shell installer; agent serves built panel from `/`. V2: Windows installer + tray |

```
oisniper/
├─ apps/
│  ├─ panel/                 # Next.js static export (Vercel)
│  └─ agent/
│     ├─ src/
│     │  ├─ api/             # Fastify routes, ws, auth
│     │  ├─ scraper/         # CoinGlass (Playwright)
│     │  ├─ market/          # ccxt hub, books, mark, funding
│     │  ├─ symbols/         # mapper + contract normalization
│     │  ├─ engine/          # signal engine, cooldown, sizing
│     │  ├─ gates/           # pre-trade checks
│     │  ├─ router/          # venue scoring
│     │  ├─ execution/       # SimAdapter, LiveAdapter, shared interface
│     │  ├─ positions/       # TP1, trailing, SL lifecycle
│     │  ├─ risk/            # limits, kill switch, sleep guard
│     │  ├─ store/           # drizzle schema, migrations, repos
│     │  ├─ vault/           # key encryption
│     │  └─ export/          # zip builder, data dictionary
│     └─ test/
└─ packages/
   └─ core/                  # schemas, math, strategy eval
```

### Agent data directory
`%APPDATA%\oisniper` (Windows), `~/Library/Application Support/oisniper` (macOS), `~/.local/share/oisniper` (Linux): `oisniper.db`, `browser-profile/`, `logs/`, `exports/`.

---

## 18. Milestones and Acceptance Criteria

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold + pairing | Panel on Vercel detects a local agent, pairs with token, passes the browser permission flow; localhost fallback works |
| M1 | Data layer | Scraper produces snapshots every 30s with all metrics mapped by header; health page shows fill rates; symbol mapper covers top 200 symbols across 6 exchanges with tests |
| M2 | Paper engine + Bot 1 | Signals, cooldown, gates, router, SimAdapter, position manager and logging work end to end; unit tests for liq price, fees, VWAP fills, trailing; dashboard KPIs and equity curve live |
| M3 | Bot 2 grid + analytics + export | 35 variants per signal, variant matrix, AI Analysis Pack export validated by opening the zip |
| M4 | Live adapters | Binance and Bybit on testnet first, then OKX demo, then Gate, KuCoin, MEXC (probe). Exchange-native SL verified by killing the agent mid-trade on testnet |
| M5 | Hardening | Reconcile on restart, kill switch, risk limits, Telegram alerts, sim-vs-real calibration report |

### Global acceptance tests
1. Paper and Live run the same engine code; a test asserts only the adapter differs.
2. A trade on a thin book is rejected by the depth gate with logged values.
3. Simulated fill for a fixture book matches hand-calculated VWAP to 1e-8.
4. A config with SL beyond liquidation cannot be saved.
5. After `kill -9` of the agent with a testnet position open, the exchange stop is still in place and the agent reconciles on restart.
6. No API secret appears in logs, exports, panel responses or the browser.

---

## 19. Open Questions

1. Default exchange fee tier: base tier for everyone, or should users enter their VIP tier at setup?
2. Telegram alerts in V1 or V2?
3. Short mode: same rules mirrored, or separate rule set (earlier plan said separate settings)?
