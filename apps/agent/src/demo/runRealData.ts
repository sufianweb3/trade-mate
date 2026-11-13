// Real exchange market data (ccxt public: Binance, Bybit, OKX) + CoinGlass-format signals scripted from live prices.
// Used when CoinGlass blocks the scraper. Paper/Test fills, fees, slippage and stops all run on the real order books.
// Usage: tsx src/demo/runRealData.ts <dataDir>   (data is kept between runs so restart/reconcile can be tested)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "../app";
import { buildServer } from "../api/server";
import { findPanelDir, pairingPhrase } from "../main";
import { CcxtHub } from "../market/ccxtHub";
import { dataPaths } from "../paths";
import { systemClock } from "../util/clock";
import { DemoSource } from "./demoSource";
import { ExchangeDataSource } from "../exchangeData/source";
import { installProcessGuard } from "../processGuard";
import { pumpMetrics } from "./world";

const SYMBOLS = (process.env.REALDATA_SYMBOLS ?? "BTC,ETH,SOL,XRP,DOGE,AVAX,LINK,SUI,ADA,BNB,LTC,DOT").split(",");

async function main() {
  const dir = resolve(process.argv[2] ?? "../../.demo-data/realdata");
  mkdirSync(dir, { recursive: true });
  const paths = dataPaths(dir);
  const hub = new CcxtHub(["binance", "bybit", "okx", "gate", "kucoin"], systemClock);
  const src = new DemoSource();
  const exchangeSource = new ExchangeDataSource(hub, { universeSize: () => Number(process.env.REALDATA_UNIVERSE ?? 60), now: () => Date.now() });
  const app = new App({ dbFile: paths.db, clock: systemClock, hub, source: src, exchangeSource, sleepGuard: false, dataDir: dir });
  app.store.setSetting("warm_set_size", 4);
  app.scraper.setInterval(15_000);
  const price = async (s: string) => (await hub.fetchPrice("binance", `${s}/USDT:USDT`).catch(() => null))?.toNumber() ?? null;
  const refresh = async () => {
    for (const s of SYMBOLS) {
      const p = await price(s);
      if (p == null) continue;
      const cur = src.rows.get(s);
      if (cur && cur.oi_chg_5m != null && cur.oi_chg_5m > 1) src.set(s, { price: p }); // pumping row: keep metrics, track price
      else src.quiet(s, p);
    }
  };
  installProcessGuard(() => app);
  await hub.start();
  await refresh();
  await app.start();
  const port = Number(process.env.OISNIPER_PORT ?? 7777);
  const srv = await buildServer(app, { port, panelDir: findPanelDir(), allowedOrigins: [] });
  await srv.listen({ host: "127.0.0.1", port });
  const token = app.token();
  console.log(`\n  REAL-DATA agent on http://127.0.0.1:${port}  (exchanges: binance, bybit, okx public data)\n  Pairing phrase: ${pairingPhrase(token)}\n  Pair this browser: http://localhost:${port}/#pair=${encodeURIComponent(token)}\n`);
  setInterval(() => void refresh(), 15_000);
  let i = 0;
  setInterval(async () => {
    const s = SYMBOLS[i++ % SYMBOLS.length]!;
    const p = await price(s);
    if (p == null) return;
    src.set(s, pumpMetrics(p, 2.5));
    console.log(`  [signal] ${new Date().toISOString().slice(11, 19)} ${s} @ ${p} (CoinGlass-format pump row)`);
    setTimeout(async () => src.quiet(s, (await price(s)) ?? p), 20_000);
  }, 40_000);
  const stop = async () => {
    await srv.close();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
}

void main();
