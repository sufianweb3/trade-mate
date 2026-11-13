import { describe, expect, it } from "vitest";
import { splitBase } from "../src/exchangeData/collectors";
import { SeriesStore, valueAt } from "../src/exchangeData/series";
import { sourceRole, tradeSource } from "../src/engine/sources";
import { BOT1_PRESET } from "@oisniper/core";

const M = 60_000;
const T0 = 1_800_000_000_000;

describe("exchange series", () => {
  it("valueAt interpolates on the 5m grid and never invents data", () => {
    const pts = [{ ts: T0, v: 100 }, { ts: T0 + 5 * M, v: 110 }];
    expect(valueAt(pts, T0 + 2.5 * M, 90_000)).toBeCloseTo(105);
    expect(valueAt(pts, T0 - 1, 90_000)).toBeNull();
    expect(valueAt(pts, T0 + 5 * M + 60_000, 90_000)).toBe(110);
    expect(valueAt(pts, T0 + 5 * M + 200_000, 90_000)).toBeNull(); // stale
    expect(valueAt([], T0, 90_000)).toBeNull();
  });

  it("aggregated OI change only sums venues present at both ends", () => {
    const s = new SeriesStore();
    for (let i = 0; i <= 12; i++) s.addOi("SOL", "binance", T0 + i * 5 * M, 1000 + i * 10); // +12% over 1h
    s.addOi("SOL", "kucoin", T0 + 60 * M, 5000); // joins at the end: must not count as +5000
    const r = s.row("SOL", "aggregated", T0 + 60 * M);
    expect(r.oi_chg_1h).toBeCloseTo(12, 4);
    expect(r.oi_value).toBe(1120 + 5000);
    expect(s.row("SOL", "kucoin", T0 + 60 * M).oi_chg_1h).toBeNull();
    expect(r.oi_chg_4h).toBeNull(); // no 4h history: null, never 0
  });

  it("price and volume windows from 5m candles", () => {
    const s = new SeriesStore();
    const k = Array.from({ length: 100 }, (_, i) => ({ ts: T0 + i * 5 * M, close: 100 + i, quoteVol: i < 88 ? 10 : 20 }));
    s.setCandles("ETH", "5m", k);
    const now = T0 + 100 * 5 * M;
    s.price.set("ETH", { ts: now, v: 200 });
    const r = s.row("ETH", "aggregated", now);
    // price 5 minutes ago = close of the bar that ended then (bar 98 closes at now - 5m)
    expect(r.price_chg_5m).toBeCloseTo((200 / 198 - 1) * 100, 3);
    expect(r.vol_1h).toBe(12 * 20);
    expect(r.vol_chg_1h).toBe(100); // last 12 bars 20 vs previous 12 bars 10
    expect(r.vol_chg_24h).toBeNull(); // no 1h candles
  });

  it("splitBase handles multipliers and KuCoin XBT", () => {
    expect(splitBase("1000PEPE")).toEqual({ base: "PEPE", mult: 1000 });
    expect(splitBase("XBT")).toEqual({ base: "BTC", mult: 1 });
    expect(splitBase("1MBABYDOGE")).toEqual({ base: "BABYDOGE", mult: 1_000_000 });
  });
});

describe("data source routing", () => {
  const cg = { ...BOT1_PRESET, dataSource: { kind: "coinglass" as const, oiScope: "aggregated" as const } };
  const exAgg = { ...BOT1_PRESET, dataSource: { kind: "exchange" as const, oiScope: "aggregated" as const } };
  const exVenue = { ...BOT1_PRESET, exchanges: ["bybit" as const], dataSource: { kind: "exchange" as const, oiScope: "venue" as const } };
  it("trades on its own source, shadows the other, ignores venue variants", () => {
    expect(sourceRole(cg, "coinglass")).toBe("trade");
    expect(sourceRole(cg, "demo-coinglass")).toBe("trade");
    expect(sourceRole(cg, "exchange")).toBe("shadow");
    expect(sourceRole(cg, "exchange:binance")).toBeNull();
    expect(sourceRole(exAgg, "exchange")).toBe("trade");
    expect(sourceRole(exAgg, "coinglass")).toBe("shadow");
    expect(sourceRole(exAgg, "exchange:bybit")).toBeNull();
    expect(tradeSource(exVenue)).toBe("exchange:bybit");
    expect(sourceRole(exVenue, "exchange:bybit")).toBe("trade");
    expect(sourceRole(exVenue, "exchange")).toBeNull();
    expect(sourceRole(exVenue, "coinglass")).toBe("shadow");
  });
});
