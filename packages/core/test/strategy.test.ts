import { describe, expect, it } from "vitest";
import {
  BOT1_PRESET,
  BOT2_PRESET,
  BotConfigSchema,
  D,
  emptyRow,
  evaluateRules,
  exitLevels,
  exitPreview,
  expandProfiles,
  initTrail,
  onTick,
  onTp1Fill,
  stopHit,
  validateBotConfig,
  computeKpis,
  checkFilters,
} from "../src";

describe("rules", () => {
  it("Bot 1 matches only when all enabled rows pass; null metric is false", () => {
    const row = { ...emptyRow("SOL"), oi_chg_5m: 2.5, price_chg_5m: 0.05, vol_chg_1h: 55 };
    expect(evaluateRules(row, BOT1_PRESET.rules).matched).toBe(true);
    expect(evaluateRules({ ...row, vol_chg_1h: null }, BOT1_PRESET.rules).matched).toBe(false);
    expect(evaluateRules({ ...row, oi_chg_5m: 1.99 }, BOT1_PRESET.rules).matched).toBe(false);
    // disabled rows still reported
    expect(evaluateRules(row, BOT1_PRESET.rules).results.length).toBe(15);
  });
  describe("Bot 2: any 3 of 5 OI and any 1 of 3 Volume, strict > 0", () => {
    const ev = (r: Partial<ReturnType<typeof emptyRow>>) => evaluateRules({ ...emptyRow("X"), ...r }, BOT2_PRESET.rules, BOT2_PRESET.ruleGroups);
    const oi3 = { oi_chg_5m: 1, oi_chg_30m: 1, oi_chg_4h: 1 };
    it("3 OI + 1 Volume matches; price is not required", () => {
      const r = ev({ ...oi3, vol_chg_4h: 0.1, price_chg_5m: -5 });
      expect(r.matched).toBe(true);
      expect(r.groups).toEqual([
        { name: "OI", passed: 3, required: 3, pass: true },
        { name: "Volume", passed: 1, required: 1, pass: true },
      ]);
    });
    it("2 OI is not enough; 0 counts as not positive; null never passes", () => {
      expect(ev({ oi_chg_5m: 1, oi_chg_15m: 1, oi_chg_1h: 0, vol_chg_1h: 1 }).matched).toBe(false);
      expect(ev({ oi_chg_5m: 1, oi_chg_15m: 1, oi_chg_30m: null, vol_chg_1h: 1 }).matched).toBe(false);
    });
    it("no positive Volume rejects", () => {
      expect(ev({ ...oi3, vol_chg_5m: 0, vol_chg_1h: -1, vol_chg_4h: null }).matched).toBe(false);
    });
    it("rows outside every group are still AND-ed", () => {
      const rules = BOT2_PRESET.rules.map((r) => (r.metric === "price_chg_5m" ? { ...r, enabled: true, op: "gt" as const } : r));
      const row = { ...emptyRow("X"), ...oi3, vol_chg_1h: 1, price_chg_5m: 0 };
      expect(evaluateRules(row, rules, BOT2_PRESET.ruleGroups).matched).toBe(false);
      expect(evaluateRules({ ...row, price_chg_5m: 0.1 }, rules, BOT2_PRESET.ruleGroups).matched).toBe(true);
    });
  });
  it("filters", () => {
    const row = { ...emptyRow("PEPE"), oi_value: 1e6 };
    expect(checkFilters(row, { ...BOT1_PRESET.filters, blacklist: ["pepe"] }, null)).toContain("SYMBOL_BLACKLISTED");
    expect(checkFilters(row, { ...BOT1_PRESET.filters, minOiValue: 2e6 }, null)).toContain("FILTER_MIN_OI");
  });
});

describe("profiles / grid", () => {
  it("Bot 1 has one profile, Bot 2 has 6 leverages x 5 trails = 30 at $100 each", () => {
    expect(expandProfiles(BOT1_PRESET)).toHaveLength(1);
    const g = expandProfiles(BOT2_PRESET);
    expect(g).toHaveLength(30);
    expect(new Set(g.map((p) => p.variantId)).size).toBe(30);
    expect([...new Set(g.map((p) => p.leverage))]).toEqual([5, 10, 15, 20, 30, 50]);
    expect(BOT2_PRESET.sizing).toEqual({ mode: "fixed", value: "100" });
    expect(BOT2_PRESET.cooldownHours * 60).toBe(15);
    expect(BOT2_PRESET.reentry).toBe("while_open");
  });
  it("Bot 2 live runs only the selected variant", () => {
    const live = { ...BOT2_PRESET, mode: "live" as const, liveSelection: { leverage: 20, variantId: "T2" } };
    const p = expandProfiles(live);
    expect(p).toHaveLength(1);
    expect(p[0]!.variantId).toBe("20x-T2");
  });
});

describe("validator", () => {
  it("preview: 20% ROE = 0.40% price at 50x, liq -1.61%", () => {
    const pv = exitPreview(expandProfiles(BOT1_PRESET)[0]!);
    expect(pv.slPricePct.toFixed(2)).toBe("-0.40");
    expect(pv.tp1PricePct.toFixed(2)).toBe("0.40");
    expect(pv.liqPricePct.toFixed(2)).toBe("-1.61");
    expect(pv.feeRoe.toString()).toBe("5");
    expect(pv.slOk).toBe(true);
  });
  it("defaults are valid", () => {
    expect(validateBotConfig(BOT1_PRESET).errors).toEqual([]);
    expect(validateBotConfig(BOT2_PRESET).errors).toEqual([]);
  });
  it("default gates (user change 2026-11-10): spread 0.2%, slippage 0.2%, depth 5x, the rest as PRD", () => {
    expect(BOT1_PRESET.gates).toMatchObject({ maxSpreadPct: 0.2, maxEntrySlippagePct: 0.2, entryDepthMult: 5, exitDepthMult: 5, maxCostToTargetPct: 40, maxChasePct: 50, maxVolatilityPct: 300, maxFundingPct: 0.1, maxBookAgeMs: 2000 });
    expect(BOT2_PRESET.gates).toEqual(BOT1_PRESET.gates);
  });
  it("rejects SL beyond liquidation (price basis 20% at 50x)", () => {
    const bad = BotConfigSchema.parse({ ...BOT1_PRESET, exits: { ...BOT1_PRESET.exits, basis: "price" } });
    const r = validateBotConfig(bad);
    expect(r.errors.map((e) => e.code)).toContain("LIQ_BUFFER");
  });
  it("rejects SL inside the liq buffer", () => {
    // 50x: liq -1.606%, min SL with 25% buffer = -1.205% => 61% ROE. 70% ROE must be rejected.
    const bad = { ...BOT1_PRESET, exits: { ...BOT1_PRESET.exits, slPct: 70 } };
    expect(validateBotConfig(bad).errors.map((e) => e.code)).toContain("LIQ_BUFFER");
    const ok = { ...BOT1_PRESET, exits: { ...BOT1_PRESET.exits, slPct: 55 } };
    expect(validateBotConfig(ok).errors).toEqual([]);
  });
  it("warns when fees >= 30% of TP1 (100x)", () => {
    const r = validateBotConfig({ ...BOT2_PRESET, leverages: [100] });
    expect(r.warnings.some((w) => w.code === "FEES_HIGH_VS_TP1" && w.variantId?.startsWith("100x"))).toBe(true);
  });
  it("live requires max capital and a single grid selection", () => {
    const r = validateBotConfig({ ...BOT2_PRESET, mode: "live" });
    expect(r.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["CAPITAL_CAP", "INVALID_CONFIG"]));
  });
  it("re-entry while open is paper only", () => {
    const live = { ...BOT1_PRESET, mode: "live" as const, risk: { ...BOT1_PRESET.risk, maxCapital: "100" }, reentry: "while_open" as const };
    expect(validateBotConfig(live).errors.some((e) => e.message.includes("paper only"))).toBe(true);
    expect(validateBotConfig({ ...live, reentry: "after_close" }).errors).toEqual([]);
  });
  it("rule groups: disabled metric, impossible minPass and overlap are rejected", () => {
    const off = BOT2_PRESET.rules.map((r) => (r.metric === "vol_chg_5m" ? { ...r, enabled: false } : r));
    expect(validateBotConfig({ ...BOT2_PRESET, rules: off }).errors.some((e) => e.message.includes("not an enabled rule"))).toBe(true);
    const big = [{ name: "Volume", metrics: ["vol_chg_1h" as const], minPass: 2 }];
    expect(validateBotConfig({ ...BOT2_PRESET, ruleGroups: big }).errors.some((e) => e.message.includes("needs 2"))).toBe(true);
    const dup = [...BOT2_PRESET.ruleGroups, { name: "Dup", metrics: ["oi_chg_5m" as const], minPass: 1 }];
    expect(validateBotConfig({ ...BOT2_PRESET, ruleGroups: dup }).errors.some((e) => e.message.includes("more than one"))).toBe(true);
  });
  it("rejects short in V1", () => {
    expect(validateBotConfig({ ...BOT1_PRESET, direction: "short" }).errors[0]!.code).toBe("INVALID_CONFIG");
  });
  it("adaptive entry: off by default, single profile only, min leverage not above the configured one", () => {
    expect(BOT1_PRESET.adaptive).toEqual({ leverage: "off", minLeverage: 5, size: "off", minSizePct: 25 });
    const fit = { leverage: "fit", minLeverage: 5, size: "fit", minSizePct: 25 } as const;
    expect(validateBotConfig({ ...BOT1_PRESET, adaptive: fit }).errors).toEqual([]);
    expect(validateBotConfig({ ...BOT2_PRESET, adaptive: fit }).errors.some((e) => e.message.includes("single leverage"))).toBe(true);
    expect(validateBotConfig({ ...BOT1_PRESET, adaptive: { ...fit, minLeverage: 75 } }).errors.some((e) => e.message.includes("min leverage"))).toBe(true);
  });
});

describe("trailing state machine (Bot 1 worked example)", () => {
  const p = expandProfiles(BOT1_PRESET)[0]!;
  const l = exitLevels(p, "0.05");

  it("initial SL -20, TP1 partial locks +10, trail only moves up", () => {
    let s = initTrail(l);
    expect(s.slRoe.toString()).toBe("-20");
    // ticks before TP1 with resting TP1 order: no arm, no move
    let st = onTick(s, l, D(15), true);
    expect(st.newSlRoe).toBeNull();
    s = st.state;
    // TP1 fill
    st = onTp1Fill(s, l);
    expect(st.newSlRoe!.toString()).toBe("10");
    s = st.state;
    // peak +35 -> SL +25
    st = onTick(s, l, D(35), false);
    expect(st.newSlRoe!.toString()).toBe("25");
    s = st.state;
    // pullback to +28 does not move SL down
    st = onTick(s, l, D(28), false);
    expect(st.newSlRoe).toBeNull();
    expect(st.state.slRoe.toString()).toBe("25");
    s = st.state;
    expect(stopHit(D(25), s)).toBe(true);
    expect(stopHit(D("25.01"), s)).toBe(false);
  });

  it("gap through SL is detected as a hit at any lower ROE", () => {
    const s = initTrail(l);
    expect(stopHit(D(-45), s)).toBe(true);
  });

  it("T4 arms at +10 ROE without TP1 and floors at lock +2", () => {
    const t4 = expandProfiles(BOT2_PRESET).find((x) => x.variantId === "50x-T4")!;
    const lv = exitLevels(t4, "0.05");
    let s = initTrail(lv);
    let st = onTick(s, lv, D(9), false);
    expect(st.state.armed).toBe(false);
    s = st.state;
    st = onTick(s, lv, D(10), false);
    expect(st.armedNow).toBe(true);
    expect(st.newSlRoe!.toString()).toBe("2");
    st = onTick(st.state, lv, D(20), false);
    expect(st.newSlRoe!.toString()).toBe("12");
  });

  it("T1 breakeven lock is entry + round-trip fees", () => {
    const t1 = expandProfiles(BOT2_PRESET).find((x) => x.variantId === "50x-T1")!;
    const lv = exitLevels(t1, "0.05");
    expect(lv.lockRoe.toString()).toBe("5");
    const st = onTp1Fill(initTrail(lv), lv);
    expect(st.newSlRoe!.toString()).toBe("10"); // peak 20 - 10 = 10 > lock 5
  });

  it("T0 fixed never trails", () => {
    const t0 = expandProfiles(BOT2_PRESET).find((x) => x.variantId === "50x-T0")!;
    const lv = exitLevels(t0, "0.05");
    const st = onTick(initTrail(lv), lv, D(50), false);
    expect(st.state.armed).toBe(false);
    expect(st.newSlRoe).toBeNull();
  });
});

describe("kpis", () => {
  it("computes win rate, PF, drawdown", () => {
    const k = computeKpis(
      [
        { netPnl: "10", fees: "1", funding: "0", slippageUsd: "0.1", exitTime: 1 },
        { netPnl: "-5", fees: "1", funding: "0.2", slippageUsd: "0.1", exitTime: 2 },
        { netPnl: "-5", fees: "1", funding: "0", slippageUsd: null, exitTime: 3 },
      ],
      D(100),
    );
    expect(k.winRatePct).toBe("33.33");
    expect(k.profitFactor).toBe("1.000");
    expect(k.maxDrawdown).toBe("10.0000");
    expect(k.maxDrawdownPct).toBe("9.09");
    expect(k.netPnl).toBe("0.0000");
  });
});
