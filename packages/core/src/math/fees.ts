import { D, Decimal, HUNDRED, ZERO } from "../decimal";

/** Fee in USDT. ratePct is a percent (0.05 = 0.05%). */
export function feeFor(notional: Decimal.Value, ratePct: Decimal.Value): Decimal {
  return D(notional).mul(ratePct).div(HUNDRED);
}

/** Funding cost for a long in USDT. Positive rate: longs pay (positive result). rate is a fraction per interval. */
export function fundingCostLong(notionalAtMark: Decimal.Value, rate: Decimal.Value): Decimal {
  return D(notionalAtMark).mul(rate);
}

/** Round-trip taker fees expressed in ROE %. */
export function roundTripFeeRoe(takerPct: Decimal.Value, leverage: Decimal.Value): Decimal {
  return D(takerPct).mul(2).mul(leverage);
}

export interface ExitLeg {
  price: Decimal;
  qty: Decimal;
  fee: Decimal;
}

export interface PnlInput {
  entryPrice: Decimal;
  entryFee: Decimal;
  legs: ExitLeg[];
  funding: Decimal;
  margin: Decimal;
}

export interface PnlResult {
  gross: Decimal;
  fees: Decimal;
  funding: Decimal;
  net: Decimal;
  netRoePct: Decimal;
}

/** Long PnL. gross = sum((exit - entry) * qty); net = gross - fees - funding. */
export function computePnl(i: PnlInput): PnlResult {
  let gross = ZERO;
  let fees = i.entryFee;
  for (const l of i.legs) {
    gross = gross.add(l.price.sub(i.entryPrice).mul(l.qty));
    fees = fees.add(l.fee);
  }
  const net = gross.sub(fees).sub(i.funding);
  const netRoePct = i.margin.isZero() ? ZERO : net.div(i.margin).mul(HUNDRED);
  return { gross, fees, funding: i.funding, net, netRoePct };
}
