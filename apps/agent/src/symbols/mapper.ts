import { D, Decimal, type ExchangeId } from "@oisniper/core";
import type { MarketInfo } from "../market/types";

/** Multiplier prefixes exchanges use for low-priced coins. Longest first. */
const PREFIXES: { prefix: string; mult: number }[] = [
  { prefix: "1000000", mult: 1_000_000 },
  { prefix: "1M", mult: 1_000_000 },
  { prefix: "10000", mult: 10_000 },
  { prefix: "1000", mult: 1000 },
  { prefix: "", mult: 1 },
];

export interface SymbolMapping {
  coinglass: string;
  exchange: ExchangeId;
  symbol: string;
  multiplier: number;
}

export type MapResult =
  | { ok: true; mapping: SymbolMapping; verified: boolean }
  | { ok: false; reason: "UNLISTED" | "PRICE_MISMATCH" | "NOT_TRADING"; detail?: string };

export interface MarketSource {
  markets(ex: ExchangeId): MarketInfo[];
}

/** CoinGlass base symbol -> exchange unified perp symbol. Only place multipliers are resolved. */
export class SymbolMapper {
  private index = new Map<ExchangeId, Map<string, MarketInfo>>();
  private overrides = new Map<string, string>();

  constructor(private src: MarketSource) {}

  setOverrides(rows: { coinglass: string; exchange: string; unified: string }[]): void {
    this.overrides.clear();
    for (const r of rows) this.overrides.set(`${r.exchange}:${r.coinglass.toUpperCase()}`, r.unified);
  }

  /** Rebuild the base -> market index (call after markets load). */
  reindex(exchanges: ExchangeId[]): void {
    for (const ex of exchanges) {
      const m = new Map<string, MarketInfo>();
      for (const mk of this.src.markets(ex)) m.set(mk.base.toUpperCase(), mk);
      this.index.set(ex, m);
    }
  }

  /**
   * Resolve and, when both prices are known, verify by price ratio (+/-2%).
   * exchangePrice is per exchange unit (e.g. per 1000PEPE); cgPrice per single coin.
   */
  resolve(coinglass: string, ex: ExchangeId, cgPrice: number | null, exchangePrice: Decimal | null): MapResult {
    const base = coinglass.toUpperCase();
    const idx = this.index.get(ex);
    if (!idx) return { ok: false, reason: "UNLISTED" };
    const ov = this.overrides.get(`${ex}:${base}`);
    let found: { mk: MarketInfo; mult: number } | null = null;
    if (ov) {
      const mk = [...idx.values()].find((x) => x.symbol === ov);
      if (mk) found = { mk, mult: multiplierOf(mk.base, base) };
    }
    if (!found) {
      for (const { prefix, mult } of PREFIXES) {
        const mk = idx.get(`${prefix}${base}`);
        if (mk) {
          found = { mk, mult };
          break;
        }
      }
    }
    if (!found) return { ok: false, reason: "UNLISTED" };
    if (!found.mk.active) return { ok: false, reason: "NOT_TRADING" };
    const mapping: SymbolMapping = { coinglass: base, exchange: ex, symbol: found.mk.symbol, multiplier: found.mult };
    if (cgPrice == null || cgPrice <= 0 || !exchangePrice) return { ok: true, mapping, verified: false };
    const ratio = exchangePrice.div(D(cgPrice).mul(found.mult));
    if (ratio.sub(1).abs().gt("0.02"))
      return { ok: false, reason: "PRICE_MISMATCH", detail: `ratio ${ratio.toFixed(4)} for ${found.mk.symbol} x${found.mult}` };
    return { ok: true, mapping, verified: true };
  }
}

function multiplierOf(exBase: string, cg: string): number {
  const up = exBase.toUpperCase();
  for (const { prefix, mult } of PREFIXES) if (up === `${prefix}${cg}`) return mult;
  return 1;
}
