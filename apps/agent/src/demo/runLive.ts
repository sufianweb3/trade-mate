// `pnpm demo`: the real agent + panel on http://localhost:7777, fed by the synthetic market in real time.
// Nothing touches an exchange or CoinGlass. Data goes to .demo-data/live (wiped on each start).
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServer } from "../api/server";
import { findPanelDir, pairingPhrase } from "../main";
import { systemClock } from "../util/clock";
import { buildWorld, pumpMetrics } from "./world";

const PATTERNS: { name: string; path: (p: number) => [number, number][] }[] = [
  { name: "trail winner", path: (p) => [[40_000, p * 1.005], [100_000, p * 1.009], [150_000, p * 1.003]] },
  { name: "stop loss", path: (p) => [[30_000, p * 0.994]] },
  { name: "slow grind up", path: (p) => [[120_000, p * 1.0045], [240_000, p * 1.006]] },
  { name: "chop", path: (p) => [[30_000, p * 1.002], [60_000, p * 0.998], [90_000, p * 1.001]] },
];
const ROTATION = ["SOL", "AVAX", "DOGE", "LINK", "SUI", "ETH", "PEPE", "ARB", "OP", "WIF", "THIN", "FUNDX"];

async function main() {
  const port = Number(process.env.OISNIPER_PORT ?? 7777);
  const dir = resolve(process.env.DEMO_OUT ?? join(process.cwd(), "..", "..", ".demo-data", "live"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const w = buildWorld(join(dir, "live.db"), systemClock);
  w.app.store.setSetting("warm_set_size", 8);
  w.app.scraper.setInterval(15_000);
  await w.app.start();
  await w.app.bots.get("paper").start();
  await w.app.bots.get("test").start();
  const srv = await buildServer(w.app, { port, panelDir: findPanelDir(), allowedOrigins: ["http://localhost:3000"] });
  await srv.listen({ host: "127.0.0.1", port });
  const token = w.app.token();
  console.log(`\n  DEMO agent (synthetic market) on http://127.0.0.1:${port}\n  Pairing phrase: ${pairingPhrase(token)}\n  Open: http://localhost:${port}/#pair=${token}\n`);

  let i = 0;
  const tick = () => {
    const sym = ROTATION[i % ROTATION.length]!;
    const pat = PATTERNS[i % PATTERNS.length]!;
    i++;
    const p = w.hub.refPrice(sym, Date.now());
    w.src.set(sym, pumpMetrics(p));
    console.log(`  [demo] ${new Date().toISOString().slice(11, 19)} ${sym} pumping on CoinGlass -> scripted ${pat.name}`);
    setTimeout(() => {
      w.src.quiet(sym, w.hub.refPrice(sym, Date.now()));
      w.hub.path(sym, pat.path(w.hub.refPrice(sym, Date.now())));
    }, 17_000);
  };
  tick();
  setInterval(tick, 50_000);
  const stop = async () => {
    await srv.close();
    await w.app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

void main();
