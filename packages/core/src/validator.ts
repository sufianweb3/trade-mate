import { D, Decimal, HUNDRED } from "./decimal";
import type { ErrorCode } from "./errors";
import { roundTripFeeRoe } from "./math/fees";
import { estimateLiqPricePct } from "./math/liquidation";
import { toRoe } from "./math/roe";
import type { BotConfig } from "./schemas/strategy";
import { expandProfiles, type ExitProfile } from "./strategy";

export interface ConfigIssue {
  code: ErrorCode | "FEES_HIGH_VS_TP1";
  message: string;
  variantId?: string;
}

export interface ExitPreview {
  leverage: number;
  slPricePct: Decimal;
  tp1PricePct: Decimal;
  liqPricePct: Decimal;
  /** Lowest allowed SL price % (liq + buffer). */
  minSlPricePct: Decimal;
  feeRoe: Decimal;
  feeShareOfTp1Pct: Decimal;
  slOk: boolean;
}

/** Live conversion shown under inputs: "20% ROE = 0.40% price at 50x, liq at -1.61%". */
export function exitPreview(p: ExitProfile, takerPct: Decimal.Value = "0.05", mmr: Decimal.Value = "0.004"): ExitPreview {
  const lev = p.leverage;
  const slRoe = toRoe(p.slPct, p.basis, lev);
  const tp1Roe = toRoe(p.tp1Pct, p.basis, lev);
  const slPricePct = slRoe.div(lev).neg();
  const tp1PricePct = tp1Roe.div(lev);
  const liqPricePct = estimateLiqPricePct(lev, mmr);
  const minSlPricePct = liqPricePct.mul(D(1).sub(D(p.liqBufferPct).div(HUNDRED)));
  const feeRoe = roundTripFeeRoe(takerPct, lev);
  return {
    leverage: lev,
    slPricePct,
    tp1PricePct,
    liqPricePct,
    minSlPricePct,
    feeRoe,
    feeShareOfTp1Pct: tp1Roe.isZero() ? D(0) : feeRoe.div(tp1Roe).mul(HUNDRED),
    slOk: slPricePct.gt(minSlPricePct),
  };
}

/** Blocks Save and Start when errors is non-empty. */
export function validateBotConfig(
  cfg: BotConfig,
  opts: { takerPct?: Decimal.Value; mmr?: Decimal.Value } = {},
): { errors: ConfigIssue[]; warnings: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  if (cfg.direction === "short") errors.push({ code: "INVALID_CONFIG", message: "Short trades are disabled until V2." });
  if (cfg.exits.trailEnabled && !cfg.variants && cfg.exits.tp1ClosePct >= 100)
    warnings.push({ code: "INVALID_CONFIG", message: "TP1 closes 100%, trailing never runs." });
  if (cfg.mode === "live") {
    if (!cfg.risk.maxCapital || D(cfg.risk.maxCapital).lte(0))
      errors.push({ code: "CAPITAL_CAP", message: "Live mode requires max capital." });
    if (cfg.variants && !cfg.liveSelection)
      errors.push({ code: "INVALID_CONFIG", message: "Live grid bots must pick exactly one leverage and trail variant." });
    if (cfg.liveSelection && !cfg.leverages.includes(cfg.liveSelection.leverage))
      errors.push({ code: "INVALID_CONFIG", message: "Live leverage must be one of the configured leverages." });
    if (!cfg.variants && cfg.leverages.length !== 1)
      errors.push({ code: "INVALID_CONFIG", message: "Live bots run a single leverage." });
    if (cfg.paperInitialFunds == null && !cfg.risk.maxCapital)
      errors.push({ code: "CAPITAL_CAP", message: "Unlimited funds are paper only." });
  }
  const profiles = expandProfiles(cfg);
  if (profiles.length === 0) errors.push({ code: "INVALID_CONFIG", message: "No exit profile selected." });
  const ad = cfg.adaptive;
  const adaptiveOn = ad.leverage === "fit" || ad.size === "fit";
  if (adaptiveOn && profiles.length > 1)
    errors.push({ code: "INVALID_CONFIG", message: "Adaptive leverage / size needs a single leverage and exit profile (the research grid tests fixed leverages)." });
  if (ad.leverage === "fit" && profiles.some((p) => ad.minLeverage > p.leverage))
    errors.push({ code: "INVALID_CONFIG", message: `Adaptive min leverage (${ad.minLeverage}x) is above the configured leverage.` });
  if (ad.leverage === "fit" && cfg.exits.basis === "roe")
    warnings.push({ code: "INVALID_CONFIG", message: `Adaptive leverage keeps TP/SL in ROE: at ${ad.minLeverage}x a ${cfg.exits.slPct}% ROE stop is ${(cfg.exits.slPct / ad.minLeverage).toFixed(2)}% in price (same $ risk, wider stop).` });
  if (!cfg.rules.some((r) => r.enabled)) errors.push({ code: "INVALID_CONFIG", message: "Enable at least one rule." });
  const seen = new Set<string>();
  for (const g of cfg.ruleGroups) {
    for (const m of g.metrics) {
      if (seen.has(m)) errors.push({ code: "INVALID_CONFIG", message: `${m} is in more than one rule group.` });
      seen.add(m);
      if (!cfg.rules.some((r) => r.metric === m && r.enabled))
        errors.push({ code: "INVALID_CONFIG", message: `Rule group "${g.name}" uses ${m}, which is not an enabled rule.` });
    }
    if (g.minPass > g.metrics.length)
      errors.push({ code: "INVALID_CONFIG", message: `Rule group "${g.name}" needs ${g.minPass} passes but has ${g.metrics.length} rules.` });
  }
  // One-way mode holds one position per symbol per account, so stacking entries is paper only.
  if (cfg.mode === "live" && cfg.reentry === "while_open")
    errors.push({ code: "INVALID_CONFIG", message: "Re-entry while a position is open is paper only." });
  for (const p of profiles) {
    const pv = exitPreview(p, opts.takerPct, opts.mmr);
    if (!pv.slOk)
      errors.push({
        code: "LIQ_BUFFER",
        variantId: p.variantId,
        message: `SL at ${pv.slPricePct.toFixed(2)}% price sits beyond liquidation buffer (liq ${pv.liqPricePct.toFixed(2)}%, min SL ${pv.minSlPricePct.toFixed(2)}%) at ${p.leverage}x.`,
      });
    if (pv.feeShareOfTp1Pct.gte(30))
      warnings.push({
        code: "FEES_HIGH_VS_TP1",
        variantId: p.variantId,
        message: `Round-trip fees are ${pv.feeRoe.toFixed(1)}% ROE = ${pv.feeShareOfTp1Pct.toFixed(0)}% of TP1 at ${p.leverage}x.`,
      });
  }
  return { errors, warnings };
}
