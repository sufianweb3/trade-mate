import type { ExchangeId, MetricRow } from "@oisniper/core";
import { log } from "../log";
import type { CcxtHub } from "../market/ccxtHub";
import { call } from "../market/quirks/types";
import type { SnapshotSource, SourceResult } from "../scraper/source";
import { pollVenue, type Caller, type VenueItem } from "./collectors";
import { backfillOi, loadCandles } from "./history";
import { OI_VENUES, SeriesStore } from "./series";

export const EXCHANGE_SOURCE = "exchange";

/**
 * Signal data from free public exchange APIs: OI (USD) from Binance, Bybit, OKX, Gate and KuCoin; price and
 * volume from 5m/1h candles of the trade venue. Universe = top N coins by 24h volume that a trade venue lists.
 * Emits aggregated rows plus per-venue rows ("exchange:<venue>") for the venue-only OI scope.
 */
export class ExchangeDataSource implements SnapshotSource {
  readonly name = EXCHANGE_SOURCE;
  readonly series = new SeriesStore();
  private ids = new Map<string, Partial<Record<ExchangeId, string>>>();
  private mults = new Map<string, Partial<Record<ExchangeId, number>>>();
  private universe: string[] = [];
  private lastK5 = 0;
  private lastK1h = 0;
  private backfilled = new Set<string>();
  private backfilling = false;
  private candlesBusy = false;
  private errors = new Map<ExchangeId, string>();

  constructor(private hub: CcxtHub, private o: { universeSize: () => number; now: () => number }) {}

  private caller: Caller = (ex, method, params) => {
    const c = this.hub.publicClient(ex);
    if (!c) return Promise.reject(new Error(`${ex} not connected`));
    return call(c, method, ...(params ? [params] : []));
  };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setVisible(): Promise<void> {}

  private tradeBases(): Set<string> {
    const s = new Set<string>();
    for (const ex of this.hub.exchanges) for (const m of this.hub.markets(ex)) s.add(m.base.toUpperCase().replace(/^(1000000|1M|10000|1000)/, ""));
    return s;
  }

  private gateMults(): Map<string, number> {
    return new Map(this.hub.markets("gate").map((m) => [`${m.base}_USDT`, m.contractSize.toNumber()]));
  }

  async read(): Promise<SourceResult> {
    const now = this.o.now();
    const venues = OI_VENUES.filter((v) => this.hub.publicClient(v));
    const polls = await Promise.all(
      venues.map(async (v) => {
        try {
          // 15s budget per venue: one slow venue must not stall the whole read (stale data blocks entries)
          const items = await Promise.race([
            pollVenue(v, this.caller, { gateMults: this.gateMults(), binanceOi: new Set(this.universe) }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("poll timeout 15s")), 15_000)),
          ]);
          this.errors.delete(v);
          return [v, items] as const;
        } catch (e) {
          this.errors.set(v, (e as Error).message.slice(0, 120));
          return [v, [] as VenueItem[]] as const;
        }
      }),
    );
    const dataTs = this.o.now();
    // universe: top N by best venue 24h volume, tradeable somewhere
    const vol = new Map<string, number>();
    const tradeable = this.tradeBases();
    for (const [v, items] of polls)
      for (const it of items) {
        if (!tradeable.has(it.base)) continue;
        vol.set(it.base, Math.max(vol.get(it.base) ?? 0, it.vol24hUsd ?? 0));
        const ids = this.ids.get(it.base) ?? {};
        ids[v] = it.id;
        this.ids.set(it.base, ids);
        const ms = this.mults.get(it.base) ?? {};
        ms[v] = it.mult;
        this.mults.set(it.base, ms);
      }
    this.universe = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.o.universeSize()).map(([b]) => b);
    const uni = new Set(this.universe);
    for (const [v, items] of polls)
      for (const it of items) {
        if (!uni.has(it.base)) continue;
        this.series.addOi(it.base, v, dataTs, it.oiUsd);
        if (v === "binance" || (v === "bybit" && !this.ids.get(it.base)?.binance)) {
          if (it.price != null) this.series.price.set(it.base, { ts: dataTs, v: it.price });
          if (it.fundingPct != null) this.series.funding.set(it.base, it.fundingPct);
        }
      }
    // Candles refresh in the background so detection follows the OI data immediately (latency: source -> detected).
    if (!this.candlesBusy) {
      this.candlesBusy = true;
      void this.refreshCandles(now).finally(() => (this.candlesBusy = false));
    }
    if (!this.backfilling && this.universe.some((b) => !this.backfilled.has(b))) void this.backfill();
    const rows: MetricRow[] = this.universe.map((b) => this.series.row(b, "aggregated", this.o.now()));
    const variants: Record<string, MetricRow[]> = {};
    for (const v of venues) variants[`${EXCHANGE_SOURCE}:${v}`] = this.universe.map((b) => this.series.row(b, v, this.o.now()));
    const warming = this.series.warmingUp(this.o.now());
    const notes = [
      warming.length ? `warming up: ${warming.join(", ")}` : "",
      this.errors.size ? `errors: ${[...this.errors.entries()].map(([k, e]) => `${k} ${e}`).join("; ")}` : "",
      this.universe.some((b) => !this.backfilled.has(b)) ? `backfilling ${this.universe.filter((b) => !this.backfilled.has(b)).length} coins` : "",
    ].filter(Boolean);
    return { table: { headers: [], rows: [] }, challenge: false, rows, variants, dataTs, note: notes.join(" | ") || undefined };
  }

  /** Candles: universe 5m every 60s (last 3 bars), 1h every 10 min. New coins load their full history once. */
  private async refreshCandles(now: number) {
    const due5 = now - this.lastK5 >= 60_000;
    const due1h = now - this.lastK1h >= 600_000;
    if (!due5 && !due1h) return;
    if (due5) this.lastK5 = now;
    if (due1h) this.lastK1h = now;
    const list = this.universe;
    for (let i = 0; i < list.length; i += 20) {
      await Promise.all(
        list.slice(i, i + 20).map(async (b) => {
          const ids = this.ids.get(b) ?? {};
          const mult = this.mults.get(b)?.binance ?? this.mults.get(b)?.bybit ?? 1;
          const full = due1h || !this.series.k5.has(b);
          await loadCandles(this.caller, this.series, b, { binance: ids.binance, bybit: ids.bybit }, mult, full).catch(() => false);
        }),
      );
    }
  }

  private async backfill() {
    this.backfilling = true;
    try {
      for (const b of this.universe.filter((x) => !this.backfilled.has(x))) {
        if (!this.series.k5.has(b)) continue; // Bybit history needs candle prices first
        await backfillOi(this.caller, this.series, b, this.ids.get(b) ?? {}, this.mults.get(b) ?? {}).catch((e) => log.debug({ b, err: (e as Error).message }, "backfill failed"));
        this.backfilled.add(b);
      }
    } finally {
      this.backfilling = false;
    }
  }
}
