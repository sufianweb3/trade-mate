import { buildTiers, D, Decimal, tierFor, type ExchangeId, type MarginTier } from "@oisniper/core";
import { z } from "zod";
import { log } from "../log";
import type { MarketInfo } from "./types";

const CcxtTier = z.object({
  maxNotional: z.number().nullable().optional(),
  maintenanceMarginRate: z.number(),
  maxLeverage: z.number(),
});

/** ccxt leverage tiers -> MarginTier[] in USDT notional. OKX reports tier sizes in contracts. */
export function tiersFromCcxt(raw: unknown, ex: ExchangeId, contractSize: Decimal, price: Decimal | null): MarginTier[] | null {
  const p = z.array(CcxtTier).safeParse(raw);
  if (!p.success || p.data.length === 0) return null;
  const inContracts = ex === "okx";
  if (inContracts && !price) return null;
  const rows = [...p.data]
    .sort((a, b) => (a.maxNotional ?? Infinity) - (b.maxNotional ?? Infinity))
    .map((t, i, all) => ({
      maxNotional: i === all.length - 1 || t.maxNotional == null ? null : inContracts ? D(t.maxNotional).mul(contractSize).mul(price!) : D(t.maxNotional),
      mmrPct: D(t.maintenanceMarginRate).mul(100),
      maxLeverage: Math.floor(t.maxLeverage),
    }));
  return buildTiers(rows);
}

/** Per notional band: highest maintenance rate and lowest max leverage of all sets. Never better than any venue. */
export function strictestTiers(sets: MarginTier[][]): MarginTier[] {
  const valid = sets.filter((s) => s.length > 0);
  if (valid.length === 0) return [];
  if (valid.length === 1) return valid[0]!;
  const bps = [...new Set(valid.flatMap((s) => s.filter((t) => t.maxNotional).map((t) => t.maxNotional!.toNumber())))].sort((a, b) => a - b);
  const rows: { maxNotional: number | null; mmrPct: Decimal; maxLeverage: number }[] = [];
  for (const bp of [...bps, null]) {
    const probe = D(bp ?? (bps[bps.length - 1] ?? 0) * 2 + 1);
    const ts = valid.map((s) => tierFor(s, probe) ?? s[s.length - 1]!);
    rows.push({
      maxNotional: bp,
      mmrPct: ts.reduce((a, t) => Decimal.max(a, t.mmr), D(0)).mul(100),
      maxLeverage: Math.min(...ts.map((t) => t.maxLeverage)),
    });
  }
  return buildTiers(rows);
}

/** Base without exchange multiplier prefix (1000PEPE -> PEPE) for cross-venue lookups. */
export const plainBase = (b: string) => b.toUpperCase().replace(/^(1000000|1M|10000|1000)/, "");

const PUBLIC_TIERS: ExchangeId[] = ["bybit", "okx", "gate", "kucoin"];
const CROSS_VENUES: ExchangeId[] = ["bybit", "okx", "gate"];
const TTL = 15 * 60_000;

export interface LimitsDeps {
  call: (ex: ExchangeId, method: string, ...args: unknown[]) => Promise<unknown>;
  has: (ex: ExchangeId, method: string) => boolean;
  markets: (ex: ExchangeId) => MarketInfo[];
  price: (ex: ExchangeId, symbol: string) => Promise<Decimal | null>;
  update: (m: MarketInfo) => void;
  now: () => number;
}

/**
 * Real leverage limits + maintenance tiers. Binance with a key: private brackets. Bybit/OKX/Gate/KuCoin: public tiers.
 * Otherwise: lowest public limit across Bybit/OKX/Gate, flagged unverified. Unknown stays 0 (trade rejected).
 */
export class LimitsService {
  private cache = new Map<string, number>();
  private privateLoaders = new Map<ExchangeId, (symbol: string) => Promise<unknown>>();
  private inflight = new Map<string, Promise<void>>();

  constructor(private d: LimitsDeps) {}

  setPrivateLoader(ex: ExchangeId, fn: ((symbol: string) => Promise<unknown>) | null): void {
    if (fn) this.privateLoaders.set(ex, fn);
    else this.privateLoaders.delete(ex);
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${ex}|`)) this.cache.delete(k);
  }

  resolve(ex: ExchangeId, symbol: string): Promise<void> {
    const k = `${ex}|${symbol}`;
    if ((this.cache.get(k) ?? 0) > this.d.now()) return Promise.resolve();
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.load(ex, symbol).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private market(ex: ExchangeId, symbol: string) {
    return this.d.markets(ex).find((m) => m.symbol === symbol) ?? null;
  }

  private async ownTiers(ex: ExchangeId, m: MarketInfo): Promise<{ tiers: MarginTier[]; source: MarketInfo["limitsSource"] } | null> {
    try {
      const priv = this.privateLoaders.get(ex);
      if (priv) {
        const t = tiersFromCcxt(await priv(m.symbol), ex, m.contractSize, await this.d.price(ex, m.symbol));
        if (t) return { tiers: t, source: "exchange_private" };
      }
      if (PUBLIC_TIERS.includes(ex) && this.d.has(ex, "fetchMarketLeverageTiers")) {
        const t = tiersFromCcxt(await this.d.call(ex, "fetchMarketLeverageTiers", m.symbol), ex, m.contractSize, await this.d.price(ex, m.symbol));
        if (t) return { tiers: t, source: "exchange_public" };
      }
    } catch (e) {
      log.debug({ ex, symbol: m.symbol, err: (e as Error).message }, "tier fetch failed");
    }
    return null;
  }

  private async load(ex: ExchangeId, symbol: string): Promise<void> {
    const m = this.market(ex, symbol);
    if (!m) return;
    const own = await this.ownTiers(ex, m);
    if (own) {
      const lev = Math.min(own.tiers[0]!.maxLeverage, m.maxLeverage > 0 ? m.maxLeverage : Infinity);
      this.d.update({ ...m, tiers: own.tiers, maxLeverage: lev, limitsSource: own.source, leverageVerified: true });
    } else {
      // Cross-venue: the lowest public limit for the same coin elsewhere. Never higher than any venue's real limit.
      const base = plainBase(m.base);
      const others: { lev: number; tiers: MarginTier[] }[] = [];
      for (const v of CROSS_VENUES) {
        if (v === ex) continue;
        const om = this.d.markets(v).find((x) => plainBase(x.base) === base && x.active);
        if (!om) continue;
        const t = await this.ownTiers(v, om);
        const lev = Math.min(om.maxLeverage > 0 ? om.maxLeverage : Infinity, t?.tiers[0]?.maxLeverage ?? Infinity);
        if (Number.isFinite(lev)) others.push({ lev, tiers: t?.tiers ?? [] });
      }
      if (others.length) {
        const lev = Math.min(...others.map((o) => o.lev), m.maxLeverage > 0 ? m.maxLeverage : Infinity);
        const tiers = strictestTiers([...others.map((o) => o.tiers), m.leverageVerified ? m.tiers : []]);
        this.d.update({ ...m, maxLeverage: lev, tiers: tiers.length ? tiers : m.tiers, limitsSource: "cross_venue_min", leverageVerified: false });
      } else if (!m.leverageVerified) {
        this.d.update({ ...m, maxLeverage: 0, limitsSource: "unknown", leverageVerified: false });
      }
    }
    this.cache.set(`${ex}|${symbol}`, this.d.now() + TTL);
  }
}
