/**
 * Live adapter integration suite on TESTNET / DEMO (CLAUDE.md rule 9). Keys come from .env.testnet (never committed).
 * Per exchange: entry fill, exchange stop within 3s, TP1 partial, trailing amend, stop-bot blocks entries,
 * kill switch flattens, crash mid-trade -> restart -> reconcile with the stop still on the exchange.
 * A full pass is recorded in <data dir>/testnet-pass.json, which Real Mode Readiness requires.
 */
import { BOT1_PRESET, D, type BotConfig, type ExchangeId } from "@oisniper/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { App } from "../../src/app";
import { DemoSource } from "../../src/demo/demoSource";
import { pumpMetrics } from "../../src/demo/world";
import { CcxtHub } from "../../src/market/ccxtHub";
import { call } from "../../src/market/quirks/types";
import { defaultDataDir } from "../../src/paths";
import { systemClock } from "../../src/util/clock";

function loadEnv(): Record<string, string> {
  const f = resolve(__dirname, "../../../../.env.testnet");
  if (!existsSync(f)) return {};
  return Object.fromEntries(
    readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}
const env = loadEnv();
const KEYS: Partial<Record<ExchangeId, { apiKey: string; secret: string; passphrase?: string }>> = {};
if (env.BINANCE_TESTNET_KEY) KEYS.binance = { apiKey: env.BINANCE_TESTNET_KEY, secret: env.BINANCE_TESTNET_SECRET! };
if (env.BYBIT_TESTNET_KEY) KEYS.bybit = { apiKey: env.BYBIT_TESTNET_KEY, secret: env.BYBIT_TESTNET_SECRET! };
if (env.OKX_DEMO_KEY) KEYS.okx = { apiKey: env.OKX_DEMO_KEY, secret: env.OKX_DEMO_SECRET!, passphrase: env.OKX_DEMO_PASSPHRASE };

const SYM = "BTC/USDT:USDT";
const passed: Record<string, string[]> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, ms: number, step = 500): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

/** Test-only Real config: small size, low leverage, tiny TP1 so it fills on testnet, gates opened for thin testnet books. */
function testConfig(ex: ExchangeId): BotConfig {
  return {
    ...BOT1_PRESET, name: "Real", mode: "live", exchanges: [ex], leverages: [5],
    exits: { ...BOT1_PRESET.exits, slPct: 10, tp1Pct: 0.6, tp1ClosePct: 50, lockPct: 0.3, trailDistancePct: 0.3 },
    sizing: { mode: "fixed", value: "40" },
    risk: { ...BOT1_PRESET.risk, maxCapital: "300", maxOpenPositions: 2 },
    gates: { ...BOT1_PRESET.gates, maxSpreadPct: 1, entryDepthMult: 0, exitDepthMult: 0, maxEntrySlippagePct: 1, maxCostToTargetPct: 10_000, maxChasePct: 100_000, maxVolatilityPct: 100_000, minVolume24h: 0, maxFundingPct: 100 },
  };
}

async function boot(ex: ExchangeId, dir: string) {
  const hub = new CcxtHub([ex], systemClock, { testnet: true });
  const src = new DemoSource();
  const app = new App({ dbFile: join(dir, "t.db"), clock: systemClock, hub, source: src, sleepGuard: false, useKeychain: false, passphrase: "testnet-suite", dataDir: dir });
  return { app, hub, src };
}

for (const ex of ["binance", "bybit", "okx"] as const) {
  const keys = KEYS[ex];
  describe.skipIf(!keys)(`${ex} testnet`, () => {
    const dir = mkdtempSync(join(tmpdir(), `oisn-tn-${ex}-`));
    let w: Awaited<ReturnType<typeof boot>>;
    const checks: string[] = [];
    const client = () => w.app.accounts.get(ex)!;
    const openStops = async () =>
      ((await call(client(), "fetchOpenOrders", SYM, undefined, undefined, { stop: true, trigger: true }).catch(() => [])) as { id: string; triggerPrice?: number; reduceOnly?: boolean }[]).filter((o) => o.triggerPrice);
    const position = async () => ((await call(client(), "fetchPositions", [SYM])) as { contracts?: number }[]).find((p) => (p.contracts ?? 0) > 0);
    const signal = async () => {
      const px = (await w.hub.fetchPrice(ex, SYM))!.toNumber();
      w.src.set("BTC", pumpMetrics(px));
      await w.app.scraper.tick();
      w.src.quiet("BTC", px);
    };

    afterAll(async () => {
      await w?.app.bots.killAll().catch(() => undefined);
      await w?.app.stop().catch(() => undefined);
    });

    it("connects, validates the key, no withdrawal", async () => {
      w = await boot(ex, dir);
      await w.app.start({ scraper: true });
      const st = await w.app.accounts.connect(ex, keys!, true, true);
      // As POST /api/exchanges/:ex/keys does: store the key (a restart reconnects from it) and load leverage brackets.
      if (st.status === "connected" || st.status === "unverified")
        w.app.store.records.upsertKey({ exchange: ex, enc: w.app.vault.encrypt(keys!), masked: st.masked, permissions: st.permissions, status: st.status, testnet: true, created_at: Date.now() });
      w.app.syncLimitLoaders();
      expect(st.status === "connected" || st.status === "unverified").toBe(true);
      expect(st.tradeEnabled).toBe(true);
      expect(st.permissions?.withdraw).not.toBe(true);
      checks.push("key");
    });

    it("entry fills and the exchange stop exists within 3s", async () => {
      const real = w.app.bots.get("real");
      real.saveConfig(testConfig(ex));
      await real.start();
      // A running bot already has a minute of BTC data; the volatility gate refuses to trade without it (fail closed).
      await w.hub.subscribe(ex, SYM, "testnet-warmup");
      expect(await until(() => w.hub.range1mPct(ex, SYM) != null, 90_000, 1000), "no 1m price data for BTC").toBe(true);
      await signal();
      const t = await until(() => w.app.store.records.listTrades({ botId: "real", status: "open" })[0], 15_000);
      expect(t, "no live entry").toBeTruthy();
      expect(Number(t!.execution.filled_qty)).toBeGreaterThan(0);
      checks.push("entry");
      expect(t!.timing.sl_placed_ts! - t!.timing.entry_fill_time).toBeLessThan(3000);
      const stops = await openStops();
      expect(stops.length).toBeGreaterThan(0);
      expect(D(stops[0]!.triggerPrice!).sub(t!.state.sl_price).abs().div(t!.state.sl_price).lt("0.001")).toBe(true);
      checks.push(`sl_within_3s:${t!.timing.sl_placed_ts! - t!.timing.entry_fill_time}ms`);
    }, 150_000);

    it("trailing amend moves the exchange stop (new first, old cancelled)", async () => {
      const real = w.app.bots.get("real");
      const t = real.pm.openTrades()[0]!;
      const before = (await openStops()).map((o) => o.id);
      await real.pm.raiseStop(t.trade_id, D(-5)); // -10% ROE -> -5% ROE, still below market
      const after = await until(async () => {
        const s = await openStops();
        return s.length === 1 && !before.includes(s[0]!.id) ? s : null;
      }, 10_000);
      expect(after, "amended stop not visible on exchange").toBeTruthy();
      checks.push("trail_amend");
    }, 30_000);

    it("TP1 partial close fills on the exchange", async () => {
      const real = w.app.bots.get("real");
      const id = real.pm.openTrades()[0]!.trade_id;
      const done = await until(() => w.app.store.records.getTrade(id)?.path.tp1_hit, 180_000, 2000);
      if (!done) console.warn(`${ex}: TP1 (+0.12% price) not reached within 3 min on testnet; order placement verified only`);
      const ev = w.app.store.records.events(id).map((e) => e.type);
      expect(ev).toContain("TP1_PLACED");
      if (done) {
        expect(ev).toContain("TP1_FILL");
        checks.push("tp1_partial");
      }
    }, 200_000);

    it("stopping the bot blocks new entries", async () => {
      const real = w.app.bots.get("real");
      await real.stop("USER");
      const n = w.app.store.records.listTrades({ botId: "real" }).length;
      w.src.set("ETH", pumpMetrics(3000));
      await w.app.scraper.tick();
      await sleep(3000);
      expect(w.app.store.records.listTrades({ botId: "real" }).length).toBe(n);
      checks.push("stop_blocks_entries");
    }, 30_000);

    it("kill switch closes everything on the exchange", async () => {
      await w.app.bots.killAll();
      const pos = await until(async () => !(await position()), 15_000);
      expect(pos, "position still open after kill switch").toBe(true);
      expect((await openStops()).length).toBe(0);
      w.app.bots.releaseKill();
      checks.push("kill_switch");
    }, 60_000);

    it("crash mid-trade: stop stays on the exchange, restart reconciles", async () => {
      // new entry after the BTC cooldown: use a fresh bot run so the same symbol is allowed in the test
      const real = w.app.bots.get("real");
      real.saveConfig({ ...testConfig(ex), cooldownHours: 0 });
      await real.start();
      await signal();
      const t = await until(() => w.app.store.records.listTrades({ botId: "real", status: "open" })[0], 15_000);
      expect(t).toBeTruthy();
      await until(async () => (await openStops()).length > 0, 5000);
      // crash: no shutdown, no cancels (the process would just die)
      const stopsBefore = (await openStops()).map((o) => o.id);
      expect(stopsBefore.length).toBeGreaterThan(0);
      const w2 = await boot(ex, dir);
      await w2.app.start({ scraper: false });
      await w2.app.accounts.connect(ex, keys!, true, true);
      w2.app.syncLimitLoaders();
      const ev = w2.app.store.records.events(t!.trade_id).map((e) => e.type);
      expect(ev).toContain("RECONCILE");
      expect(w2.app.bots.get("real").row().status).toBe("stopped"); // never auto-start
      expect((await openStops()).length).toBeGreaterThan(0); // exchange stop survived the crash
      checks.push("crash_reconcile");
      await w2.app.bots.killAll();
      await w2.app.stop();
    }, 90_000);

    it("records the pass", () => {
      const must = ["key", "entry", "sl_within_3s", "trail_amend", "tp1_partial", "stop_blocks_entries", "kill_switch", "crash_reconcile"];
      expect(must.every((m) => checks.some((c) => c.startsWith(m)))).toBe(true);
      passed[ex] = checks;
      const out = process.env.OISNIPER_DATA_DIR ?? defaultDataDir();
      mkdirSync(out, { recursive: true });
      const f = join(out, "testnet-pass.json");
      const prev = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
      writeFileSync(f, JSON.stringify({ ...prev, [ex]: { passedAt: Date.now(), checks } }, null, 2));
    });
  });
}
