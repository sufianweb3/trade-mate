import { D, Decimal, type Book, type ExchangeId } from "@oisniper/core";
import { EventEmitter } from "node:events";
import type { Clock } from "../util/clock";
import type { ExchangeHealth, FundingInfo, MarketHub, MarketInfo, PricePoint, Tick } from "./types";

const RING_MS = 10_000;
const RANGE_MS = 60_000;
const GAP_MS = 5_000;

const k = (ex: ExchangeId, s: string) => `${ex}|${s}`;

/** Shared state for market hubs: subscriptions, book ring buffers, ticks, 1m range, gap detection. */
export abstract class BaseHub implements MarketHub {
  protected ee = new EventEmitter();
  protected mk = new Map<ExchangeId, Map<string, MarketInfo>>();
  private rings = new Map<string, Book[]>();
  private ticks = new Map<string, Tick>();
  private hist = new Map<string, { sec: number; lo: Decimal; hi: Decimal; n: number }[]>();
  private fund = new Map<string, FundingInfo>();
  private vol = new Map<string, Decimal>();
  private subs = new Map<string, Set<string>>();
  private lastMsg = new Map<string, number>();
  private gapStart = new Map<string, number>();
  protected healthBy = new Map<ExchangeId, ExchangeHealth>();
  protected rtt = new Map<ExchangeId, number>();

  constructor(readonly exchanges: ExchangeId[], protected clock: Clock) {
    this.ee.setMaxListeners(200);
    for (const ex of exchanges)
      this.healthBy.set(ex, { exchange: ex, status: "down", wsConnected: false, rttMs: null, clockOffsetMs: null, lastMessageTs: null, subscriptions: 0, error: null });
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  protected abstract openStream(ex: ExchangeId, symbol: string): Promise<void>;
  protected abstract closeStream(ex: ExchangeId, symbol: string): void;
  abstract fetchPrice(ex: ExchangeId, symbol: string): Promise<Decimal | null>;
  abstract tradesBetween(ex: ExchangeId, symbol: string, from: number, to: number): Promise<PricePoint[]>;

  /** Synthetic / static hubs already carry final limits. CcxtHub overrides this. */
  async resolveLimits(_ex: ExchangeId, _symbol: string): Promise<void> {}

  protected updateMarket(m: MarketInfo) {
    this.mk.get(m.exchange)?.set(m.symbol, m);
  }

  markets(ex: ExchangeId): MarketInfo[] {
    return [...(this.mk.get(ex)?.values() ?? [])];
  }
  market(ex: ExchangeId, symbol: string): MarketInfo | null {
    return this.mk.get(ex)?.get(symbol) ?? null;
  }
  protected setMarkets(ex: ExchangeId, list: MarketInfo[]) {
    this.mk.set(ex, new Map(list.map((m) => [m.symbol, m])));
  }

  async subscribe(ex: ExchangeId, symbol: string, reason: string): Promise<void> {
    const key = k(ex, symbol);
    let s = this.subs.get(key);
    const first = !s || s.size === 0;
    if (!s) this.subs.set(key, (s = new Set()));
    s.add(reason);
    this.updateSubCount(ex);
    if (first) await this.openStream(ex, symbol);
  }
  unsubscribe(ex: ExchangeId, symbol: string, reason: string): void {
    const key = k(ex, symbol);
    const s = this.subs.get(key);
    if (!s) return;
    s.delete(reason);
    if (s.size === 0) {
      this.subs.delete(key);
      this.closeStream(ex, symbol);
    }
    this.updateSubCount(ex);
  }
  protected isSubscribed(ex: ExchangeId, symbol: string): boolean {
    return (this.subs.get(k(ex, symbol))?.size ?? 0) > 0;
  }
  protected subscribed(): { ex: ExchangeId; symbol: string }[] {
    return [...this.subs.keys()].map((x) => {
      const [ex, symbol] = x.split("|") as [ExchangeId, string];
      return { ex, symbol };
    });
  }
  private updateSubCount(ex: ExchangeId) {
    const h = this.healthBy.get(ex);
    if (h) h.subscriptions = [...this.subs.keys()].filter((x) => x.startsWith(`${ex}|`)).length;
  }

  /** Feed a new book snapshot. Also drives gap detection. */
  protected pushBook(ex: ExchangeId, symbol: string, b: Book) {
    const key = k(ex, symbol);
    const ring = this.rings.get(key) ?? [];
    ring.push(b);
    while (ring.length && ring[0]!.ts < b.ts - RING_MS) ring.shift();
    this.rings.set(key, ring);
    this.touch(ex, symbol, b.ts);
  }

  protected pushTick(t: Tick) {
    const key = k(t.exchange, t.symbol);
    this.ticks.set(key, t);
    // 1s high/low buckets (<= 61 per symbol): constant cost per tick, exact 1m range.
    const h = this.hist.get(key) ?? [];
    const sec = Math.floor(t.ts / 1000);
    const last = h[h.length - 1];
    if (last && last.sec === sec) {
      if (t.last.lt(last.lo)) last.lo = t.last;
      if (t.last.gt(last.hi)) last.hi = t.last;
      last.n++;
    } else h.push({ sec, lo: t.last, hi: t.last, n: 1 });
    let drop = 0;
    while (drop < h.length && h[drop]!.sec * 1000 + 999 < t.ts - RANGE_MS) drop++;
    if (drop) h.splice(0, drop);
    this.hist.set(key, h);
    this.touch(t.exchange, t.symbol, t.ts);
    this.ee.emit("tick", t);
  }

  private touch(ex: ExchangeId, symbol: string, ts: number) {
    const key = k(ex, symbol);
    const prev = this.lastMsg.get(key);
    const gs = this.gapStart.get(key);
    if (gs != null) {
      this.gapStart.delete(key);
      this.ee.emit("gap", ex, symbol, gs, ts);
    } else if (this.silenceIsGap && prev != null && ts - prev > GAP_MS) {
      this.ee.emit("gap", ex, symbol, prev, ts);
    }
    this.lastMsg.set(key, ts);
    const h = this.healthBy.get(ex);
    if (h) h.lastMessageTs = ts;
  }

  /**
   * true: silence > 5s counts as a gap (synthetic feeds). Real exchange books can be quiet for minutes on thin coins,
   * so CcxtHub sets false and reports gaps only when the WebSocket stream actually failed (markStreamDown).
   */
  protected silenceIsGap = true;
  protected markStreamDown(ex: ExchangeId, symbol: string) {
    const key = k(ex, symbol);
    if (!this.gapStart.has(key)) this.gapStart.set(key, this.lastMsg.get(key) ?? this.clock.now());
  }

  /** Called by a watchdog: subscribed symbol silent > 5s -> DATA_GAP until the next message. */
  protected checkGaps() {
    const now = this.clock.now();
    for (const { ex, symbol } of this.subscribed()) {
      const key = k(ex, symbol);
      const last = this.lastMsg.get(key);
      if (last != null && now - last > GAP_MS && !this.gapStart.has(key)) this.gapStart.set(key, last);
    }
  }

  protected setFunding(ex: ExchangeId, symbol: string, f: FundingInfo) {
    this.fund.set(k(ex, symbol), f);
  }
  protected setVolume(ex: ExchangeId, symbol: string, v: Decimal) {
    this.vol.set(k(ex, symbol), v);
  }

  book(ex: ExchangeId, symbol: string): Book | null {
    const r = this.rings.get(k(ex, symbol));
    return r?.[r.length - 1] ?? null;
  }
  bookAt(ex: ExchangeId, symbol: string, ts: number): Book | null {
    const r = this.rings.get(k(ex, symbol));
    if (!r?.length) return null;
    return r.find((b) => b.ts >= ts) ?? r[r.length - 1]!;
  }
  lastTick(ex: ExchangeId, symbol: string): Tick | null {
    return this.ticks.get(k(ex, symbol)) ?? null;
  }
  funding(ex: ExchangeId, symbol: string): FundingInfo | null {
    return this.fund.get(k(ex, symbol)) ?? null;
  }
  volume24h(ex: ExchangeId, symbol: string): Decimal | null {
    return this.vol.get(k(ex, symbol)) ?? null;
  }
  range1mPct(ex: ExchangeId, symbol: string): Decimal | null {
    const h = this.hist.get(k(ex, symbol));
    if (!h || h.reduce((a, b) => a + b.n, 0) < 2) return null;
    let lo = h[0]!.lo;
    let hi = h[0]!.hi;
    for (const b of h) {
      if (b.lo.lt(lo)) lo = b.lo;
      if (b.hi.gt(hi)) hi = b.hi;
    }
    return hi.sub(lo).div(hi.add(lo).div(2)).mul(100);
  }
  private orderLat = new Map<ExchangeId, number>();
  recordOrderLatency(ex: ExchangeId, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const prev = this.orderLat.get(ex);
    this.orderLat.set(ex, prev == null ? ms : Math.round(prev * 0.8 + ms * 0.2));
  }
  orderLatencyMs(ex: ExchangeId): number | null {
    return this.orderLat.get(ex) ?? null;
  }
  rttMs(ex: ExchangeId): number {
    return this.rtt.get(ex) ?? 200;
  }
  protected recordRtt(ex: ExchangeId, ms: number) {
    const prev = this.rtt.get(ex);
    const v = prev == null ? ms : Math.round(prev * 0.8 + ms * 0.2); // EWMA
    this.rtt.set(ex, v);
    const h = this.healthBy.get(ex);
    if (h) h.rttMs = v;
  }
  health(): ExchangeHealth[] {
    return [...this.healthBy.values()].map((h) => ({ ...h }));
  }
  onTick(fn: (t: Tick) => void): () => void {
    this.ee.on("tick", fn);
    return () => this.ee.off("tick", fn);
  }
  onGap(fn: (ex: ExchangeId, symbol: string, from: number, to: number) => void): () => void {
    this.ee.on("gap", fn);
    return () => this.ee.off("gap", fn);
  }
}

export const dec = (v: unknown): Decimal | null =>
  typeof v === "number" && Number.isFinite(v) ? D(v) : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? D(v) : null;
