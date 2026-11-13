import { D } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import type { MarketInfo } from "../src/market/types";
import { baseToContracts, contractsToBase, normalizeMarket } from "../src/symbols/contracts";
import { SymbolMapper } from "../src/symbols/mapper";

const raw = (symbol: string, base: string, contractSize: number, amountStep: number, minAmount = amountStep) => ({
  symbol, base, settle: "USDT", swap: true, linear: true, active: true, contractSize, taker: 0.0005, maker: 0.0002,
  precision: { amount: amountStep, price: 0.0001 }, limits: { amount: { min: minAmount }, cost: { min: 5 }, leverage: { max: 50 } },
});

describe("contract normalization (symbols/ only)", () => {
  it("OKX: 1 contract = 0.01 BTC", () => {
    const m = normalizeMarket("okx", raw("BTC/USDT:USDT", "BTC", 0.01, 0.01), null)!;
    expect(m.qtyStep.toString()).toBe("0.0001");
    expect(m.minQty.toString()).toBe("0.0001");
    expect(baseToContracts(D("0.0257"), m.contractSize, D("0.01")).toString()).toBe("2.57");
  });
  it("Gate: PEPE contract = 10,000,000 PEPE, whole contracts", () => {
    const m = normalizeMarket("gate", raw("PEPE/USDT:USDT", "PEPE", 10_000_000, 1), null)!;
    expect(m.qtyStep.toString()).toBe("10000000");
    expect(baseToContracts(D(25_500_000), m.contractSize, D(1)).toString()).toBe("2"); // rounded down, never up
  });
  it("KuCoin: 1 contract = 0.001 BTC; MEXC: 1 contract = 0.0001 BTC", () => {
    expect(normalizeMarket("kucoin", raw("BTC/USDT:USDT", "BTC", 0.001, 1), null)!.qtyStep.toString()).toBe("0.001");
    expect(normalizeMarket("mexc", raw("BTC/USDT:USDT", "BTC", 0.0001, 1), null)!.qtyStep.toString()).toBe("0.0001");
    expect(contractsToBase(3, D("0.0001")).toString()).toBe("0.0003");
  });
  it("missing leverage limit is unknown (0), never a guess", () => {
    const r = raw("SOL/USDT:USDT", "SOL", 1, 1);
    const m = normalizeMarket("binance", { ...r, limits: { ...r.limits, leverage: {} } }, null)!;
    expect(m.maxLeverage).toBe(0);
    expect(m.leverageVerified).toBe(false);
    expect(m.limitsSource).toBe("unknown");
  });
  it("Binance/Bybit base units, non-USDT or non-swap ignored", () => {
    expect(normalizeMarket("binance", raw("BTC/USDT:USDT", "BTC", 1, 0.001), null)!.qtyStep.toString()).toBe("0.001");
    expect(normalizeMarket("binance", { ...raw("BTC/USD:BTC", "BTC", 1, 1), settle: "BTC" }, null)).toBeNull();
    expect(normalizeMarket("binance", { nonsense: true }, null)).toBeNull();
  });
});

describe("SymbolMapper", () => {
  const mk = (ex: MarketInfo["exchange"], symbol: string, base: string, active = true) => ({ ...normalizeMarket(ex, raw(symbol, base, 1, 1), null)!, active });
  const markets: Record<string, MarketInfo[]> = {
    binance: [mk("binance", "1000PEPE/USDT:USDT", "1000PEPE"), mk("binance", "SOL/USDT:USDT", "SOL"), mk("binance", "OLD/USDT:USDT", "OLD", false)],
    okx: [mk("okx", "PEPE/USDT:USDT", "PEPE")],
  };
  const m = new SymbolMapper({ markets: (ex) => markets[ex] ?? [] });
  m.reindex(["binance", "okx"]);

  it("maps PEPE to 1000PEPE on Binance and verifies by price ratio", () => {
    const r = m.resolve("PEPE", "binance", 0.00001234, D("0.01236"));
    expect(r).toMatchObject({ ok: true, verified: true, mapping: { symbol: "1000PEPE/USDT:USDT", multiplier: 1000 } });
  });
  it("plain PEPE on OKX", () => {
    expect(m.resolve("PEPE", "okx", 0.00001234, D("0.00001233"))).toMatchObject({ ok: true, mapping: { multiplier: 1 } });
  });
  it("price ratio mismatch > 2% excludes the symbol", () => {
    expect(m.resolve("PEPE", "binance", 0.00001234, D("0.0130"))).toMatchObject({ ok: false, reason: "PRICE_MISMATCH" });
  });
  it("unlisted / not trading", () => {
    expect(m.resolve("XYZ", "binance", 1, null)).toMatchObject({ ok: false, reason: "UNLISTED" });
    expect(m.resolve("OLD", "binance", 1, null)).toMatchObject({ ok: false, reason: "NOT_TRADING" });
  });
  it("manual override wins", () => {
    m.setOverrides([{ coinglass: "SOL", exchange: "binance", unified: "1000PEPE/USDT:USDT" }]);
    expect(m.resolve("SOL", "binance", null, null)).toMatchObject({ ok: true, mapping: { symbol: "1000PEPE/USDT:USDT" } });
    m.setOverrides([]);
  });
});
