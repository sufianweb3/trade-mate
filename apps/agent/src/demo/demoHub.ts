import { buildTiers, D, Decimal, type Book, type ExchangeId, type Level } from "@oisniper/core";
import { BaseHub } from "../market/baseHub";
import type { MarketInfo, PricePoint } from "../market/types";
import type { Clock } from "../util/clock";

/**
 * Synthetic exchange market for demos and scenario tests. It is a market-data source (like CcxtHub),
 * not a mode: the engine and SimAdapter run unchanged on top of it.
 */
export interface DemoExchange {
  id: ExchangeId;
  takerPct: string;
  rttMs: number;
  /** Basis vs reference price, percent. */
  offsetPct: number;
  /** Book depth relative to the symbol's base liquidity. */
  depthMult: number;
}

export interface DemoSymbol {
  /** CoinGlass base, e.g. PEPE */
  base: string;
  price: number;
  /** Exchanges listing it; value = multiplier prefix used there ("" or "1000"). */
  listings: Partial<Record<ExchangeId, "" | "1000">>;
  /** USDT per book level on each side, and spread in percent. */
  levelUsd: number;
  spreadPct: number;
  levels?: number;
  levelStepPct?: number;
  maxLeverage: number;
  volume24h: number;
  fundingRate: number;
  fundingIntervalH: 1 | 4 | 8;
  qtyStep: string;
  tick: string;
}

interface PathPt {
  t: number;
  p: number;
}

const TIERS = buildTiers([
  { maxNotional: 50_000, mmrPct: "0.4", maxLeverage: 125 },
  { maxNotional: 600_000, mmrPct: "0.5", maxLeverage: 100 },
  { maxNotional: 3_000_000, mmrPct: "1", maxLeverage: 50 },
  { maxNotional: null, mmrPct: "2.5", maxLeverage: 20 },
]);

export class DemoHub extends BaseHub {
  private syms = new Map<string, DemoSymbol>();
  private paths = new Map<string, PathPt[]>();
  private paused = new Map<string, number>();
  private down = new Set<ExchangeId>();
  private stopTimer: (() => void) | null = null;
  private seed = 7;

  constructor(private ex: DemoExchange[], symbols: DemoSymbol[], clock: Clock, private tickMs = 500) {
    super(ex.map((e) => e.id), clock);
    for (const s of symbols) this.syms.set(s.base, s);
  }

  async start(): Promise<void> {
    for (const e of this.ex) {
      const list: MarketInfo[] = [];
      for (const s of this.syms.values()) {
        const pre = s.listings[e.id];
        if (pre == null) continue;
        const mult = pre === "1000" ? 1000 : 1;
        list.push({
          exchange: e.id, symbol: `${pre}${s.base}/USDT:USDT`, base: `${pre}${s.base}`, active: true, contractSize: D(1),
          qtyStep: mult > 1 ? D(1) : D(s.qtyStep), minQty: mult > 1 ? D(1) : D(s.qtyStep),
          minNotional: D(5), tickSize: D(s.tick).mul(mult), maxLeverage: s.maxLeverage, tiers: TIERS,
          limitsSource: "market", leverageVerified: true,
          takerPct: D(e.takerPct), makerPct: D("0.02"), listedAt: Date.UTC(2023, 0, 1),
        });
      }
      this.setMarkets(e.id, list);
      this.recordRtt(e.id, e.rttMs);
      const h = this.healthBy.get(e.id)!;
      h.status = "ok";
      h.wsConnected = true;
      h.clockOffsetMs = 3;
    }
    this.stopTimer = this.clock.setInterval(() => this.step(), this.tickMs);
    this.step();
  }

  async stop(): Promise<void> {
    this.stopTimer?.();
  }

  /** Coarser ticks for long fast-forwards in scenarios. */
  setTickMs(ms: number): void {
    this.tickMs = ms;
    this.stopTimer?.();
    this.stopTimer = this.clock.setInterval(() => this.step(), ms);
  }

  // ---- scenario controls ----
  /** Piecewise-linear price path from now: [msFromNow, price]. */
  path(base: string, pts: [number, number][]): void {
    const now = this.clock.now();
    const cur = this.refPrice(base, now);
    this.paths.set(base, [{ t: now, p: cur }, ...pts.map(([dt, p]) => ({ t: now + dt, p }))]);
  }
  /** Instant jump (gap) to price. */
  jump(base: string, price: number): void {
    const now = this.clock.now();
    this.paths.set(base, [{ t: now, p: price }]);
  }
  setLiquidity(base: string, levelUsd: number, spreadPct?: number): void {
    const s = this.syms.get(base)!;
    s.levelUsd = levelUsd;
    if (spreadPct != null) s.spreadPct = spreadPct;
  }
  setFundingRate(base: string, rate: number): void {
    this.syms.get(base)!.fundingRate = rate;
  }
  /** Stop streaming a symbol (WS outage) for ms. */
  pauseStream(base: string, ms: number): void {
    this.paused.set(base, this.clock.now() + ms);
  }
  setExchangeDown(ex: ExchangeId, down: boolean): void {
    if (down) this.down.add(ex);
    else this.down.delete(ex);
    this.healthBy.get(ex)!.status = down ? "maintenance" : "ok";
  }

  refPrice(base: string, t: number): number {
    const s = this.syms.get(base)!;
    const pts = this.paths.get(base);
    if (!pts?.length) return s.price;
    if (t <= pts[0]!.t) return pts[0]!.p;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (t <= b.t) return a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
    }
    return pts[pts.length - 1]!.p;
  }

  private exPrice(e: DemoExchange, s: DemoSymbol, t: number): Decimal {
    const mult = s.listings[e.id] === "1000" ? 1000 : 1;
    return D(this.refPrice(s.base, t)).mul(1 + e.offsetPct / 100).mul(mult);
  }

  private noise(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  private makeBook(e: DemoExchange, s: DemoSymbol, t: number): Book {
    const mid = this.exPrice(e, s, t);
    const tick = D(s.tick).mul(s.listings[e.id] === "1000" ? 1000 : 1);
    const half = mid.mul(s.spreadPct / 200);
    const n = s.levels ?? 40;
    const stepPct = s.levelStepPct ?? 0.02;
    const bids: Level[] = [];
    const asks: Level[] = [];
    const bestBid = mid.sub(half).div(tick).floor().mul(tick);
    const bestAsk = Decimal.max(mid.add(half).div(tick).ceil().mul(tick), bestBid.add(tick));
    for (let i = 0; i < n; i++) {
      const f = D(stepPct).div(100).mul(i);
      const bp = bestBid.mul(D(1).sub(f)).div(tick).floor().mul(tick);
      const ap = bestAsk.mul(D(1).add(f)).div(tick).ceil().mul(tick);
      const usd = s.levelUsd * e.depthMult * (0.7 + 0.6 * this.noise()) * (1 + i * 0.05);
      bids.push([bp, D(usd).div(bp).toDecimalPlaces(4)]);
      asks.push([ap, D(usd).div(ap).toDecimalPlaces(4)]);
    }
    // Desynced stream simulation: bids 1% above the asks.
    if (this.crossed.has(`${e.id}|${s.base}`)) return { ts: t, bids: bids.map(([p, q]) => [p.mul("1.01"), q] as Level), asks };
    return { ts: t, bids, asks };
  }

  private crossed = new Set<string>();
  /** Test tooling: make one venue's book crossed (bid >= ask), as after dropped stream deltas. */
  crossBook(ex: ExchangeId, base: string, on: boolean): void {
    if (on) this.crossed.add(`${ex}|${base}`);
    else this.crossed.delete(`${ex}|${base}`);
  }

  private step(): void {
    const t = this.clock.now();
    for (const { ex: exId, symbol } of this.subscribed()) {
      if (this.down.has(exId)) continue;
      const e = this.ex.find((x) => x.id === exId)!;
      const s = this.symFor(symbol);
      if (!s) continue;
      if ((this.paused.get(s.base) ?? 0) > t) continue;
      this.refreshMeta(e, s, symbol, t);
      const b = this.makeBook(e, s, t);
      this.pushBook(exId, symbol, b);
      const mid = b.bids[0]![0].add(b.asks[0]![0]).div(2);
      this.pushTick({ exchange: exId, symbol, ts: t, mark: mid, last: mid, index: mid });
    }
  }

  private refreshMeta(e: DemoExchange, s: DemoSymbol, symbol: string, t: number) {
    const iv = s.fundingIntervalH * 3_600_000;
    this.setFunding(e.id, symbol, { rate: D(s.fundingRate), nextTime: Math.floor(t / iv) * iv + iv, intervalMs: iv });
    this.setVolume(e.id, symbol, D(s.volume24h));
  }

  private symFor(unified: string): DemoSymbol | null {
    const base = unified.split("/")[0]!.replace(/^1000/, "");
    return this.syms.get(base) ?? null;
  }

  protected async openStream(ex: ExchangeId, symbol: string): Promise<void> {
    const e = this.ex.find((x) => x.id === ex);
    const s = this.symFor(symbol);
    if (!e || !s || this.down.has(ex)) return;
    const t = this.clock.now();
    this.refreshMeta(e, s, symbol, t);
    // Warm up the 1m range with the recent path so the volatility gate has data immediately.
    for (let dt = 60_000; dt > 0; dt -= 5000) {
      const p = this.exPrice(e, s, t - dt);
      this.pushTick({ exchange: ex, symbol, ts: t - dt, mark: p, last: p, index: p });
    }
    const b = this.makeBook(e, s, t);
    this.pushBook(ex, symbol, b);
    const mid = b.bids[0]![0].add(b.asks[0]![0]).div(2);
    this.pushTick({ exchange: ex, symbol, ts: t, mark: mid, last: mid, index: mid });
  }
  protected closeStream(): void {}

  async fetchPrice(ex: ExchangeId, symbol: string): Promise<Decimal | null> {
    const e = this.ex.find((x) => x.id === ex);
    const s = this.symFor(symbol);
    return e && s ? this.exPrice(e, s, this.clock.now()) : null;
  }

  async tradesBetween(ex: ExchangeId, symbol: string, from: number, to: number): Promise<PricePoint[]> {
    const e = this.ex.find((x) => x.id === ex);
    const s = this.symFor(symbol);
    if (!e || !s) return [];
    const out: PricePoint[] = [];
    for (let t = from; t <= to; t += 1000) out.push({ ts: t, price: this.exPrice(e, s, t) });
    return out;
  }
}
