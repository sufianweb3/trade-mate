import { D, Decimal, HUNDRED } from "../decimal";
import type { Sizing } from "../schemas/strategy";

export function floorToStep(v: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return v;
  return v.div(step).floor().mul(step);
}
export function ceilToStep(v: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return v;
  return v.div(step).ceil().mul(step);
}
export function roundToStep(v: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) return v;
  return v.div(step).round().mul(step);
}

/** Margin for one trade (per variant). */
export function marginFor(sizing: Sizing, balance: Decimal | null): Decimal {
  if (sizing.mode === "fixed") return D(sizing.value);
  if (balance == null) return D(0);
  return balance.mul(sizing.value).div(HUNDRED);
}

export interface SizeInput {
  margin: Decimal;
  leverage: number;
  price: Decimal;
  /** Lot step in base qty (already converted from contracts by symbols/). */
  qtyStep: Decimal;
  minQty: Decimal;
  minNotional: Decimal;
  maxQty: Decimal | null;
}

export type SizeResult =
  | { ok: true; qty: Decimal; notional: Decimal; margin: Decimal }
  | { ok: false; code: "LOT_SIZE" | "MIN_NOTIONAL" | "TIER_SIZE_EXCEEDED"; detail: Record<string, string> };

/**
 * Qty is rounded DOWN to the lot step so the margin used never exceeds the budget.
 * Over-limit sizes are rejected, never clamped (CLAUDE.md rule 5).
 */
export function sizeOrder(i: SizeInput): SizeResult {
  const notionalTarget = i.margin.mul(i.leverage);
  const raw = notionalTarget.div(i.price);
  const qty = floorToStep(raw, i.qtyStep);
  if (i.maxQty && qty.gt(i.maxQty))
    return { ok: false, code: "TIER_SIZE_EXCEEDED", detail: { qty: qty.toString(), maxQty: i.maxQty.toString() } };
  if (qty.lte(0) || qty.lt(i.minQty))
    return { ok: false, code: "LOT_SIZE", detail: { qty: qty.toString(), minQty: i.minQty.toString() } };
  const notional = qty.mul(i.price);
  if (notional.lt(i.minNotional))
    return { ok: false, code: "MIN_NOTIONAL", detail: { notional: notional.toString(), minNotional: i.minNotional.toString() } };
  return { ok: true, qty, notional, margin: notional.div(i.leverage) };
}
