import { D, type Book, type ExitProfile } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import { runGates, type GateInput } from "../src/gates/gates";
import type { MarketInfo } from "../src/market/types";

const NOW = 1_000_000;
const lvl = (p: string, q: string): [ReturnType<typeof D>, ReturnType<typeof D>] => [D(p), D(q)];

const profile: ExitProfile = {
  variantId: "10x", variantName: "10x", leverage: 10, basis: "roe", slPct: 20, tp1Pct: 20, tp1ClosePct: 50,
  trailEnabled: true, lockPct: 10, trailDistancePct: 10, breakevenFees: true, activatePct: null, maxHoldHours: 0,
  triggerPrice: "mark", liqBufferPct: 25,
} as ExitProfile;

function input(book: Book): GateInput {
  return {
    gates: {
      freshness: true, maxBookAgeMs: 2000, maxSpreadPct: 0.05, depthBandPct: 0.3, entryDepthMult: 0, exitDepthMult: 0,
      maxEntrySlippagePct: 0.05, maxCostToTargetPct: 40, maxChasePct: 50, maxVolatilityPct: 300, minVolume24h: 0, maxFundingPct: 0.1,
    },
    profile, book, now: NOW, snapshotTs: NOW, scrapeIntervalMs: 30_000, signalPrice: D(100),
    sizing: { ok: true, qty: D(1), notional: D(100), margin: D(10) }, takerPct: D("0.05"),
    volume24h: D(1e6), fundingRate: D(0), range1mPct: D("0.1"),
    market: { maxLeverage: 50, tiers: [], minNotional: D(5) } as unknown as MarketInfo,
    liqPrice: D(90.5), slPrice: D(98),
  };
}

const spreadOf = (book: Book) => runGates(input(book)).results.find((r) => r.gate === "spread")!;

describe("spread gate", () => {
  it("passes a normal tight book", () => {
    expect(spreadOf({ ts: NOW, bids: [lvl("99.99", "100")], asks: [lvl("100.01", "100")] }).pass).toBe(true);
  });
  it("fails a crossed book (negative spread) instead of treating it as cheap", () => {
    const r = spreadOf({ ts: NOW, bids: [lvl("100.5", "100")], asks: [lvl("98", "100")] });
    expect(Number(r.value)).toBeLessThan(0);
    expect(r.pass).toBe(false);
  });
  it("fails a locked book (zero spread)", () => {
    expect(spreadOf({ ts: NOW, bids: [lvl("100", "100")], asks: [lvl("100", "100")] }).pass).toBe(false);
  });
});
