# CLAUDE.md: OI Sniper v2

Local-first crypto futures bot. Static panel on Vercel, trading agent on the user's device. Real money is involved. Read `PRD.md` before any feature work; it is the spec. If this file and the PRD disagree, the PRD wins and you flag it.

## Project at a glance
- `apps/panel`: Next.js static export (`output: "export"`). Deployed to Vercel. Also served by the agent at `http://localhost:7777`.
- `apps/agent`: Node 22 TypeScript single process. Scrapes CoinGlass, streams exchange data, runs bots, places orders, stores everything in SQLite.
- `packages/core`: zod schemas, shared types, strategy evaluation, liquidation / fee / slippage / sizing math. Pure functions, no I/O.

## Commands
```bash
pnpm install
pnpm dev                 # panel (3000) + agent (7777) together
pnpm --filter agent dev
pnpm --filter panel dev
pnpm test                # vitest, all packages
pnpm test:testnet        # live adapter integration tests (needs testnet keys in .env.testnet)
pnpm typecheck
pnpm lint
pnpm build               # panel export + agent bundle
pnpm db:generate         # drizzle migration from schema changes
pnpm --filter agent exec playwright install chromium
```

## Non-negotiable safety rules
1. **Never** send API keys, secrets, balances or trade data to Vercel or any third party. The panel is static. No Next.js API routes, no server actions, no analytics SDKs.
2. **Never** log, return or export an API secret. Panel only ever sees masked keys. Run the redaction test after touching `vault/`, `api/` or logging.
3. **Never** let a live position exist without an exchange-native reduce-only stop for more than 3 seconds. If placing it fails after retries, market-close the position.
4. **Never** bypass pre-trade gates, cooldown or risk limits in any mode. No "skip checks" flags, even for debugging. Use paper mode.
5. **Never** silently clamp leverage, size or prices. Reject with a reason code and log it.
6. **Never** accept API keys with withdrawal permission.
7. Agent binds `127.0.0.1` only and requires the bearer token on every route except `GET /health`.
8. Money math uses `decimal.js` in `packages/core`. Convert to numbers only at the UI edge. No float arithmetic on prices, qty, fees or PnL.
9. Live order code paths need a testnet integration test before merge.

## Architecture rules
- **One engine, two adapters.** Signal engine, gates, router, sizing, position manager and logging are mode-agnostic. Only `execution/SimAdapter.ts` and `execution/LiveAdapter.ts` differ, both implementing `ExecutionAdapter`. If you write `if (mode === "paper")` outside `execution/`, stop and refactor.
- **Bots are instances** of the same engine with their own config, run and cooldown table. Bot 2's grid is a config feature (variants), not separate code.
- **Lean by default.** One process, typed `EventEmitter` bus, SQLite. Do not add Redis, queues, Docker, microservices, auth providers or a backend without being asked.
- **Exchange access only through ccxt** wrapped in `market/` (public) and `execution/LiveAdapter.ts` (private). Exchange quirks live in `market/quirks/<exchange>.ts`, nowhere else.
- **Symbol and contract-size conversion only in `symbols/`.** Everything else works in base-asset qty and unified symbols.
- **CoinGlass parsing maps columns by header text**, never by index. Missing metric = `null`, never `0`.
- Strategy configs are immutable versions. Never mutate a saved version; create a new one.
- Paper reset archives the run. Never delete trade history.

## Domain glossary
| Term | Meaning |
|---|---|
| ROE % | PnL as % of margin (exchange "PnL %"). Default TP/SL basis |
| Price % | PnL as % move in price. ROE % = Price % × leverage |
| `tp1_dist` | TP1 distance in price %. Gates are expressed as a share of it so they scale with leverage |
| Lock | SL level after TP1 hits (Bot 1: +10% ROE) |
| Trail distance | After TP1, SL = peak ROE − distance, only moves up |
| Gate | Pre-trade check (spread, depth, slippage, cost-to-target, chase, funding, liq buffer...) |
| Run | One paper account lifetime between resets, or one live session |
| Variant | Bot 2 combination of leverage × trail profile |
| Shadow sim | SimAdapter fill computed alongside each live order to measure paper realism |
| MFE / MAE | Max favorable / adverse excursion during a trade |

## Coding conventions
- TypeScript strict, ESM, no `any` (use `unknown` + zod parse at boundaries).
- Validate every external input with zod: panel requests, CoinGlass parse output, ccxt responses used for decisions.
- Error handling: internal error codes in `packages/core/src/errors.ts`. Exchange errors are mapped once in `LiveAdapter`.
- Time: store UTC epoch ms. Display in the user's local time.
- File size: split files over ~300 lines.
- Naming: `camelCase` code, `snake_case` DB columns and export fields.
- Logging: pino, structured, with `botId`, `runId`, `tradeId`, `signalId` when available.
- Panel: shadcn/ui components, Tailwind tokens only (no hardcoded hex in components), tabular numbers for all figures, every value with a +/- sign as well as color.

## Testing requirements
Write tests first for anything in `packages/core`, `gates/`, `positions/`, `execution/` and `symbols/`.

Must-have unit tests:
- Liquidation price per exchange formula and tier (fixtures from exchange docs)
- VWAP fill across book levels, IOC cap, partial fill, self-impact within one order
- Fee, funding and net PnL math
- ROE ↔ price conversion and config validator (SL beyond liq is rejected)
- Trailing state machine: TP1 partial, lock, trail moves only up, gap through SL
- Cooldown: open position blocks, 12h window, persisted across restart
- Symbol mapper: `1000PEPE`, contract multipliers on OKX / Gate / KuCoin / MEXC
- CoinGlass parser against saved HTML fixtures, including a fixture with a reordered and a missing column
- Redaction: secrets never appear in logs, API responses or exports

Integration (testnet / demo): entry, exchange SL placement, SL amend on trail, TP1 partial, reconcile after agent kill.

## Workflow
- Solo project. Keep plans short, ship in the PRD milestone order (M0 → M5). No approval gates beyond: run `pnpm typecheck && pnpm test` before saying a task is done.
- Before starting a milestone, list the files you will touch in 5 to 10 lines, then build.
- If the existing `sufianweb3/tradingbot` code is present, audit what can be reused (scraper selectors, UI pieces) before rewriting, and say what you kept.
- When a PRD detail is ambiguous, pick the safer option for real money, note it in `docs/decisions.md` (one line per decision) and continue.
- Do not change default strategy values, gate thresholds or risk limits from the PRD without being asked.
- Update `DATA_DICTIONARY.md` (export) in the same change as any new logged field.

## Definition of done
- Typecheck, lint and tests pass.
- Paper and Live paths both covered when the change touches execution or positions.
- New fields appear in the trade log, the CSV export and the data dictionary.
- UI states covered: loading, empty, error, agent disconnected, live mode banner.
- No secret, key or account data leaves the agent.

## Gotchas
- Chrome 142+ and Brave block public-site → localhost requests until the user allows it. Use `fetch(url, { targetAddressSpace: "loopback" })` for the first call and show the permission guide on failure. Agent must answer preflight with `Access-Control-Allow-Private-Network: true`.
- MEXC futures order endpoints have been suspended for long periods. Probe on connect; if place/cancel fails, mark MEXC as data + paper only.
- OKX needs a passphrase. KuCoin futures uses a separate API host. Gate, OKX, KuCoin and MEXC size in contracts.
- One-way mode means one position per symbol per account. Enforce the cross-bot symbol lock in live.
- Funding intervals differ per symbol and exchange (1h, 4h, 8h). Read `nextFundingTime`, never assume 8h.
- Windows sleep stops the agent. Sleep guard on while positions are open; exchange stop is the real protection.
- ccxt WS reconnects can drop book deltas. Resync the book from REST snapshot on sequence gaps.
