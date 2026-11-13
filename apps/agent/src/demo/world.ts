import type { MetricRow } from "@oisniper/core";
import { App } from "../app";
import type { Clock } from "../util/clock";
import { DemoHub, type DemoExchange, type DemoSymbol } from "./demoHub";
import { DemoSource } from "./demoSource";

/** Realistic venue set: fees are each exchange's base taker tier, latency is a typical home connection. */
export const DEMO_EXCHANGES: DemoExchange[] = [
  { id: "binance", takerPct: "0.05", rttMs: 80, offsetPct: 0, depthMult: 1.4 },
  { id: "bybit", takerPct: "0.055", rttMs: 120, offsetPct: 0.004, depthMult: 1.1 },
  { id: "okx", takerPct: "0.05", rttMs: 150, offsetPct: -0.003, depthMult: 1.0 },
  { id: "gate", takerPct: "0.05", rttMs: 210, offsetPct: 0.006, depthMult: 0.6 },
  { id: "kucoin", takerPct: "0.06", rttMs: 260, offsetPct: -0.005, depthMult: 0.5 },
  { id: "mexc", takerPct: "0.02", rttMs: 340, offsetPct: 0.008, depthMult: 0.35 },
];

const ALL = { binance: "", bybit: "", okx: "", gate: "", kucoin: "", mexc: "" } as const;
const sym = (base: string, price: number, o: Partial<DemoSymbol> = {}): DemoSymbol => ({
  base, price, listings: ALL, levelUsd: 40_000, spreadPct: 0.012, maxLeverage: 100, volume24h: 850_000_000,
  fundingRate: 0.0001, fundingIntervalH: 8, qtyStep: "0.001", tick: "0.01", ...o,
});

export const DEMO_SYMBOLS: DemoSymbol[] = [
  sym("BTC", 98_250, { levelUsd: 400_000, tick: "0.1", qtyStep: "0.001", maxLeverage: 125, volume24h: 18e9 }),
  sym("PEPE", 0.00001234, { listings: { binance: "1000", bybit: "1000", okx: "", gate: "", kucoin: "1000", mexc: "" }, levelUsd: 50_000, qtyStep: "1000", tick: "0.0000000001", volume24h: 1.1e9, fundingIntervalH: 4 }),
  sym("ETH", 3_412.5, { levelUsd: 250_000, maxLeverage: 125, volume24h: 9e9 }),
  sym("SOL", 182.5, { levelUsd: 90_000, volume24h: 2.4e9 }),
  sym("AVAX", 36.2, { levelUsd: 50_000, qtyStep: "0.1", tick: "0.001", volume24h: 3.1e8 }),
  sym("DOGE", 0.385, { levelUsd: 60_000, qtyStep: "1", tick: "0.00001", volume24h: 1.2e9, fundingIntervalH: 4 }),
  sym("WIF", 2.91, { levelUsd: 40_000, qtyStep: "1", tick: "0.0001", volume24h: 4.5e8, maxLeverage: 75 }),
  sym("SUI", 4.12, { levelUsd: 40_000, qtyStep: "1", tick: "0.0001", volume24h: 6.1e8, maxLeverage: 75 }),
  sym("LINK", 23.41, { levelUsd: 40_000, qtyStep: "0.1", tick: "0.001", volume24h: 5.2e8 }),
  // 25x max: the Test grid's 30x / 50x variants must skip LEVERAGE_UNAVAILABLE, never clamp (S14)
  sym("OP", 1.762, { levelUsd: 60_000, qtyStep: "0.1", tick: "0.0001", volume24h: 2.6e8, maxLeverage: 25, listings: { binance: "", bybit: "", okx: "", gate: "", kucoin: "" } }),
  sym("ARB", 0.8214, { levelUsd: 40_000, qtyStep: "1", tick: "0.0001", volume24h: 2.9e8 }),
  sym("THIN", 0.4521, { levelUsd: 350, qtyStep: "1", tick: "0.0001", volume24h: 2.2e7, listings: { binance: "", gate: "", mexc: "" } }),
  sym("FUNDX", 1.874, { levelUsd: 40_000, qtyStep: "1", tick: "0.0001", volume24h: 2.0e8, fundingRate: 0.0025, fundingIntervalH: 1 }),
  sym("WIDE", 0.0672, { levelUsd: 40_000, spreadPct: 0.15, qtyStep: "1", tick: "0.00001", volume24h: 1.5e8 }),
  sym("LOWV", 0.973, { levelUsd: 40_000, qtyStep: "1", tick: "0.0001", volume24h: 4.0e6 }),
];

/** A strong pump row: matches both Bot 1 (OI 5m >= 2, price 5m >= 0.02, vol 1h >= 40) and Bot 2 (3 of 5 OI, 1 of 3 volume > 0). */
export function pumpMetrics(price: number, oi5 = 3.2): Partial<MetricRow> {
  return {
    price, price_chg_5m: 0.42, price_chg_15m: 0.8, price_chg_1h: 1.3, price_chg_4h: 2.2, price_chg_24h: 4.1,
    oi_chg_5m: oi5, oi_chg_15m: 4.1, oi_chg_30m: 5.0, oi_chg_1h: 6.3, oi_chg_4h: 8.8, oi_chg_24h: 12.4,
    vol_chg_5m: 140, vol_chg_1h: 86, vol_chg_4h: 44, vol_chg_24h: 21,
  };
}

export interface World {
  app: App;
  hub: DemoHub;
  src: DemoSource;
}

export function buildWorld(dbFile: string, clock: Clock, tickMs = 500): World {
  const hub = new DemoHub(DEMO_EXCHANGES, DEMO_SYMBOLS.map((s) => ({ ...s })), clock, tickMs);
  const src = new DemoSource();
  for (const s of DEMO_SYMBOLS) src.quiet(s.base, s.price);
  const app = new App({ dbFile, clock, hub, source: src, sleepGuard: false, useKeychain: false, passphrase: "demo-passphrase-not-secret" });
  return { app, hub, src };
}
