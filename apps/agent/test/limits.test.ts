import { D, type ExchangeId } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import { LimitsService, strictestTiers, tiersFromCcxt } from "../src/market/limits";
import type { MarketInfo } from "../src/market/types";
import { normalizeMarket } from "../src/symbols/contracts";

const raw = (symbol: string, base: string, lev: number | null, cs = 1) => ({
  symbol, base, settle: "USDT", swap: true, linear: true, active: true, contractSize: cs, taker: 0.0005, maker: 0.0002,
  precision: { amount: 1, price: 0.0001 }, limits: { amount: { min: 1 }, cost: { min: 5 }, leverage: lev ? { max: lev } : {} },
});

describe("leverage tiers", () => {
  it("ccxt tiers -> USDT tiers; OKX sizes are contracts", () => {
    const t = tiersFromCcxt([{ maxNotional: 10, maintenanceMarginRate: 0.01, maxLeverage: 50 }, { maxNotional: 100, maintenanceMarginRate: 0.02, maxLeverage: 20 }], "okx", D("0.1"), D(100))!;
    expect(t[0]!.maxNotional!.toString()).toBe("100"); // 10 contracts x 0.1 x $100
    expect(t[0]!.maxLeverage).toBe(50);
    expect(t[1]!.maxNotional).toBeNull();
  });
  it("strictest merge: highest MMR and lowest leverage per band", () => {
    const a = tiersFromCcxt([{ maxNotional: 50_000, maintenanceMarginRate: 0.005, maxLeverage: 75 }, { maxNotional: null, maintenanceMarginRate: 0.02, maxLeverage: 20 }], "bybit", D(1), null)!;
    const b = tiersFromCcxt([{ maxNotional: 20_000, maintenanceMarginRate: 0.01, maxLeverage: 50 }, { maxNotional: null, maintenanceMarginRate: 0.015, maxLeverage: 25 }], "gate", D(1), null)!;
    const m = strictestTiers([a, b]);
    expect(m[0]!.maxLeverage).toBe(50);
    expect(m[0]!.mmr.toString()).toBe("0.01");
    expect(m[m.length - 1]!.maxLeverage).toBe(20);
  });
});

describe("LimitsService", () => {
  const make = (privateBinance: boolean) => {
    const mk: Record<string, MarketInfo[]> = {
      binance: [normalizeMarket("binance", raw("WIF/USDT:USDT", "WIF", null), null)!],
      bybit: [normalizeMarket("bybit", raw("WIF/USDT:USDT", "WIF", 50), null)!],
      okx: [normalizeMarket("okx", raw("WIF/USDT:USDT", "WIF", 75, 1), null)!],
      gate: [],
    };
    const tiers: Record<string, unknown> = {
      bybit: [{ maxNotional: 25_000, maintenanceMarginRate: 0.01, maxLeverage: 50 }, { maxNotional: null, maintenanceMarginRate: 0.025, maxLeverage: 20 }],
      okx: [{ maxNotional: 1000, maintenanceMarginRate: 0.008, maxLeverage: 75 }, { maxNotional: null, maintenanceMarginRate: 0.02, maxLeverage: 25 }],
    };
    const s = new LimitsService({
      call: async (ex: ExchangeId) => tiers[ex],
      has: (ex) => ex !== "binance",
      markets: (ex) => mk[ex] ?? [],
      price: async () => D(2),
      update: (m) => (mk[m.exchange] = mk[m.exchange]!.map((x) => (x.symbol === m.symbol ? m : x))),
      now: () => 0,
    });
    if (privateBinance) s.setPrivateLoader("binance", async () => [{ maxNotional: 5000, maintenanceMarginRate: 0.01, maxLeverage: 25 }, { maxNotional: null, maintenanceMarginRate: 0.05, maxLeverage: 10 }]);
    return { s, mk };
  };

  it("Binance without key: lowest public limit across venues, flagged unverified", async () => {
    const { s, mk } = make(false);
    expect(mk.binance![0]!.maxLeverage).toBe(0); // unknown before resolve
    await s.resolve("binance", "WIF/USDT:USDT");
    const m = mk.binance![0]!;
    expect(m.maxLeverage).toBe(50); // min(bybit 50, okx 75)
    expect(m.leverageVerified).toBe(false);
    expect(m.limitsSource).toBe("cross_venue_min");
  });
  it("Binance with key: real private brackets, verified", async () => {
    const { s, mk } = make(true);
    await s.resolve("binance", "WIF/USDT:USDT");
    expect(mk.binance![0]!).toMatchObject({ maxLeverage: 25, leverageVerified: true, limitsSource: "exchange_private" });
  });
  it("venue with public tiers never exceeds its own market limit", async () => {
    const { s, mk } = make(false);
    await s.resolve("okx", "WIF/USDT:USDT");
    expect(mk.okx![0]!).toMatchObject({ maxLeverage: 75, limitsSource: "exchange_public", leverageVerified: true });
  });
  it("no data anywhere stays unknown (0) so the gate rejects", async () => {
    const s = new LimitsService({ call: async () => null, has: () => false, markets: (ex) => (ex === "binance" ? [normalizeMarket("binance", raw("XYZ/USDT:USDT", "XYZ", null), null)!] : []), price: async () => null, update: () => undefined, now: () => 0 });
    let updated: MarketInfo | null = null;
    // @ts-expect-error swap deps.update to capture
    s.d.update = (m: MarketInfo) => (updated = m);
    await s.resolve("binance", "XYZ/USDT:USDT");
    expect(updated!.maxLeverage).toBe(0);
  });
});
