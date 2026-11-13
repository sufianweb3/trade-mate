import { describe, expect, it } from "vitest";
import { fitSearch, leverageCandidates, sizeCandidates } from "../src/engine/fit";

const AD = { leverage: "fit", minLeverage: 5, size: "fit", minSizePct: 25 } as const;
const OFF = { leverage: "off", minLeverage: 5, size: "off", minSizePct: 25 } as const;

describe("adaptive candidates", () => {
  it("off = only the configured leverage and full size", () => {
    expect(leverageCandidates(50, 10, [], OFF)).toEqual([50]);
    expect(sizeCandidates(OFF)).toEqual([100]);
  });
  it("starts at the coin's max (capped at requested), then lower steps, never below min", () => {
    expect(leverageCandidates(50, 9, [9, 5], AD)).toEqual([9, 8, 6, 5]);
    expect(leverageCandidates(20, 25, [], AD)[0]).toBe(20);
  });
  it("venue allows more than requested: never raises leverage", () => {
    expect(leverageCandidates(20, 125, [], AD).every((l) => l <= 20)).toBe(true);
  });
  it("unknown venue max (0): nothing to fit", () => {
    expect(leverageCandidates(50, 0, [], AD)).toEqual([50]);
  });
  it("sizes stop at minSizePct", () => {
    expect(sizeCandidates(AD)).toEqual([100, 75, 50, 35, 25]);
    expect(sizeCandidates({ ...AD, minSizePct: 30 })).toEqual([100, 75, 50, 35, 30]);
  });
});

const depthOnly = (maxNotional: number) => (l: number, s: number) => {
  const ok = l * s <= maxNotional;
  return { pass: ok, failedGates: ok ? [] : ["entry_depth", "exit_depth"], value: null };
};

describe("fitSearch: coin's leverage first, then smaller size", () => {
  it("coin offers 10x, configured 50x: picks 10x at full size; the configured attempt is logged first", () => {
    const r = fitSearch(50, leverageCandidates(50, 10, [], AD), sizeCandidates(AD), (l) => ({ pass: l <= 10, failedGates: l <= 10 ? [] : ["leverage"], value: l }));
    expect([r.chosen?.leverage, r.chosen?.sizePct]).toEqual([10, 100]);
    expect(r.first.leverage).toBe(50);
  });
  it("thin book: keeps the coin's leverage and shrinks the size (never drops to 7x for depth)", () => {
    const r = fitSearch(20, leverageCandidates(20, 25, [], AD), sizeCandidates(AD), depthOnly(1000));
    expect([r.chosen?.leverage, r.chosen?.sizePct]).toEqual([20, 50]);
  });
  it("book too thin even at min size: no trade instead of lowering leverage below the coin's max", () => {
    const r = fitSearch(20, leverageCandidates(20, 25, [], AD), sizeCandidates(AD), depthOnly(400));
    expect(r.chosen).toBeNull();
    expect([r.last.leverage, r.last.sizePct]).toEqual([20, 25]);
  });
  it("chase / volatility at the coin's leverage are not dodged by lowering leverage", () => {
    const r = fitSearch(20, [20, 15, 10, 5], [100, 50], (l) => ({ pass: l <= 5, failedGates: l <= 5 ? [] : ["chase"], value: null }));
    expect(r.chosen).toBeNull();
  });
  it("lowers leverage below the coin's max only when the leverage itself fails (tier cap, liq buffer)", () => {
    // liq buffer passes only at <= 10x
    const r = fitSearch(20, [20, 15, 10], [100, 50], (l) => ({ pass: l <= 10, failedGates: l <= 10 ? [] : ["liq_buffer"], value: null }));
    expect([r.chosen?.leverage, r.chosen?.sizePct]).toEqual([10, 100]);
  });
  it("stops at a gate no lever can fix (spread)", () => {
    let n = 0;
    const r = fitSearch(50, [20, 10], [100, 50], () => {
      n++;
      return { pass: false, failedGates: ["leverage", "spread"], value: null };
    });
    expect(r.chosen).toBeNull();
    expect(r.stoppedBy).toBe("spread");
    expect(n).toBe(1);
  });
  it("size-only fit (leverage off): requested leverage, smaller sizes", () => {
    const r = fitSearch(20, leverageCandidates(20, 25, [], { ...AD, leverage: "off" }), sizeCandidates(AD), depthOnly(700));
    expect([r.chosen?.leverage, r.chosen?.sizePct]).toEqual([20, 35]);
  });
});
