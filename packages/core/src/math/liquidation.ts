import { D, Decimal, HUNDRED, ONE } from "../decimal";
import type { ExchangeId } from "../schemas/strategy";

export interface MarginTier {
  /** Upper notional bound of this tier in USDT. null = unbounded. */
  maxNotional: Decimal | null;
  /** Maintenance margin rate as a fraction (0.004 = 0.4%). */
  mmr: Decimal;
  /** Maintenance amount / deduction in USDT (Binance "cum"). */
  cum: Decimal;
  maxLeverage: number;
}

export type LiqFormula = "binance" | "standard";

/**
 * Binance uses MMR applied at the liquidation price. Bybit, OKX, Gate, KuCoin and MEXC compute
 * maintenance margin on the position value at entry (isolated, one-way, no extra margin added).
 */
export const LIQ_FORMULA: Record<ExchangeId, LiqFormula> = {
  binance: "binance",
  bybit: "standard",
  okx: "standard",
  gate: "standard",
  kucoin: "standard",
  mexc: "standard",
};

export function tierFor(tiers: MarginTier[], notional: Decimal): MarginTier | null {
  for (const t of tiers) if (t.maxNotional == null || notional.lte(t.maxNotional)) return t;
  return null;
}

/** Build cumulative maintenance amounts the way Binance documents them. */
export function buildTiers(
  rows: { maxNotional: Decimal.Value | null; mmrPct: Decimal.Value; maxLeverage: number }[],
): MarginTier[] {
  const out: MarginTier[] = [];
  let prevMmr = D(0);
  let prevCum = D(0);
  let floor = D(0);
  for (const r of rows) {
    const mmr = D(r.mmrPct).div(HUNDRED);
    const cum = prevCum.add(floor.mul(mmr.sub(prevMmr)));
    out.push({ maxNotional: r.maxNotional == null ? null : D(r.maxNotional), mmr, cum, maxLeverage: r.maxLeverage });
    prevMmr = mmr;
    prevCum = cum;
    floor = r.maxNotional == null ? floor : D(r.maxNotional);
  }
  return out;
}

export interface LiqInput {
  formula: LiqFormula;
  entry: Decimal;
  qty: Decimal;
  /** Isolated margin assigned to the position. */
  margin: Decimal;
  tier: Pick<MarginTier, "mmr" | "cum">;
}

/** Isolated long liquidation price. */
export function liqPriceLong(i: LiqInput): Decimal {
  const { entry, qty, margin, tier } = i;
  if (i.formula === "binance") {
    // LP = (WB + cum - Q*EP) / (Q*MMR - Q)
    const num = margin.add(tier.cum).sub(qty.mul(entry));
    const den = qty.mul(tier.mmr).sub(qty);
    const lp = num.div(den);
    return lp.lt(0) ? D(0) : lp;
  }
  // LP = EP - (IM - MM) / Q, MM = notional * mmr - deduction
  const mm = qty.mul(entry).mul(tier.mmr).sub(tier.cum);
  const lp = entry.sub(margin.sub(mm).div(qty));
  return lp.lt(0) ? D(0) : lp;
}

/** Quick estimate (no tiers) used for config validation and UI previews: % price move to liq. */
export function estimateLiqPricePct(leverage: Decimal.Value, mmr: Decimal.Value = "0.004", formula: LiqFormula = "binance"): Decimal {
  const entry = D(1);
  const qty = D(1);
  const lp = liqPriceLong({ formula, entry, qty, margin: ONE.div(leverage), tier: { mmr: D(mmr), cum: D(0) } });
  return lp.sub(1).mul(HUNDRED);
}
