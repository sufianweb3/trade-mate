import { buildTiers, D, Decimal, floorToStep, type ExchangeId, type MarginTier } from "@oisniper/core";
import { z } from "zod";
import type { MarketInfo } from "../market/types";

/** The only place contract <-> base conversion happens. */
export function contractsToBase(contracts: Decimal.Value, contractSize: Decimal): Decimal {
  return D(contracts).mul(contractSize);
}

/** Base qty -> whole contract steps, rounded DOWN (never more size than requested). */
export function baseToContracts(base: Decimal, contractSize: Decimal, contractStep: Decimal): Decimal {
  return floorToStep(base.div(contractSize), contractStep);
}

/** Exchanges that size orders in contracts. Binance and Bybit use base units. */
export const CONTRACT_SIZED: Record<ExchangeId, boolean> = {
  binance: false,
  bybit: false,
  okx: true,
  gate: true,
  kucoin: true,
  mexc: true,
};

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(e-?\d+)?$/i)]).transform((v) => D(v));
const optNum = num.nullable().optional();

const CcxtMarket = z.object({
  symbol: z.string(),
  base: z.string(),
  settle: z.string().nullable().optional(),
  swap: z.boolean().optional(),
  linear: z.boolean().nullable().optional(),
  active: z.boolean().nullable().optional(),
  contractSize: optNum,
  taker: optNum,
  maker: optNum,
  created: z.number().nullable().optional(),
  precision: z.object({ amount: optNum, price: optNum }).partial(),
  limits: z
    .object({
      amount: z.object({ min: optNum, max: optNum }).partial().optional(),
      cost: z.object({ min: optNum }).partial().optional(),
      leverage: z.object({ max: optNum }).partial().optional(),
    })
    .partial(),
});

export type RawMarket = z.input<typeof CcxtMarket>;

/** Fallback tiers when the exchange does not expose them publicly (conservative: Binance-like bracket 1). */
export const DEFAULT_TIERS: MarginTier[] = buildTiers([
  { maxNotional: 50_000, mmrPct: "0.5", maxLeverage: 100 },
  { maxNotional: 250_000, mmrPct: "1", maxLeverage: 50 },
  { maxNotional: 1_000_000, mmrPct: "2.5", maxLeverage: 20 },
  { maxNotional: null, mmrPct: "5", maxLeverage: 10 },
]);

/** Normalize a ccxt USDT linear perp market into base-asset units. Returns null for non-USDT-perp or bad data. */
export function normalizeMarket(exchange: ExchangeId, raw: unknown, tiers: MarginTier[] | null): MarketInfo | null {
  const p = CcxtMarket.safeParse(raw);
  if (!p.success) return null;
  const m = p.data;
  if (m.swap === false || m.linear === false || (m.settle && m.settle !== "USDT")) return null;
  const cs = m.contractSize && m.contractSize.gt(0) ? m.contractSize : D(1);
  const amountStep = m.precision.amount && m.precision.amount.gt(0) ? m.precision.amount : D(1);
  const minAmount = m.limits.amount?.min ?? amountStep;
  return {
    exchange,
    symbol: m.symbol,
    base: m.base,
    active: m.active !== false,
    contractSize: cs,
    qtyStep: contractsToBase(amountStep, cs),
    minQty: contractsToBase(minAmount, cs),
    minNotional: m.limits.cost?.min ?? D(5),
    tickSize: m.precision.price && m.precision.price.gt(0) ? m.precision.price : D("0.0001"),
    // No leverage limit in the market data (Binance public) = unknown (0) until LimitsService resolves the real
    // one. Never a guessed value: 0 makes the leverage gate reject.
    maxLeverage: m.limits.leverage?.max ? m.limits.leverage.max.toNumber() : 0,
    tiers: tiers ?? DEFAULT_TIERS,
    limitsSource: m.limits.leverage?.max ? "market" : "unknown",
    leverageVerified: !!m.limits.leverage?.max,
    takerPct: (m.taker ?? D("0.0005")).mul(100),
    makerPct: (m.maker ?? D("0.0002")).mul(100),
    listedAt: m.created ?? null,
  };
}
