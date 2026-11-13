import { z } from "zod";
import { RULE_METRICS } from "./metrics";

export const EXCHANGES = ["binance", "bybit", "okx", "gate", "kucoin", "mexc"] as const;
export const ExchangeId = z.enum(EXCHANGES);
export type ExchangeId = z.infer<typeof ExchangeId>;

const decStr = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");

export const RuleOp = z.enum(["gte", "lte", "gt", "lt", "between"]);
export type RuleOp = z.infer<typeof RuleOp>;

export const RuleSchema = z
  .object({
    metric: z.enum(RULE_METRICS),
    enabled: z.boolean(),
    op: RuleOp,
    value: z.number().finite(),
    value2: z.number().finite().nullable().default(null),
  })
  .refine((r) => r.op !== "between" || (r.value2 != null && r.value2 >= r.value), {
    message: "between needs value2 >= value",
  });
export type Rule = z.infer<typeof RuleSchema>;

/**
 * "At least N of these" rule group. Its metrics must be enabled rules; the group passes when at least `minPass` of
 * them pass. Enabled rules outside every group are still AND-ed.
 */
export const RuleGroupSchema = z.object({
  name: z.string().min(1).max(40),
  metrics: z.array(z.enum(RULE_METRICS)).min(1),
  minPass: z.number().int().min(1),
});
export type RuleGroup = z.infer<typeof RuleGroupSchema>;

export const FiltersSchema = z.object({
  minOiValue: z.number().nonnegative().nullable().default(null),
  minVolume24h: z.number().nonnegative().nullable().default(null),
  maxFundingRate: z.number().nullable().default(null),
  whitelist: z.array(z.string()).default([]),
  blacklist: z.array(z.string()).default([]),
  minListingAgeDays: z.number().nonnegative().nullable().default(null),
});
export type Filters = z.infer<typeof FiltersSchema>;

export const ExitsSchema = z.object({
  basis: z.enum(["roe", "price"]).default("roe"),
  slPct: z.number().positive(),
  tp1Pct: z.number().positive(),
  trailEnabled: z.boolean(),
  tp1ClosePct: z.number().min(0).max(100),
  lockPct: z.number(),
  trailDistancePct: z.number().nonnegative(),
  breakevenFees: z.boolean().default(true),
  maxHoldHours: z.number().nonnegative().default(0),
  triggerPrice: z.enum(["mark", "last"]).default("mark"),
  /** SL must sit above liq + this share of (entry - liq). */
  liqBufferPct: z.number().min(0).max(100).default(25),
});
export type Exits = z.infer<typeof ExitsSchema>;

/** Bot 2 trail profile. Overrides the exit fields it names. */
export const TrailVariantSchema = z.object({
  id: z.string().min(1).max(8),
  name: z.string(),
  tp1ClosePct: z.number().min(0).max(100),
  trailEnabled: z.boolean(),
  lockPct: z.number(),
  trailDistancePct: z.number().nonnegative(),
  breakevenFees: z.boolean(),
  /** When set, trailing activates at this ROE instead of TP1 (used with tp1ClosePct = 0). */
  activatePct: z.number().positive().nullable().default(null),
});
export type TrailVariant = z.infer<typeof TrailVariantSchema>;

export const SizingSchema = z.object({
  mode: z.enum(["pct_balance", "fixed"]),
  /** pct_balance: percent of balance used as margin. fixed: USDT margin. */
  value: decStr,
});
export type Sizing = z.infer<typeof SizingSchema>;

export const GatesSchema = z.object({
  freshness: z.boolean().default(true),
  maxBookAgeMs: z.number().int().positive().default(2000),
  maxSpreadPct: z.number().positive(),
  depthBandPct: z.number().positive().default(0.3),
  entryDepthMult: z.number().nonnegative(),
  exitDepthMult: z.number().nonnegative(),
  maxEntrySlippagePct: z.number().nonnegative(),
  maxCostToTargetPct: z.number().positive(),
  maxChasePct: z.number().positive(),
  maxVolatilityPct: z.number().positive(),
  minVolume24h: z.number().nonnegative(),
  maxFundingPct: z.number(),
});
export type Gates = z.infer<typeof GatesSchema>;

export const RiskSchema = z.object({
  maxOpenPositions: z.number().int().positive().nullable(),
  maxDailyLossPct: z.number().positive().max(100).nullable(),
  maxDrawdownPct: z.number().positive().max(100).nullable(),
  consecutiveLossLimit: z.number().int().positive().nullable(),
  consecutiveLossPauseMin: z.number().int().positive().default(60),
  /** Required in Live. USDT the bot may use. */
  maxCapital: decStr.nullable().default(null),
});
export type Risk = z.infer<typeof RiskSchema>;

export const ExecutionCfgSchema = z.object({
  /** IOC price cap: best price +/- this %. */
  maxSlippagePct: z.number().positive().default(0.1),
  minFillPct: z.number().min(0).max(100).default(80),
  latencyOverrideMs: z.number().int().nonnegative().nullable().default(null),
  /** Taker fee override per exchange (percent), e.g. VIP tier. */
  takerFeeOverridePct: z.record(z.string(), z.number().nonnegative()).default({}),
});
export type ExecutionCfg = z.infer<typeof ExecutionCfgSchema>;

/**
 * Adaptive entry (opt-in; PRD Section 13 keeps clamping OFF by default). When on, the engine searches the chosen
 * venue for the highest leverage <= the configured one, then the largest size <= the configured margin, at which
 * every gate passes. It never raises leverage or size. Every fit is logged on the signal and the trade.
 */
export const AdaptiveSchema = z.object({
  /** off = a leverage the symbol does not offer is rejected (LEVERAGE_UNAVAILABLE). fit = step down to what works. */
  leverage: z.enum(["off", "fit"]).default("off"),
  /** Lowest leverage the fit may use. */
  minLeverage: z.number().int().min(1).max(200).default(5),
  /** off = configured margin only. fit = shrink margin when depth / slippage / cost gates need a smaller order. */
  size: z.enum(["off", "fit"]).default("off"),
  /** Smallest share of the configured margin the fit may use. */
  minSizePct: z.number().min(1).max(100).default(25),
});
export type Adaptive = z.infer<typeof AdaptiveSchema>;

/** Where signals come from. Both sources are always collected; this picks the one the bot trades on. */
export const DataSourceSchema = z.object({
  kind: z.enum(["coinglass", "exchange"]).default("coinglass"),
  /** Exchange source: aggregated USD OI across venues (closest to CoinGlass) or the trade venue only. */
  oiScope: z.enum(["aggregated", "venue"]).default("aggregated"),
});
export type DataSource = z.infer<typeof DataSourceSchema>;

export const BotConfigSchema = z.object({
  name: z.string().min(1).max(40),
  dataSource: DataSourceSchema.default({}),
  direction: z.enum(["long", "short"]).default("long"),
  mode: z.enum(["paper", "live"]).default("paper"),
  rules: z.array(RuleSchema),
  /** Empty = every enabled rule AND-ed (PRD 6.1 V1 logic). */
  ruleGroups: z.array(RuleGroupSchema).default([]),
  filters: FiltersSchema,
  leverages: z.array(z.number().int().min(1).max(200)).min(1),
  exits: ExitsSchema,
  /** null = single exit profile from `exits` (Bot 1). Array = research grid (Bot 2). */
  variants: z.array(TrailVariantSchema).nullable().default(null),
  /** Live grid bots run exactly one leverage + variant. */
  liveSelection: z
    .object({ leverage: z.number().int().min(1), variantId: z.string() })
    .nullable()
    .default(null),
  sizing: SizingSchema,
  adaptive: AdaptiveSchema.default({}),
  gates: GatesSchema,
  risk: RiskSchema,
  exchanges: z.union([z.literal("ALL"), z.array(ExchangeId).min(1)]),
  cooldownHours: z.number().nonnegative(),
  /**
   * after_close (PRD 6.3): an open position blocks the symbol; the window runs from entry and from close.
   * while_open (paper research only): the window runs from the last entry, open positions do not block.
   */
  reentry: z.enum(["after_close", "while_open"]).default("after_close"),
  /** null = unlimited paper funds (equity tracked from 0). */
  paperInitialFunds: decStr.nullable(),
  execution: ExecutionCfgSchema,
});
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type BotConfigInput = z.input<typeof BotConfigSchema>;
