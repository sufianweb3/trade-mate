import { D, Decimal, HUNDRED, ONE } from "../decimal";

/** Convert a TP/SL setting to ROE %. Price basis: ROE = price % x leverage. */
export function toRoe(pctValue: Decimal.Value, basis: "roe" | "price", leverage: Decimal.Value): Decimal {
  return basis === "roe" ? D(pctValue) : D(pctValue).mul(leverage);
}

export function roeToPricePct(roe: Decimal.Value, leverage: Decimal.Value): Decimal {
  return D(roe).div(leverage);
}

export function pricePctToRoe(pricePct: Decimal.Value, leverage: Decimal.Value): Decimal {
  return D(pricePct).mul(leverage);
}

/** Long: price at which ROE (on margin = notional / leverage) equals `roe`. */
export function priceAtRoe(entry: Decimal.Value, roe: Decimal.Value, leverage: Decimal.Value): Decimal {
  return D(entry).mul(ONE.add(D(roe).div(HUNDRED).div(leverage)));
}

/** Long: ROE % at `price`. */
export function roeAtPrice(entry: Decimal.Value, price: Decimal.Value, leverage: Decimal.Value): Decimal {
  return D(price).div(entry).sub(1).mul(leverage).mul(HUNDRED);
}

/** Long: % price change from entry. */
export function pricePctMove(entry: Decimal.Value, price: Decimal.Value): Decimal {
  return D(price).div(entry).sub(1).mul(HUNDRED);
}
