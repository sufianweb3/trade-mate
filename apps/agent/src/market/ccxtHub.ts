import { D, Decimal, parseLevels, type Book, type ExchangeId } from "@oisniper/core";
import { z } from "zod";
import { log } from "../log";
import { contractsToBase, CONTRACT_SIZED, normalizeMarket } from "../symbols/contracts";
import type { Clock } from "../util/clock";
import { BaseHub, dec } from "./baseHub";
import { QUIRKS, type CcxtLike } from "./quirks";
import { applyTestnet, call } from "./quirks/types";
import { LimitsService } from "./limits";
import type { PricePoint } from "./types";

type Client = CcxtLike & {
  loadMarkets(): Promise<Record<string, unknown>>;
  fetchTime(): Promise<number>;
  close?(): Promise<void>;
};

const BOOK_MIN_MS = 200;
const RESYNC_MS = 5_000;
/** Best bid >= best ask: the local book lost deltas. */
export const isCrossed = (b: Book): boolean => {
  const bid = b.bids[0]?.[0];
  const ask = b.asks[0]?.[0];
  return !!bid && !!ask && !bid.lt(ask);
};
/**
 * Book boundary check without zod (it ran on every WS update of ~100 levels): bids / asks must be arrays of arrays;
 * parseLevels then keeps only rows whose price and qty are numbers or strings.
 */
function rawLevels(raw: unknown): { bids: unknown[][]; asks: unknown[][] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { bids, asks } = raw as { bids?: unknown; asks?: unknown };
  const ok = (x: unknown): x is unknown[][] => Array.isArray(x) && (x.length === 0 || Array.isArray(x[0]));
  return ok(bids) && ok(asks) ? { bids, asks } : null;
}
const FundingMsg = z.object({
  markPrice: z.number().nullable().optional(),
  indexPrice: z.number().nullable().optional(),
  fundingRate: z.number().nullable().optional(),
  fundingTimestamp: z.number().nullable().optional(),
  nextFundingTimestamp: z.number().nullable().optional(),
  interval: z.string().nullable().optional(),
});
const TickerMsg = z.object({ symbol: z.string(), last: z.number().nullable().optional(), quoteVolume: z.number().nullable().optional() });
const Ohlcv = z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).rest(z.unknown()));

const INTERVALS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000, "8h": 28_800_000 };

/** Public market data via ccxt (REST + WS through ccxt.pro). No keys. */
export class CcxtHub extends BaseHub {
  private clients = new Map<ExchangeId, Client>();
  private timeClients = new Map<ExchangeId, Client>();
  private loops = new Map<string, boolean>();
  private timers: (() => void)[] = [];
  readonly limits: LimitsService;

  constructor(exchanges: ExchangeId[], clock: Clock, private opts: { testnet?: boolean } = {}) {
    super(exchanges, clock);
    this.silenceIsGap = false;
    this.limits = new LimitsService({
      call: (ex, method, ...args) => call(this.clients.get(ex)!, method, ...args),
      has: (ex, method) => !!this.clients.get(ex)?.has[method],
      markets: (ex) => this.markets(ex),
      price: async (ex, s) => this.lastTick(ex, s)?.mark ?? (await this.fetchPrice(ex, s).catch(() => null)),
      update: (m) => this.updateMarket(m),
      now: () => this.clock.now(),
    });
  }

  /** Public ccxt client (bulk tickers / OI for the exchange data engine). */
  publicClient(ex: ExchangeId): Client | null {
    return this.clients.get(ex) ?? null;
  }

  override resolveLimits(ex: ExchangeId, symbol: string): Promise<void> {
    return this.clients.has(ex) ? this.limits.resolve(ex, symbol) : Promise.resolve();
  }

  private async loadMarkets(ex: ExchangeId, c: Client, reload: boolean) {
    const raw = reload ? await (c.loadMarkets as (r: boolean) => Promise<Record<string, unknown>>).call(c, true) : await c.loadMarkets();
    const prev = new Map(this.markets(ex).map((m) => [m.symbol, m]));
    const list = Object.values(raw)
      .map((m) => normalizeMarket(ex, m, null))
      .filter((m): m is NonNullable<typeof m> => m != null)
      // keep limits already resolved from real tiers (refreshed by LimitsService on its own TTL)
      .map((m) => {
        const p = prev.get(m.symbol);
        return p && p.limitsSource !== "unknown" && p.limitsSource !== "market" ? { ...m, maxLeverage: p.maxLeverage, tiers: p.tiers, limitsSource: p.limitsSource, leverageVerified: p.leverageVerified } : m;
      });
    this.setMarkets(ex, list);
  }

  async start(): Promise<void> {
    const ccxt = (await import("ccxt")) as unknown as { pro: Record<string, new (o: Record<string, unknown>) => Client> };
    await Promise.all(
      this.exchanges.map(async (ex) => {
        const q = QUIRKS[ex];
        const Ctor = ccxt.pro[q.ccxtId];
        const h = this.healthBy.get(ex)!;
        if (!Ctor) return void (h.error = "ccxt.pro class missing");
        const c = new Ctor({ enableRateLimit: true, options: q.options });
        if (this.opts.testnet) {
          try {
            await applyTestnet(c, q);
          } catch {
            h.status = "disabled";
            h.error = "no testnet";
            return;
          }
        }
        this.clients.set(ex, c);
        // Clock sync gets its own idle client: on the shared one fetchTime waits in ccxt's rate-limit queue behind
        // data calls, and that wait reads as clock offset (measured: Binance 3 s vs 0.8 s elsewhere).
        const tc = new Ctor({ enableRateLimit: true, options: q.options });
        if (this.opts.testnet) await applyTestnet(tc, q).catch(() => undefined);
        this.timeClients.set(ex, tc);
        try {
          await tc.fetchTime(); // first call pays DNS + TLS; measure on a warm connection
          await this.loadMarkets(ex, c, false);
          h.status = "ok";
          h.error = null;
        } catch (e) {
          h.status = "down";
          h.error = (e as Error).message.slice(0, 200);
          log.warn({ ex, err: h.error }, "exchange init failed");
        }
      }),
    );
    await this.syncClock();
    // Markets, fees and limits refreshed every 15 min (PRD latency: never loaded in the hot path).
    this.timers.push(this.clock.setInterval(() => void this.refreshMarkets(), 15 * 60_000));
    this.timers.push(this.clock.setInterval(() => void this.refreshTickers(), 60_000));
    this.timers.push(this.clock.setInterval(() => void this.refreshFunding(), 15_000));
    this.timers.push(this.clock.setInterval(() => void this.syncClock(), 600_000));
    await this.refreshTickers();
  }

  private async refreshMarkets() {
    for (const [ex, c] of this.clients) await this.loadMarkets(ex, c, true).catch((e) => log.warn({ ex, err: (e as Error).message }, "market refresh failed"));
  }

  /** Offset from the lowest-RTT of 3 samples: one delayed response (busy loop, slow network) cannot fake an offset. */
  private async syncClock() {
    for (const [ex, c] of this.timeClients) {
      let best: { rtt: number; off: number } | null = null;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const st = await c.fetchTime().catch(() => null);
        const rtt = Date.now() - t0;
        if (st != null && (!best || rtt < best.rtt)) best = { rtt, off: st - (t0 + rtt / 2) };
      }
      if (!best) continue;
      this.recordRtt(ex, best.rtt);
      this.healthBy.get(ex)!.clockOffsetMs = best.off;
    }
  }

  private async refreshTickers() {
    for (const [ex, c] of this.clients) {
      if (!c.has.fetchTickers) continue;
      try {
        const raw = (await (c.fetchTickers as () => Promise<Record<string, unknown>>).call(c)) ?? {};
        for (const v of Object.values(raw)) {
          const t = TickerMsg.safeParse(v);
          if (!t.success || t.data.quoteVolume == null) continue;
          this.setVolume(ex, t.data.symbol, D(t.data.quoteVolume));
        }
      } catch (e) {
        log.debug({ ex, err: (e as Error).message }, "tickers failed");
      }
    }
  }

  private async refreshFunding() {
    for (const { ex, symbol } of this.subscribed()) await this.fetchFunding(ex, symbol);
  }

  private async fetchFunding(ex: ExchangeId, symbol: string) {
    const c = this.clients.get(ex);
    if (!c?.has.fetchFundingRate) return;
    try {
      const f = FundingMsg.parse(await (c.fetchFundingRate as (s: string) => Promise<unknown>).call(c, symbol));
      const next = f.nextFundingTimestamp ?? f.fundingTimestamp;
      if (f.fundingRate != null && next != null) this.setFunding(ex, symbol, { rate: D(f.fundingRate), nextTime: next, intervalMs: f.interval ? INTERVALS[f.interval] ?? null : null });
      const b = this.book(ex, symbol);
      const mid = b?.bids[0] && b.asks[0] ? b.bids[0][0].add(b.asks[0][0]).div(2) : null;
      const mark = dec(f.markPrice);
      this.lastMark.set(`${ex}|${symbol}`, { basis: mark && mid ? mark.sub(mid) : D(0), index: dec(f.indexPrice), hadBook: mid != null });
    } catch {
      /* funding is refreshed again in 15s */
    }
  }

  /** Mark = book mid + last observed (mark - mid) basis, so triggers track the book in real time. */
  private lastMark = new Map<string, { basis: Decimal; index: Decimal | null; hadBook: boolean }>();

  protected async openStream(ex: ExchangeId, symbol: string): Promise<void> {
    const c = this.clients.get(ex);
    const m = this.market(ex, symbol);
    if (!c || !m) return;
    const key = `${ex}|${symbol}`;
    this.loops.set(key, true);
    // Funding / mark basis in parallel with the snapshot (cold subscribe latency); basis is refreshed every 15s.
    const funding = this.fetchFunding(ex, symbol);
    const depth = QUIRKS[ex].bookLimit ?? 50;
    const toBook = (raw: unknown): Book | null => {
      const b = rawLevels(raw);
      if (!b) return null;
      const conv = (lv: ReturnType<typeof parseLevels>) => (CONTRACT_SIZED[ex] ? lv.map(([p, q]) => [p, contractsToBase(q, m.contractSize)] as [Decimal, Decimal]) : lv);
      return { ts: this.clock.now(), bids: conv(parseLevels(b.bids.slice(0, depth))), asks: conv(parseLevels(b.asks.slice(0, depth))) };
    };
    // Hot path: busy books send many updates per second. Converting every level to Decimal on each one saturated
    // the event loop (measured: 47 s stalls with ~40 books). Full book at most every BOOK_MIN_MS (gates accept
    // books up to 2 s old); every update still emits a top-of-book tick so stops and trailing see each move.
    let lastFull = 0;
    const restSnapshot = async () => {
      const snap = toBook(await (c.fetchOrderBook as (s: string, l: number) => Promise<unknown>).call(c, symbol, QUIRKS[ex].bookLimit ?? 50));
      if (snap && !isCrossed(snap)) this.onBook(ex, symbol, snap);
    };
    // A crossed WS book (bid >= ask) means dropped deltas: never store it (it would look like the cheapest venue and
    // feed a false mid to stops). Replace it from REST, at most every RESYNC_MS; until the stream heals the book ages
    // out and the router skips this venue as BOOK_STALE.
    let lastResync = 0;
    const resync = () => {
      const now = this.clock.now();
      if (now - lastResync < RESYNC_MS) return;
      lastResync = now;
      log.warn({ ex, symbol }, "crossed order book from stream, resyncing from REST");
      void restSnapshot().catch((e: unknown) => log.debug({ ex, symbol, err: (e as Error).message }, "book resync failed"));
    };
    // Initial REST snapshot, then WS deltas (ccxt.pro resyncs from REST on sequence gaps).
    try {
      await restSnapshot();
    } catch (e) {
      log.warn({ ex, symbol, err: (e as Error).message }, "book snapshot failed");
    }
    await funding;
    if (this.lastMark.get(key)?.hadBook === false && this.book(ex, symbol)) await this.fetchFunding(ex, symbol); // basis needs the book mid
    void (async () => {
      let backoff = 500;
      while (this.loops.get(key)) {
        try {
          const raw = await (c.watchOrderBook as (s: string, l: number) => Promise<unknown>).call(c, symbol, depth);
          const now = this.clock.now();
          if (now - lastFull >= BOOK_MIN_MS) {
            const b = toBook(raw);
            if (b) {
              lastFull = now;
              if (isCrossed(b)) resync();
              else this.onBook(ex, symbol, b);
            }
          } else this.onTop(ex, symbol, raw, now);
          backoff = 500;
          this.healthBy.get(ex)!.wsConnected = true;
        } catch (e) {
          this.healthBy.get(ex)!.wsConnected = false;
          this.markStreamDown(ex, symbol); // replay this window once the stream is back
          log.debug({ ex, symbol, err: (e as Error).message }, "ws book error, reconnecting");
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    })();
  }

  private onBook(ex: ExchangeId, symbol: string, b: Book) {
    this.pushBook(ex, symbol, b);
    const bid = b.bids[0]?.[0];
    const ask = b.asks[0]?.[0];
    if (bid && ask) this.tickFromTop(ex, symbol, bid, ask, b.ts);
  }

  /** Tick from the best bid / ask only (2 Decimals), between full-book conversions. */
  private onTop(ex: ExchangeId, symbol: string, raw: unknown, ts: number) {
    const b = rawLevels(raw);
    const lv = b ? parseLevels([...b.bids.slice(0, 1), ...b.asks.slice(0, 1)]) : [];
    if (lv.length === 2) this.tickFromTop(ex, symbol, lv[0]![0], lv[1]![0], ts);
  }

  private tickFromTop(ex: ExchangeId, symbol: string, bid: Decimal, ask: Decimal, ts: number) {
    if (!bid.lt(ask)) return; // crossed top of book: a desynced stream, not a price (paper stops trigger on ticks)
    const mid = bid.add(ask).div(2);
    const mk = this.lastMark.get(`${ex}|${symbol}`);
    this.pushTick({ exchange: ex, symbol, ts, mark: mid.add(mk?.basis ?? 0), last: mid, index: mk?.index ?? null });
  }

  protected closeStream(ex: ExchangeId, symbol: string): void {
    this.loops.set(`${ex}|${symbol}`, false);
  }

  async fetchPrice(ex: ExchangeId, symbol: string): Promise<Decimal | null> {
    const c = this.clients.get(ex);
    if (!c) return null;
    const t = TickerMsg.safeParse(await (c.fetchTicker as (s: string) => Promise<unknown>).call(c, symbol));
    return t.success && t.data.last != null ? D(t.data.last) : null;
  }

  /** 1m candles; low before high so an SL is assumed to hit first inside a candle (conservative). */
  async tradesBetween(ex: ExchangeId, symbol: string, from: number, to: number): Promise<PricePoint[]> {
    const c = this.clients.get(ex);
    if (!c || to <= from) return [];
    const raw = Ohlcv.parse(await (c.fetchOHLCV as (s: string, tf: string, since: number, limit: number) => Promise<unknown>).call(c, symbol, "1m", from, Math.min(1000, Math.ceil((to - from) / 60_000) + 2)));
    const out: PricePoint[] = [];
    for (const [ts, , high, low] of raw) {
      if (ts > to) break;
      out.push({ ts, price: D(low) }, { ts: ts + 30_000, price: D(high) });
    }
    return out;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) t();
    for (const k of this.loops.keys()) this.loops.set(k, false);
    for (const c of [...this.clients.values(), ...this.timeClients.values()]) await c.close?.().catch(() => undefined);
  }
}
