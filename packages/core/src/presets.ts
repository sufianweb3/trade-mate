import { BotConfigSchema, type BotConfig, type Rule, type TrailVariant, type Gates } from "./schemas/strategy";
import { RULE_METRICS, type RuleMetric } from "./schemas/metrics";

/**
 * PRD Section 8 defaults. Do not change without being asked.
 * 2026-11-10, asked by the user after the run_2 replay: spread 0.2%, entry slippage 0.2%, depth 5x (was 0.05 / 0.05 / 20x).
 * Cost-to-target still caps total fees + slippage at 40% of the TP1 move.
 */
export const DEFAULT_GATES: Gates = {
  freshness: true,
  maxBookAgeMs: 2000,
  maxSpreadPct: 0.2,
  depthBandPct: 0.3,
  entryDepthMult: 5,
  exitDepthMult: 5,
  maxEntrySlippagePct: 0.2,
  maxCostToTargetPct: 40,
  maxChasePct: 50,
  maxVolatilityPct: 300,
  minVolume24h: 10_000_000,
  maxFundingPct: 0.1,
};

/** All rule metrics present, disabled unless listed. Disabled rows are still collected and logged. */
function rules(enabled: Partial<Record<RuleMetric, Pick<Rule, "op" | "value">>>): Rule[] {
  return RULE_METRICS.map((metric) => {
    const r = enabled[metric];
    return r
      ? { metric, enabled: true, op: r.op, value: r.value, value2: null }
      : { metric, enabled: false, op: "gte", value: 0, value2: null };
  });
}

/** PRD Section 13 trail variants. */
export const BOT2_VARIANTS: TrailVariant[] = [
  { id: "T0", name: "Fixed", tp1ClosePct: 100, trailEnabled: false, lockPct: 0, trailDistancePct: 0, breakevenFees: false, activatePct: null },
  { id: "T1", name: "Breakeven", tp1ClosePct: 50, trailEnabled: true, lockPct: 0, trailDistancePct: 10, breakevenFees: true, activatePct: null },
  { id: "T2", name: "Lock10", tp1ClosePct: 50, trailEnabled: true, lockPct: 10, trailDistancePct: 10, breakevenFees: false, activatePct: null },
  { id: "T3", name: "Runner", tp1ClosePct: 25, trailEnabled: true, lockPct: 5, trailDistancePct: 15, breakevenFees: false, activatePct: null },
  { id: "T4", name: "Early trail", tp1ClosePct: 0, trailEnabled: true, lockPct: 2, trailDistancePct: 8, breakevenFees: false, activatePct: 10 },
];

/** PRD Section 12. */
export const BOT1_PRESET: BotConfig = BotConfigSchema.parse({
  name: "Sniper",
  direction: "long",
  mode: "paper",
  rules: rules({
    oi_chg_5m: { op: "gte", value: 2 },
    price_chg_5m: { op: "gte", value: 0.02 },
    vol_chg_1h: { op: "gte", value: 40 },
  }),
  filters: {},
  leverages: [50],
  exits: {
    basis: "roe",
    slPct: 20,
    tp1Pct: 20,
    trailEnabled: true,
    tp1ClosePct: 50,
    lockPct: 10,
    trailDistancePct: 10,
    breakevenFees: true,
    maxHoldHours: 0,
    triggerPrice: "mark",
    liqBufferPct: 25,
  },
  variants: null,
  sizing: { mode: "pct_balance", value: "10" },
  gates: DEFAULT_GATES,
  risk: {
    maxOpenPositions: 5,
    maxDailyLossPct: 15,
    maxDrawdownPct: 40,
    consecutiveLossLimit: 5,
    consecutiveLossPauseMin: 60,
    maxCapital: null,
  },
  exchanges: "ALL",
  cooldownHours: 12,
  paperInitialFunds: "500",
  execution: {},
});

/**
 * PRD Section 13 (revised 2026-11-10 by the user): any 3 of OI 5m/15m/30m/1h/4h > 0 and any 1 of Volume 5m/1h/4h > 0.
 * Price rules off (still collected). 6 leverages x 5 trails, re-entry every 15 min even while positions are open.
 */
export const BOT2_PRESET: BotConfig = BotConfigSchema.parse({
  name: "Research Grid",
  direction: "long",
  mode: "paper",
  rules: rules({
    oi_chg_5m: { op: "gt", value: 0 },
    oi_chg_15m: { op: "gt", value: 0 },
    oi_chg_30m: { op: "gt", value: 0 },
    oi_chg_1h: { op: "gt", value: 0 },
    oi_chg_4h: { op: "gt", value: 0 },
    vol_chg_5m: { op: "gt", value: 0 },
    vol_chg_1h: { op: "gt", value: 0 },
    vol_chg_4h: { op: "gt", value: 0 },
  }),
  ruleGroups: [
    { name: "OI", metrics: ["oi_chg_5m", "oi_chg_15m", "oi_chg_30m", "oi_chg_1h", "oi_chg_4h"], minPass: 3 },
    { name: "Volume", metrics: ["vol_chg_5m", "vol_chg_1h", "vol_chg_4h"], minPass: 1 },
  ],
  filters: {},
  leverages: [5, 10, 15, 20, 30, 50],
  exits: {
    basis: "roe",
    slPct: 20,
    tp1Pct: 20,
    trailEnabled: true,
    tp1ClosePct: 50,
    lockPct: 10,
    trailDistancePct: 10,
    breakevenFees: true,
    maxHoldHours: 0,
    triggerPrice: "mark",
    liqBufferPct: 25,
  },
  variants: BOT2_VARIANTS,
  sizing: { mode: "fixed", value: "100" },
  gates: DEFAULT_GATES,
  risk: {
    maxOpenPositions: null,
    maxDailyLossPct: null,
    maxDrawdownPct: null,
    consecutiveLossLimit: null,
    consecutiveLossPauseMin: 60,
    maxCapital: null,
  },
  exchanges: "ALL",
  cooldownHours: 0.25,
  reentry: "while_open",
  paperInitialFunds: null,
  execution: {},
});
