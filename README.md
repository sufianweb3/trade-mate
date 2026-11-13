# OI Sniper v2

Local-first crypto futures bot. Static panel (Next.js export) + a trading agent on your own machine.
Signals from CoinGlass (scraped locally), execution through ccxt on Binance, Bybit, OKX, Gate, KuCoin, MEXC.
Spec: [PRD.md](PRD.md). Working rules: [CLAUDE.md](CLAUDE.md). Choices made where the PRD was open: [docs/decisions.md](docs/decisions.md).
Desktop app (Windows + macOS installer): [apps/desktop](apps/desktop/README.md). Versioning and releases: [docs/RELEASING.md](docs/RELEASING.md).

## For users: install in 3 steps (Windows and Mac, nothing else to install)

Each person runs their own copy on their own computer, with their own data and CoinGlass login. Nothing is shared.

1. Download the zip for your computer:
   - Windows: `OI-Sniper-windows.zip`
   - Mac with Apple chip (M1-M4): `OI-Sniper-mac-apple-silicon.zip`
   - Older Intel Mac: `OI-Sniper-mac-intel.zip` (Apple menu → About This Mac shows which chip you have)
2. Unzip it and move the "OI Sniper" folder somewhere permanent (for example Documents).
3. Double-click **Start OI Sniper** (Mac: **Start OI Sniper.command**). Your browser opens the panel, already connected.
   - Windows, first time only: "Windows protected your PC" → More info → Run anyway.
   - Mac, first time only: System Settings → Privacy & Security → "Open Anyway" (or right-click the file → Open).

In the panel, the **Get started** card offers two choices: log in to CoinGlass once (needs Google Chrome or Brave),
or use free exchange data (no account). Then press **Start** for Paper and/or Test. Keep the window open while bots run;
close it to stop. To update, replace the folder: data stays in `%APPDATA%\oisniper` / `~/Library/Application Support/oisniper`.
`READ ME FIRST.txt` inside the zip says the same in plain words.

## For you: making the zips

```bash
pnpm build
```
```bash
pnpm package
```

Writes `release/OI-Sniper-windows.zip`, `-mac-apple-silicon.zip`, `-mac-intel.zip` (about 52-59 MB each, ~10 files; the app is packed in `app.tgz`, which the launcher unpacks on first start, about a minute): the official Node
runtime (same version as the tests, SHA-256 checked against nodejs.org), the agent, the panel, production dependencies for
that platform, the Microsoft C++ runtime DLLs (Windows) and a launcher. Share them via Google Drive, Dropbox, etc.
Mac zips are built on Windows and checked for the right binaries, but have not been run on a Mac yet: test one first.

## Running from source (Windows)

```powershell
.\scripts\start-agent.ps1
```
Starts the built agent from this folder (needs Node.js 22.5+ and pnpm; run `pnpm install` and `pnpm build` once).

## Quick start (developers)

```bash
pnpm install
pnpm --filter agent exec playwright install chromium
pnpm build
pnpm --filter agent start
```

The agent binds `127.0.0.1:7777`, prints a 6-word pairing phrase and a "Pair this browser" link, and opens it.
If the browser does not open, copy that link from the terminal.

## Using it

- **Three bots**, each with its own account, history and settings:
  **Paper** (Bot 1 Sniper on the exchange simulator), **Real** (Bot 1 Sniper, real orders), **Test** (Bot 2 research grid, simulator).
- All bots are **Stopped** after install and after every agent restart. Open positions keep being managed while stopped.
- **Overview**: Start / Stop each bot. Stop asks whether to keep managing open positions (default) or close them.
- **Header Paper / Real** and the **Paper / Real / Test** selector on each page choose which account you see
  (Overview, Signals, History, Analytics, Export).
- **Settings**: General, Paper Trade Settings, Real Trade Settings, Test Settings. Every save is a new version;
  Paper and Real settings never affect each other.
- **Signals** shows the per-symbol cooldown (open position, or under 12h since the last entry or close) and why each signal was rejected.
- **Real** needs: max capital set in Real Trade Settings, a validated key on Exchanges (no withdrawal permission), and typing `LIVE`.
  Real mode has not been verified on a testnet yet: do not use it with money until `pnpm test:testnet` passes.
- **Signal Data Source** (per bot, in its settings): CoinGlass or Exchange (free public exchange APIs; OI scope Aggregated
  or Trade venue only). Both are always collected; the other one is logged as shadow signals. Analytics → CoinGlass vs Exchange.
- **CoinGlass**: one-time setup via Health → Show browser (opens Brave/Chrome/Edge with the bot's profile): log in, then
  Customize → turn on OI Change 5m/15m/30m/1h/4h, Volume (1h%)/(4h%)/(24h%), Price Change 5m/1h/4h → Save. The login is kept.
  CoinGlass blocks frequent automated loads; the scraper backs off and never works around it.
- **Health** shows latency p50/p95 per stage (source → detected → gates → order → ack → fill → stop).
- **Windows**: needs the Microsoft Visual C++ 2015-2022 Redistributable (x64) for the OS keychain, and a synced clock
  (live orders are blocked above 0.5 s offset).

## Start script

```powershell
.\scripts\start-agent.ps1                       # agent + panel on http://localhost:7777
.\scripts\start-agent.ps1 -PanelOrigin https://your-panel.vercel.app
```

## Demo (no exchange, no CoinGlass)

```bash
pnpm demo:scenarios
```

Runs the full agent (real parser, engine, gates, router, SimAdapter, position manager, SQLite, API, export)
through two simulated trading days on a virtual clock with synthetic order books for 6 venues.
Writes `.demo-data/scenarios/DEMO_REPORT.md` and two AI Analysis Pack zips in `.demo-data/scenarios/exports/`.

```bash
pnpm demo
```

Real-time demo: agent + panel on `http://localhost:7777` with a scripted market (a coin pumps every 50s).

## Layout

| Path | What |
|---|---|
| `packages/core` | zod schemas, presets, rule eval, ROE/price, liquidation, fees, VWAP, sizing, trailing state machine, validator, KPIs |
| `apps/agent/src/engine` | bot instances, signal pipeline, cooldown, dedupe |
| `apps/agent/src/gates`, `router` | pre-trade gates, venue scoring |
| `apps/agent/src/execution` | `ExecutionAdapter`, `SimAdapter` (paper), `LiveAdapter` (ccxt) - the only mode-specific code |
| `apps/agent/src/positions` | TP1, lock, trailing, exchange stop lifecycle, restore |
| `apps/agent/src/market` | ccxt hub (public data), book ring buffer, per-exchange quirks |
| `apps/agent/src/scraper` | CoinGlass Playwright source, header-mapped parser, health |
| `apps/agent/src/export` | AI Analysis Pack zip, data dictionary |
| `apps/panel` | Overview, Bots, Signals, History, Analytics, Exchanges, Health, Settings |

## Status

- Paper and Test (research grid): ready. Run on live CoinGlass and live exchange data (Nov 2026: 2 x 30 min sessions plus
  smoke runs), simulated fills on real order books, plus `pnpm demo:scenarios` and the unit tests.
- CoinGlass: live, logged in, columns mapped by header, push on table change, backs off on blocks.
- Exchange data source: live on Binance, Bybit, OKX, Gate, KuCoin (OI in USD, 4h backfill).
- Real mode: **on hold, not verified**. Real start is blocked until the Real Mode Readiness checklist is green, which needs
  `pnpm test:testnet` to pass with testnet keys in `.env.testnet` and a clock within 0.5 s. Do not trade real money before.
- Known limits: detection → order sent is network-bound (~1-4 s) for coins not already on the near-trigger watchlist;
  Paper's default gates reject most thin, fast movers (by design).
- Telegram alerts: deferred (see decisions).
