import type { MetricRow, RuleMetric } from "./schemas/metrics";
import type { BotConfig, Filters, Rule, RuleGroup, TrailVariant } from "./schemas/strategy";

export interface RuleResult {
  metric: RuleMetric;
  enabled: boolean;
  value: number | null;
  pass: boolean;
}

export function evalRule(rule: Rule, value: number | null): boolean {
  // A rule on a null metric evaluates false (PRD 5.1).
  if (value == null || !Number.isFinite(value)) return false;
  switch (rule.op) {
    case "gte":
      return value >= rule.value;
    case "lte":
      return value <= rule.value;
    case "gt":
      return value > rule.value;
    case "lt":
      return value < rule.value;
    case "between":
      return rule.value2 != null && value >= rule.value && value <= rule.value2;
  }
}

export interface GroupResult {
  name: string;
  passed: number;
  required: number;
  pass: boolean;
}

/**
 * Enabled rows outside every group are AND-ed (PRD 6.1 V1). Each group passes when at least `minPass` of its enabled
 * rows pass. Disabled rows are still reported for logging and never count toward a group.
 */
export function evaluateRules(
  row: MetricRow,
  rules: Rule[],
  groups: RuleGroup[] = [],
): { matched: boolean; results: RuleResult[]; groups: GroupResult[] } {
  const results = rules.map((r) => {
    const value = row[r.metric];
    return { metric: r.metric, enabled: r.enabled, value, pass: evalRule(r, value) };
  });
  const enabled = results.filter((r) => r.enabled);
  const grouped = new Set(groups.flatMap((g) => g.metrics));
  const groupResults = groups.map((g) => {
    const passed = enabled.filter((r) => g.metrics.includes(r.metric) && r.pass).length;
    return { name: g.name, passed, required: g.minPass, pass: passed >= g.minPass };
  });
  const matched =
    enabled.length > 0 &&
    enabled.filter((r) => !grouped.has(r.metric)).every((r) => r.pass) &&
    groupResults.every((g) => g.pass);
  return { matched, results, groups: groupResults };
}

export type FilterReject =
  | "SYMBOL_BLACKLISTED"
  | "FILTER_WHITELIST"
  | "FILTER_MIN_OI"
  | "FILTER_MIN_VOLUME"
  | "FILTER_MAX_FUNDING"
  | "FILTER_LISTING_AGE";

export function checkFilters(row: MetricRow, f: Filters, listingAgeDays: number | null): FilterReject[] {
  const out: FilterReject[] = [];
  const sym = row.symbol.toUpperCase();
  if (f.blacklist.map((s) => s.toUpperCase()).includes(sym)) out.push("SYMBOL_BLACKLISTED");
  if (f.whitelist.length > 0 && !f.whitelist.map((s) => s.toUpperCase()).includes(sym)) out.push("FILTER_WHITELIST");
  if (f.minOiValue != null && !(row.oi_value != null && row.oi_value >= f.minOiValue)) out.push("FILTER_MIN_OI");
  if (f.minVolume24h != null && !(row.vol_24h != null && row.vol_24h >= f.minVolume24h)) out.push("FILTER_MIN_VOLUME");
  if (f.maxFundingRate != null && row.funding_rate != null && row.funding_rate > f.maxFundingRate)
    out.push("FILTER_MAX_FUNDING");
  if (f.minListingAgeDays != null && !(listingAgeDays != null && listingAgeDays >= f.minListingAgeDays))
    out.push("FILTER_LISTING_AGE");
  return out;
}

/** One concrete leverage x exit profile. Bot 1 has one, the Bot 2 grid has one per leverage x trail variant. */
export interface ExitProfile {
  variantId: string;
  variantName: string;
  leverage: number;
  basis: "roe" | "price";
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  trailEnabled: boolean;
  lockPct: number;
  trailDistancePct: number;
  breakevenFees: boolean;
  activatePct: number | null;
  maxHoldHours: number;
  triggerPrice: "mark" | "last";
  liqBufferPct: number;
}

function profile(cfg: BotConfig, leverage: number, v: TrailVariant | null): ExitProfile {
  const e = cfg.exits;
  return {
    variantId: v ? `${leverage}x-${v.id}` : `${leverage}x`,
    variantName: v ? v.name : "base",
    leverage,
    basis: e.basis,
    slPct: e.slPct,
    tp1Pct: e.tp1Pct,
    tp1ClosePct: v ? v.tp1ClosePct : e.trailEnabled ? e.tp1ClosePct : 100,
    trailEnabled: v ? v.trailEnabled : e.trailEnabled,
    lockPct: v ? v.lockPct : e.lockPct,
    trailDistancePct: v ? v.trailDistancePct : e.trailDistancePct,
    breakevenFees: v ? v.breakevenFees : e.breakevenFees,
    activatePct: v ? v.activatePct : null,
    maxHoldHours: e.maxHoldHours,
    triggerPrice: e.triggerPrice,
    liqBufferPct: e.liqBufferPct,
  };
}

/** Expand a config into the exit profiles one signal opens. Grid is a config feature, not separate code. */
export function expandProfiles(cfg: BotConfig): ExitProfile[] {
  if (cfg.mode === "live" && cfg.variants && cfg.liveSelection) {
    const v = cfg.variants.find((x) => x.id === cfg.liveSelection!.variantId) ?? null;
    return v ? [profile(cfg, cfg.liveSelection.leverage, v)] : [];
  }
  const out: ExitProfile[] = [];
  for (const lev of cfg.leverages) {
    if (cfg.variants) for (const v of cfg.variants) out.push(profile(cfg, lev, v));
    else out.push(profile(cfg, lev, null));
  }
  return out;
}

/** Stable JSON (sorted keys) for hashing strategy versions. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
