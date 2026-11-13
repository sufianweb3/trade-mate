import Decimal from "decimal.js";

// Money math precision. 40 significant digits is far beyond any exchange tick.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export type DecimalValue = Decimal.Value;

export const D = (v: Decimal.Value): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

export const dmax = (a: Decimal, b: Decimal): Decimal => (a.gt(b) ? a : b);
export const dmin = (a: Decimal, b: Decimal): Decimal => (a.lt(b) ? a : b);

/** Percentage (e.g. 0.05 meaning 0.05%) to fraction (0.0005). */
export const pct = (p: Decimal.Value): Decimal => D(p).div(100);

/** Serialize a decimal for storage / transport. Never use floats on the wire for money. */
export const ds = (v: Decimal | null | undefined): string | null => (v == null ? null : v.toString());
