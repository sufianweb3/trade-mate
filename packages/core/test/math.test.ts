import { describe, expect, it } from "vitest";
import {
  D,
  buildTiers,
  computePnl,
  depthWithin,
  estimateLiqPricePct,
  feeFor,
  fundingCostLong,
  liqPriceLong,
  priceAtRoe,
  roeAtPrice,
  roundTripFeeRoe,
  sizeOrder,
  spreadPct,
  tierFor,
  toRoe,
  walkBook,
  type Book,
} from "../src";

const book = (bids: [number, number][], asks: [number, number][]): Book => ({
  ts: 0,
  bids: bids.map(([p, q]) => [D(p), D(q)]),
  asks: asks.map(([p, q]) => [D(p), D(q)]),
});

describe("ROE <-> price", () => {
  it("matches the PRD worked example at 50x", () => {
    expect(priceAtRoe(1, 20, 50).toString()).toBe("1.004");
    expect(priceAtRoe(1, -20, 50).toString()).toBe("0.996");
    expect(priceAtRoe(1, 10, 50).toString()).toBe("1.002");
    expect(priceAtRoe(1, 25, 50).toString()).toBe("1.005");
    expect(roeAtPrice(1, "1.007", 50).toString()).toBe("35");
  });
  it("price basis multiplies by leverage", () => {
    expect(toRoe(20, "price", 4).toString()).toBe("80");
    expect(toRoe(20, "roe", 4).toString()).toBe("20");
  });
});

describe("liquidation", () => {
  // Binance USDT-M isolated one-way formula (docs: "Liquidation Price Calculation"):
  // LP = (WB + cum - Q*EP) / (Q*MMR - Q). Bracket 1 of BTCUSDT: MMR 0.40%, cum 0.
  it("binance 50x tier 1 = PRD example 0.9839", () => {
    const lp = liqPriceLong({
      formula: "binance",
      entry: D(1),
      qty: D(2500),
      margin: D(50),
      tier: { mmr: D("0.004"), cum: D(0) },
    });
    expect(lp.toFixed(4)).toBe("0.9839");
    expect(estimateLiqPricePct(50).toFixed(2)).toBe("-1.61");
  });

  it("builds Binance cumulative maintenance amounts from the bracket table", () => {
    const tiers = buildTiers([
      { maxNotional: 50_000, mmrPct: "0.4", maxLeverage: 125 },
      { maxNotional: 600_000, mmrPct: "0.5", maxLeverage: 100 },
      { maxNotional: 3_000_000, mmrPct: "1", maxLeverage: 75 },
      { maxNotional: null, mmrPct: "2.5", maxLeverage: 20 },
    ]);
    expect(tiers.map((t) => t.cum.toString())).toEqual(["0", "50", "3050", "48050"]);
    expect(tierFor(tiers, D(60_000))?.mmr.toString()).toBe("0.005");
    expect(tierFor(tiers, D(10_000_000))?.maxLeverage).toBe(20);
  });

  it("binance tier 2 uses cum", () => {
    // 1 BTC @ 100000, 20x, margin 5000, MMR 0.5%, cum 50
    const lp = liqPriceLong({ formula: "binance", entry: D(100000), qty: D(1), margin: D(5000), tier: { mmr: D("0.005"), cum: D(50) } });
    // (5000 + 50 - 100000) / (0.005 - 1) = 94950 / 0.995 = 95427.1356...
    expect(lp.toFixed(4)).toBe(D(94950).div("0.995").toFixed(4));
  });

  it("standard (bybit-style) formula", () => {
    // EP 1, 50x, mmr 0.5%: LP = 1 - (0.02 - 0.005) = 0.985
    const lp = liqPriceLong({ formula: "standard", entry: D(1), qty: D(1000), margin: D(20), tier: { mmr: D("0.005"), cum: D(0) } });
    expect(lp.toString()).toBe("0.985");
  });
});

describe("VWAP fill", () => {
  const b = book(
    [[99.9, 1], [99.5, 2], [99, 5]],
    [[100, 1], [100.5, 2], [101, 3]],
  );
  it("walks levels and matches hand VWAP to 1e-8", () => {
    const r = walkBook(b, "buy", D("3.7"), null);
    const hand = (100 * 1 + 100.5 * 2 + 101 * 0.7) / 3.7;
    expect(Math.abs(r.avgPrice!.toNumber() - hand)).toBeLessThan(1e-8);
    expect(r.avgPrice!.toString()).toBe(D("371.7").div("3.7").toString());
    expect(r.filledQty.toString()).toBe("3.7");
    expect(r.levelsUsed).toBe(3);
    expect(r.partial).toBe(false);
  });
  it("respects IOC cap and reports partial fill", () => {
    const r = walkBook(b, "buy", D(5), D("100.5"));
    expect(r.filledQty.toString()).toBe("3");
    expect(r.partial).toBe(true);
    expect(r.avgPrice!.toString()).toBe(D(301).div(3).toString());
  });
  it("self-impact: a level is consumed once within an order", () => {
    const r = walkBook(b, "sell", D(3), null);
    expect(r.avgPrice!.toString()).toBe(D("99.9").add(D("99.5").mul(2)).div(3).toString());
    // the book object itself is not mutated (across orders the book refills)
    expect(b.bids[0]![1].toString()).toBe("1");
  });
  it("spread and depth", () => {
    expect(spreadPct(b)!.toFixed(4)).toBe(D("0.1").div("99.95").mul(100).toFixed(4));
    // within 0.3% of mid 99.95: asks <= 100.24985 → only level 100
    expect(depthWithin(b, "ask", "0.3").toString()).toBe("100");
    expect(depthWithin(b, "bid", "0.5").toString()).toBe(D("99.9").add(D("99.5").mul(2)).toString());
  });
});

describe("fees, funding, pnl", () => {
  it("fees", () => {
    expect(feeFor(2500, "0.05").toString()).toBe("1.25");
    expect(roundTripFeeRoe("0.05", 50).toString()).toBe("5");
    expect(roundTripFeeRoe("0.05", 100).toString()).toBe("10");
  });
  it("funding: longs pay positive, receive negative", () => {
    expect(fundingCostLong(2500, "0.0001").toString()).toBe("0.25");
    expect(fundingCostLong(2500, "-0.0002").toString()).toBe("-0.5");
  });
  it("net pnl for PRD worked example", () => {
    const r = computePnl({
      entryPrice: D(1),
      entryFee: feeFor(2500, "0.05"),
      legs: [
        { price: D("1.004"), qty: D(1250), fee: feeFor(D("1.004").mul(1250), "0.05") },
        { price: D("1.005"), qty: D(1250), fee: feeFor(D("1.005").mul(1250), "0.05") },
      ],
      funding: D(0),
      margin: D(50),
    });
    expect(r.gross.toString()).toBe("11.25");
    // 1.25 entry + 0.6275 TP1 leg + 0.628125 trail leg
    expect(r.fees.toString()).toBe("2.505625");
    expect(r.net.toString()).toBe("8.744375");
    expect(r.netRoePct.toFixed(2)).toBe("17.49");
  });
});

describe("sizing", () => {
  it("rounds down to lot step", () => {
    const r = sizeOrder({ margin: D(50), leverage: 50, price: D("1.2345"), qtyStep: D(1), minQty: D(1), minNotional: D(5), maxQty: null });
    expect(r.ok && r.qty.toString()).toBe("2025");
  });
  it("rejects below min notional and over tier max, never clamps", () => {
    expect(sizeOrder({ margin: D(1), leverage: 2, price: D(100), qtyStep: D("0.001"), minQty: D("0.001"), minNotional: D(5), maxQty: null })).toMatchObject({ ok: false, code: "MIN_NOTIONAL" });
    expect(sizeOrder({ margin: D(1), leverage: 1, price: D(1000), qtyStep: D("0.01"), minQty: D("0.01"), minNotional: D(5), maxQty: null })).toMatchObject({ ok: false, code: "LOT_SIZE" });
    expect(sizeOrder({ margin: D(1000), leverage: 50, price: D(1), qtyStep: D(1), minQty: D(1), minNotional: D(5), maxQty: D(10000) })).toMatchObject({ ok: false, code: "TIER_SIZE_EXCEEDED" });
  });
});
