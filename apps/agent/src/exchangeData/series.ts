import { emptyRow, type ExchangeId, type MetricRow } from "@oisniper/core";

/** Venues whose open interest is collected. All values are USD (contracts x contract size x mark). */
export const OI_VENUES: ExchangeId[] = ["binance", "bybit", "okx", "gate", "kucoin"];

export interface Pt {
  ts: number;
  v: number;
}
export interface Candle {
  ts: number; // open time
  close: number;
  quoteVol: number;
}

const M = 60_000;
const KEEP = 5 * 60 * M; // 5h of OI points (4h windows + slack)
const OI_TF: [string, number][] = [["5m", 5 * M], ["15m", 15 * M], ["30m", 30 * M], ["1h", 60 * M], ["4h", 240 * M]];
const PRICE_TF: [string, number][] = [["5m", 5 * M], ["15m", 15 * M], ["1h", 60 * M], ["4h", 240 * M]];

/**
 * Value at t: linear interpolation between the points around t when they are at most 5.5 min apart (history is on a
 * 5m grid, live polls every 20s), else the last point before t if it is no older than tol. null = missing, never 0.
 */
export function valueAt(pts: Pt[] | undefined, t: number, tol: number): number | null {
  if (!pts?.length) return null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    if (p.ts > t) continue;
    const next = pts[i + 1];
    if (next && next.ts - p.ts <= 330_000 && next.ts > p.ts) return p.v + ((next.v - p.v) * (t - p.ts)) / (next.ts - p.ts);
    return t - p.ts <= tol ? p.v : null;
  }
  return null;
}

const pct = (now: number | null, then: number | null) => (now != null && then != null && then > 0 ? (now / then - 1) * 100 : null);
const round = (v: number | null, dp = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/**
 * In-memory series per base symbol (plain base: PEPE, not 1000PEPE). OI per venue in USD, 5m and 1h candles of the
 * trade venue for price and volume, latest price and funding. Percent changes are computed here, not taken from anyone.
 */
export class SeriesStore {
  oi = new Map<string, Map<ExchangeId, Pt[]>>();
  k5 = new Map<string, Candle[]>();
  k1h = new Map<string, Candle[]>();
  price = new Map<string, Pt>();
  funding = new Map<string, number>();
  firstSeen = new Map<ExchangeId, number>();

  addOi(base: string, venue: ExchangeId, ts: number, usd: number | null): void {
    if (usd == null || !Number.isFinite(usd) || usd <= 0) return;
    let byV = this.oi.get(base);
    if (!byV) this.oi.set(base, (byV = new Map()));
    const arr = byV.get(venue) ?? [];
    if (arr.length && arr[arr.length - 1]!.ts >= ts) {
      // backfill arrives older than live points: insert in order (scan from the end), skip duplicates
      let i = arr.length;
      while (i > 0 && arr[i - 1]!.ts > ts) i--;
      if ((i > 0 && ts - arr[i - 1]!.ts < 30_000) || (i < arr.length && arr[i]!.ts - ts < 30_000)) return;
      arr.splice(i, 0, { ts, v: usd });
    } else arr.push({ ts, v: usd });
    // trim relative to the newest point (a backfill point must not trim live data)
    const cut = arr[arr.length - 1]!.ts - KEEP;
    let drop = 0;
    while (drop < arr.length && arr[drop]!.ts < cut) drop++;
    if (drop) arr.splice(0, drop);
    byV.set(venue, arr);
    this.firstSeen.set(venue, Math.min(this.firstSeen.get(venue) ?? ts, ts));
  }

  setCandles(base: string, tf: "5m" | "1h", c: Candle[]): void {
    const map = tf === "5m" ? this.k5 : this.k1h;
    const prev = map.get(base) ?? [];
    const byTs = new Map(prev.map((x) => [x.ts, x]));
    for (const x of c) byTs.set(x.ts, x);
    const keep = tf === "5m" ? 110 : 60;
    map.set(base, [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-keep));
  }

  /** Aggregated: sum over venues present at BOTH ends (a venue joining later never fakes a jump). */
  private oiChange(base: string, now: number, dt: number, venues: ExchangeId[]): number | null {
    const byV = this.oi.get(base);
    if (!byV) return null;
    let sNow = 0;
    let sThen = 0;
    let n = 0;
    for (const v of venues) {
      const pts = byV.get(v);
      const a = valueAt(pts, now, 90_000);
      const b = valueAt(pts, now - dt, Math.max(150_000, dt * 0.1));
      if (a == null || b == null) continue;
      sNow += a;
      sThen += b;
      n++;
    }
    return n ? pct(sNow, sThen) : null;
  }

  private priceAt(base: string, t: number): number | null {
    const k = this.k5.get(base);
    if (!k?.length) return null;
    // close of the last candle that ended at or before t
    for (let i = k.length - 1; i >= 0; i--) if (k[i]!.ts + 5 * M <= t + 1000) return t - (k[i]!.ts + 5 * M) <= 10 * M ? k[i]!.close : null;
    return null;
  }

  private volWindow(c: Candle[] | undefined, n: number, now: number, len: number): { cur: number; prev: number } | null {
    if (!c) return null;
    const done = c.filter((x) => x.ts + len <= now + 1000);
    if (done.length < 2 * n) return null;
    const last = done.slice(-n);
    const prev = done.slice(-2 * n, -n);
    // contiguous only
    if (last[last.length - 1]!.ts - prev[0]!.ts !== (2 * n - 1) * len) return null;
    return { cur: last.reduce((a, x) => a + x.quoteVol, 0), prev: prev.reduce((a, x) => a + x.quoteVol, 0) };
  }

  row(base: string, scope: "aggregated" | ExchangeId, now: number): MetricRow {
    const r = emptyRow(base);
    const venues = scope === "aggregated" ? OI_VENUES : [scope];
    const byV = this.oi.get(base);
    let total = 0;
    let any = false;
    for (const v of venues) {
      const a = valueAt(byV?.get(v), now, 90_000);
      if (a != null) {
        total += a;
        any = true;
      }
    }
    r.oi_value = any ? Math.round(total) : null;
    for (const [tf, dt] of OI_TF) r[`oi_chg_${tf}` as "oi_chg_5m"] = round(this.oiChange(base, now, dt, venues));
    const p = this.price.get(base);
    r.price = p && now - p.ts < 120_000 ? p.v : null;
    for (const [tf, dt] of PRICE_TF) r[`price_chg_${tf}` as "price_chg_5m"] = round(pct(r.price, this.priceAt(base, now - dt)));
    const h = this.k1h.get(base);
    const day = h?.filter((x) => x.ts <= now - 24 * 60 * M + 30 * M).at(-1);
    r.price_chg_24h = round(pct(r.price, day ? day.close : null));
    const k5 = this.k5.get(base);
    for (const [tf, n] of [["5m", 1], ["1h", 12], ["4h", 48]] as const) {
      const w = this.volWindow(k5, n, now, 5 * M);
      r[`vol_${tf}`] = w ? Math.round(w.cur) : null;
      r[`vol_chg_${tf}`] = w ? round(pct(w.cur, w.prev), 2) : null;
    }
    const d = this.volWindow(h, 24, now, 60 * M);
    r.vol_24h = d ? Math.round(d.cur) : null;
    r.vol_chg_24h = d ? round(pct(d.cur, d.prev), 2) : null;
    r.funding_rate = this.funding.get(base) ?? null;
    return r;
  }

  /** Venues whose own history covers 4h (KuCoin has no history endpoint and warms up live). */
  warmingUp(now: number): ExchangeId[] {
    return OI_VENUES.filter((v) => {
      const f = this.firstSeen.get(v);
      return f == null || now - f < 240 * M;
    });
  }
}
