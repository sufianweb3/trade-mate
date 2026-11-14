# Trade Mate Super App — design

Status: draft for approval · 2026-11-14 · scope: first launch (crypto perpetual futures only)

## 1. Intent

Turn Trade Mate from "a window around the OI Sniper bot" into one desktop app where a crypto trader can see their
portfolio, chart any coin, read market data (open interest, liquidations, funding), paste a TradingView Pine Script,
backtest it, and let it trade automatically on their own exchange account. Everything runs on the user's computer;
keys and trades never leave it.

**Who it is for:** traders, not programmers. They know candles, indicators, leverage and stop-losses and live in
TradingView. They paste Pine Script far more often than they write it. "Easy" means familiar screens, plain words,
and safe defaults: a mistake must not be able to empty an account.

**Why:** today a trader juggles TradingView (charts, scripts), an exchange app (portfolio, orders), CoinGlass (OI,
liquidations) and a bot. Trade Mate puts those in one place, on their own machine, with their own keys.

## 2. Goals (first launch)

1. **Home**: total balance across connected exchanges, today's change, open positions, running bots, balance over
   time (1D / 1W / 1M / All), breakdown by exchange and by coin, recent bot activity.
2. **Charts**: TradingView-like candle chart for any listed crypto perpetual futures pair: timeframes 1m–1D, indicators, drawing tools,
   watchlist, quick-trade panel, OI / liquidations / funding at a glance, the user's positions and bot trades marked
   on the chart.
3. **Markets**: table of coins with price, open interest, OI change (1h / 4h), liquidations (1h), funding, top movers;
   click a coin to open it on Charts.
4. **Lab** (editor-first, like TradingView's Pine editor): script list, code editor, Backtest bar. Holds strategies,
   indicators and Pine Script. Pine Script pasted from TradingView runs without edits where the runtime supports it.
5. **Backtest** in one click on real exchange history with fees and slippage: net profit, win rate, worst drawdown,
   number of trades, equity curve, trades marked on the chart.
6. **Bots**: run a Lab strategy as a bot in the mode the user chooses: Backtest, Paper (real-time, simulated fills) or
   Live. The user decides; Paper is not required before Live.
   The existing OI Sniper bot appears here as one bot (its current panel, unchanged).
7. **Connections**: add an exchange by pasting API key + secret (+ passphrase where needed) with a guided check:
   permissions, balance read, clock. Keys with withdrawal permission are refused.
8. **Speed**: prices stream live from exchanges; strategy decisions run in the same local process that sends orders;
   every stage is timed and visible.

## 3. Non-goals (first launch)

- Spot trading (spot balances are shown on Home, but bots and quick trade are perpetual futures only).
- Stocks, forex and other brokers. The design must let them be added later without a rewrite, but nothing is built
  for them now.
- Copy trading / publishing strategies to other users (switched off for this version; see §10).
- Accounts, logins, payments, any cloud server.
- Writing strategies in languages other than Pine Script (a JavaScript strategy API is a later milestone).
- "Describe your strategy in words" / AI generation.
- Mobile app.

## 4. Anti-goals (would be a failure even if it works)

- Any key, balance, position or trade leaving the computer.
- A script able to bypass risk limits or the mandatory stop-loss.
- The new code breaking, slowing or changing the existing OI Sniper bot.
- Two engines silently trading the same coin on the same account.
- A screen that needs the user to understand the engine's internals (gates, adapters, tokens) to use it.
- Silent clamping: if an order, size or leverage cannot be placed as asked, the bot says why (CLAUDE.md rule 5).

## 5. Constraints

- **Existing system untouched**: `apps/agent`, `apps/panel`, `packages/core` are not modified. New code may import
  pure functions from `packages/core`.
- **CLAUDE.md safety rules apply to the new engine too**: localhost-only with bearer token (rule 7), no secrets in
  logs / responses / exports (rule 2), exchange-native reduce-only stop within 3 s or market-close (rule 3), no
  bypass flags (rule 4), no silent clamping (rule 5), no withdrawal keys (rule 6), `decimal.js` money math (rule 8),
  testnet integration test before any live order path merges (rule 9).
- **Free data only**: public exchange REST / WebSocket APIs. Known limit: Binance's liquidation stream sends at most
  one liquidation per coin per second, so liquidation totals are a sample, labelled as such.
- **Desktop**: Windows and macOS installers via the existing Trade Mate release flow (`docs/RELEASING.md`).
- **"0 latency" is physically impossible**: the target is that Trade Mate adds no meaningful delay of its own
  (see §7.6); network and exchange time dominate and are shown.

## 6. Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| 1 | **New engine beside the old one**: a second local process for the new features; OI Sniper agent keeps running unchanged and shows up as one bot | Existing bot is safe from new bugs; keys are entered again; must prevent both engines trading one account | **Chosen by the user** |
| 2 | Grow the existing agent with new modules | One engine, one key vault, one symbol lock; but changes the system the user asked to keep, every release risks the working bot | Rejected |
| 3 | Cloud backend | Adds latency, keys and trades leave the computer | Ruled out |

## 7. Design

### 7.1 Parts

```
Trade Mate (Electron, apps/desktop)          existing shell, gains new sidebar tabs
├── Studio UI (new, apps/studio)              React UI for Home, Charts, Markets, Lab, Bots, Connections
├── Engine (new, apps/engine)                 Node process on 127.0.0.1:7788, bearer token, own SQLite
│     market data · portfolio · Pine runtime · backtester · bot runner · execution · risk
└── OI Sniper agent (unchanged)               127.0.0.1:7777, shown under Bots → "OI Sniper"
```

- The desktop supervisor (`AgentSupervisor`) gets a second instance for the engine: same start / restart / adopt /
  stop / confirm-before-quit behaviour. Quit and update confirmations count open positions across both engines.
- Studio UI is served by the engine (like the agent serves the panel) and shown in the shell's content area as a
  second panel view. It talks to the engine over HTTP + one WebSocket on localhost.
- Engine data folder: `%APPDATA%\trademate` / `~/Library/Application Support/trademate` (separate from `oisniper`).

### 7.2 Navigation (left sidebar, chosen layout A)

Home · Charts · Markets · Lab · Bots · Connections, then Updates · Support · About at the bottom (existing pages).
"Dashboard" (the OI Sniper panel) moves under Bots → OI Sniper.

### 7.3 Screens

- **Home** — as in the approved mockup: three summary cards (total balance + today's change, open positions +
  unrealized PnL, bots running + this week's PnL), balance-over-time chart, by-exchange, holdings, recent activity.
  Paper accounts shown separately from real money, clearly labelled. OI Sniper's accounts, positions and PnL are
  included read-only from the agent's API (builder's call). Exchanges do not return past balances, so the balance
  chart starts when a key is added (Trade Mate snapshots balances every 5 minutes from then on).
- **Charts** — layout A mockup: watchlist, chart with timeframe bar and Indicators menu, quick-trade panel (Buy/Long,
  Sell/Short with size, leverage and stop-loss fields; stop-loss required for live), OI / liquidation / funding
  strip, bottom panel with positions, orders and bot trades on this chart. Lab indicators are added from here.
- **Markets** — approved mockup: tabs Open interest · Liquidations · Funding · Top movers; table summed across
  exchanges; click → Charts.
- **Lab** — editor first (choice B): script list (strategies, indicators, templates), Pine editor with syntax
  highlighting and inline errors in plain language ("`request.security` is not supported yet, line 12"), Backtest
  bar (pair, timeframe, period, capital, fees on). Results panel: net, win rate, worst drawdown, trades, equity curve,
  "show on chart".
- **Bots** — list of bots with mode (Backtest / Paper / Live), status, PnL, open positions; Start / Stop; per-bot
  risk settings; OI Sniper as a bot entry opening its existing panel.
- **Connections** — add / test / remove exchange keys; masked display; permission check; which bots use which key.

UI rules (from CLAUDE.md, applied to Studio): shadcn/ui + Tailwind tokens, tabular numbers, every value with +/− sign
and colour, states for loading / empty / error / engine disconnected / live mode banner.

### 7.4 Market data

- Live: candles and tickers over exchange WebSockets via ccxt (watch* methods), books for symbols with running bots.
- History: candles from exchange REST, cached in SQLite, filled forward from the stream.
- Open interest: exchange REST, polled per exchange within its rate limits, aggregated in USD.
- Liquidations: exchange WebSocket streams (Binance `!forceOrder@arr`, Bybit and OKX equivalents), labelled as sampled
  where the exchange samples.
- Funding: current rate and `nextFundingTime` per symbol (never assume 8h).
- Exchanges for launch: the six the agent already supports (Binance, Bybit, OKX, Gate, KuCoin, MEXC); MEXC as data +
  paper only when its order endpoints are down (same rule as the agent).

### 7.5 Lab: Pine runtime and backtester

- Runtime runs Pine v5 / v6 strategies and indicators in a worker thread with no file, network or process access.
  A script only produces plots and order intents; it never touches the exchange.
- Backtester: bar-by-bar, TradingView-style fills (market orders fill at next bar open by default, honouring
  `strategy()` settings where supported), exchange fee schedule and slippage from `packages/core`, funding applied
  for perpetuals.
- Results stored per script version; scripts are versioned and a saved version is never changed (same rule as bot
  configs).
- Runtime: LuxAlgo PineTS (AGPL-3.0), chosen by the user. Trade Mate is therefore published under AGPL-3.0: a
  `LICENSE` file is added in milestone 3 and the installers ship the licence and a link to the source.

### 7.6 Bots, execution, risk

- One bot = one strategy version + pair(s) + timeframe + mode + risk settings + exchange key.
- **Paper**: fills simulated on the live order book (VWAP math from `packages/core`), fees and funding applied.
- **Live** is the user's choice at any time (no Paper-first rule, decided by the user). Turning on Live needs: a
  validated key, max capital and stop-loss set, and typing `LIVE` (same pattern as the agent). The Live screen shows
  whether this strategy version was ever backtested or paper-traded, as information, not a lock.
- **Always on, cannot be switched off by a script or setting**: exchange-native reduce-only stop on every live
  position within 3 s (else market-close), per-bot max capital, max leverage, daily loss limit, kill switch,
  one position per symbol per account (one-way mode).
- **Two-engine safety** (builder's call, safer option): the unchanged agent does not expose which account its keys
  belong to (`GET /api/exchanges` returns masked keys only), so the engine cannot prove two keys are different
  accounts. Rules:
  1. The engine reads the agent's open positions (`GET /api/positions`, token held by the desktop) and refuses any
     Live order on a symbol the agent holds on the same exchange, whatever the account.
  2. If the agent has a validated Real key for an exchange, Live in the engine on that exchange needs a key with a
     different masked key *and* the user ticking "this key belongs to a different account or sub-account". The
     agent cannot see the engine's positions, so this is the only protection for the reverse direction; it is
     shown plainly.
  3. Connections recommends a separate sub-account for Trade Mate bots.
- **How a Pine strategy meets the mandatory rules** (builder's call): the script decides *when* to enter and exit;
  the bot's settings decide *how much* and the protective stop.
  - Size per trade comes from the bot's settings (fixed USDT or % of the bot's capital); the script's `qty` /
    `default_qty_type` is shown in the Lab but not used for live sizing. Shown on the bot screen, never silent.
  - Every bot has a stop-loss setting (required). If the script also exits by stop, the closer one wins. The same
    bot settings are applied in the backtest, so backtest and live run the same rules.
  - An order that would break a limit (max capital, leverage, loss limit) is rejected with a reason in the bot log
    and on screen; it is never scaled down quietly.
  - Pyramiding adds to the one position per symbol; a long→short reversal is close then open.
  - The protective stop is always an exchange-native reduce-only order. Take-profits and trailing stops from
    `strategy.exit` are managed by the engine, which moves the exchange stop (same pattern as the agent's trailing).
- **When strategies run**: on each closed bar by default (matching Pine and the backtest); scripts with
  `calc_on_every_tick=true` run on every tick live. Stops and trailing are checked on every tick regardless.
- **Latency**: decisions on stream events in memory; orders over exchange WebSocket order APIs where ccxt supports
  them, REST otherwise. Target: under 20 ms inside Trade Mate from the triggering event (bar close or tick) to
  order sent, measured per stage (event → strategy → risk → order sent → ack → fill → stop placed) and shown
  under Support.
- **Quick-trade panel on Charts** (builder's call): manual orders, Paper or Live like an exchange app. Uses account-wide limits set per connection (max leverage, max
  order size, daily loss limit); stop-loss required for Live; counts toward the two-engine symbol rules above.

### 7.7 Security

- Keys in the OS keychain (as the agent does), never in SQLite, logs, API responses or exports.
- Engine binds 127.0.0.1, bearer token on every route but `/health`; token handed to the Studio view by the desktop
  app (same automatic pairing as the agent).
- Redaction test covering the engine, Studio API and logs.

## 8. Milestones (each its own plan, PR and release)

1. **Charts + Markets** — engine skeleton, supervisor for 2 engines, Studio shell + sidebar, market data, Charts
   (no trading), Markets.
2. **Connections + Home** — key vault and wizard, portfolio sync, balance history, Home.
3. **Lab** — Pine runtime, editor, backtester, results on chart, indicators on Charts.
4. **Bots** — Paper bots, then Live bots (testnet integration tests first), quick-trade panel on Charts, two-engine
   safety, latency panel.

## 9. Left to the builder

- Chart library (KLineChart, Apache-2.0, has drawing tools built in; or TradingView Lightweight Charts, Apache-2.0,
  already used by the panel, needs drawing tools added). Pick by drawing-tool coverage and Pine plot support.
- Code editor component (Monaco or CodeMirror) and Pine syntax highlighting.
- Exact OI polling intervals per exchange within rate limits.
- Internal module layout of `apps/engine` (follow CLAUDE.md: files under ~300 lines, one execution interface with a
  paper and a live adapter).

## 10. Decisions by the user

1. **Pine runtime**: LuxAlgo PineTS; Trade Mate becomes open source under AGPL-3.0 (anyone may copy and redistribute
   it under the same licence).
2. **Market**: crypto perpetual futures only for launch.
3. **Paper before Live**: not required; the user chooses Backtest, Paper or Live for each bot.
4. **Copy trading**: off for this version; strategy code and signals stay local so it can be added later.
5. **Layout**: left sidebar (A); Lab editor-first (B); Home and Markets as in the mockups.
6. **Architecture**: new engine beside the unchanged OI Sniper agent (approach 1).
