import { D, Decimal, feeFor, fundingCostLong, ZERO, type ExchangeId } from "@oisniper/core";
import { EventEmitter } from "node:events";
import type { MarketHub, Tick } from "../market/types";
import type { Clock } from "../util/clock";
import { shortId } from "../util/ids";
import { iocCap, simulateIoc, simulateMarket } from "./simFill";
import type { AdapterEvent, ExecutionAdapter, FillResult, IocRequest, PositionCtx, StopRequest, TpRequest } from "./types";

/** Paper account: isolated margin. unlimited = Bot 2 grid (equity tracked from 0). */
export interface SimAccount {
  cash: Decimal;
  unlimited: boolean;
}

interface SimPos {
  ctx: PositionCtx;
  qtyOpen: Decimal;
  marginOpen: Decimal;
  stop: { orderId: string; trigger: Decimal; qty: Decimal; clientOrderId: string } | null;
  tp: { orderId: string; price: Decimal; qty: Decimal; clientOrderId: string } | null;
  busy: boolean;
  closed: boolean;
  lastFundingTs: number;
}

export interface SimOptions {
  botId: string;
  hub: MarketHub;
  clock: Clock;
  account: SimAccount;
  latencyOverrideMs: number | null;
  takerOverridePct: Record<string, number>;
  onAccountChange: (a: SimAccount) => void;
}

/** Exchange simulator. Same fills, fees and failures a real account would produce (PRD 9.2). */
export class SimAdapter implements ExecutionAdapter {
  readonly kind = "sim" as const;
  private ee = new EventEmitter();
  private pos = new Map<string, SimPos>();
  private unsubTick: () => void;
  private unsubGap: () => void;

  constructor(private o: SimOptions) {
    this.unsubTick = o.hub.onTick((t) => void this.onTick(t));
    this.unsubGap = o.hub.onGap((ex, sym, from, to) => void this.onGap(ex, sym, from, to));
  }

  accountId(): string {
    return `sim:${this.o.botId}`;
  }
  canTrade(): boolean {
    return true;
  }
  async prepare(ex: ExchangeId, symbol: string, leverage: number): Promise<void> {
    const m = this.o.hub.market(ex, symbol);
    if (!m) throw Object.assign(new Error("unknown market"), { code: "SYMBOL_UNMAPPED" });
    if (leverage > m.maxLeverage) throw Object.assign(new Error("leverage"), { code: "LEVERAGE_UNAVAILABLE" });
  }
  async prewarm(): Promise<void> {}
  takerPct(ex: ExchangeId, symbol: string): Decimal {
    const o = this.o.takerOverridePct[ex];
    if (o != null) return D(o);
    return this.o.hub.market(ex, symbol)?.takerPct ?? D("0.05");
  }
  async available(): Promise<Decimal | null> {
    return this.o.account.unlimited ? null : this.o.account.cash;
  }
  async walletBalance(): Promise<Decimal | null> {
    let locked = ZERO;
    for (const p of this.pos.values()) if (!p.closed) locked = locked.add(p.marginOpen);
    return this.o.account.cash.add(locked);
  }

  private latency(ex: ExchangeId): number {
    if (this.o.latencyOverrideMs != null) return this.o.latencyOverrideMs;
    // Same delay real orders see: measured live send -> ack when available, else one-way RTT + 50ms processing.
    return this.o.hub.orderLatencyMs(ex) ?? Math.round(this.o.hub.rttMs(ex) / 2) + 50;
  }

  private changeCash(delta: Decimal) {
    this.o.account.cash = this.o.account.cash.add(delta);
    this.o.onAccountChange(this.o.account);
  }

  private reject(req: IocRequest, code: FillResult["code"], message: string, sentAt: number, cap: Decimal): FillResult {
    return {
      status: "rejected", code, message, clientOrderId: req.clientOrderId, orderId: null, requestedQty: req.qty, filledQty: ZERO,
      avgPrice: null, fee: ZERO, capPrice: cap, sentAt, ackTs: sentAt, ts: this.o.clock.now(), latencyMs: 0, simFillPrice: null, realFillPrice: null,
    };
  }

  async placeIoc(req: IocRequest): Promise<FillResult> {
    const sentAt = this.o.clock.now();
    const m = this.o.hub.market(req.exchange, req.symbol);
    const tick = m?.tickSize ?? D("0.0001");
    const cap = iocCap(req.side, req.refPrice, req.maxSlippagePct, tick);
    if (!m) return this.reject(req, "SYMBOL_UNMAPPED", "unknown market", sentAt, cap);
    if (!req.qty.div(m.qtyStep).isInteger()) return this.reject(req, "LOT_SIZE", "qty not a lot multiple", sentAt, cap);
    const p = this.pos.get(req.tradeId);
    if (req.reduceOnly) {
      if (!p || p.closed || req.qty.gt(p.qtyOpen)) return this.reject(req, "REDUCE_ONLY_REJECTED", "reduce-only exceeds position", sentAt, cap);
    } else {
      if (req.leverage > m.maxLeverage) return this.reject(req, "LEVERAGE_UNAVAILABLE", "leverage above symbol max", sentAt, cap);
      if (req.qty.mul(req.refPrice).lt(m.minNotional)) return this.reject(req, "MIN_NOTIONAL", "below min notional", sentAt, cap);
      if (!this.o.account.unlimited) {
        const need = req.qty.mul(cap).div(req.leverage).add(feeFor(req.qty.mul(cap), this.takerPct(req.exchange, req.symbol)));
        if (need.gt(this.o.account.cash)) return this.reject(req, "INSUFFICIENT_MARGIN", "insufficient balance", sentAt, cap);
      }
    }
    const lat = this.latency(req.exchange);
    await this.o.clock.sleep(lat);
    const book = this.o.hub.bookAt(req.exchange, req.symbol, sentAt + lat) ?? this.o.hub.book(req.exchange, req.symbol);
    if (!book) return this.reject(req, "ORDER_NOT_FILLED", "no book", sentAt, cap);
    const w = simulateIoc(book, req.side, req.qty, cap);
    const fee = feeFor(w.notional, this.takerPct(req.exchange, req.symbol));
    const fill: FillResult = {
      status: w.filledQty.isZero() ? "rejected" : w.partial ? "partial" : "filled",
      code: w.filledQty.isZero() ? "ORDER_NOT_FILLED" : null,
      message: w.filledQty.isZero() ? "IOC cap not reached" : null,
      clientOrderId: req.clientOrderId,
      orderId: `sim-${shortId()}`,
      requestedQty: req.qty,
      filledQty: w.filledQty,
      avgPrice: w.avgPrice,
      fee,
      capPrice: cap,
      sentAt,
      ackTs: sentAt + lat,
      ts: this.o.clock.now(),
      latencyMs: lat,
      simFillPrice: w.avgPrice,
      realFillPrice: null,
    };
    if (fill.filledQty.gt(0)) {
      if (req.reduceOnly && p) this.applyReduce(p, fill.filledQty, fill.avgPrice!, fee);
      else this.changeCash(w.notional.div(req.leverage).add(fee).neg());
    }
    return fill;
  }

  /** Release margin share, realize PnL, pay fee. */
  private applyReduce(p: SimPos, qty: Decimal, price: Decimal, fee: Decimal) {
    const share = qty.div(p.qtyOpen);
    const marginRel = p.marginOpen.mul(share);
    const pnl = price.sub(p.ctx.entryPrice).mul(qty);
    p.qtyOpen = p.qtyOpen.sub(qty);
    p.marginOpen = p.marginOpen.sub(marginRel);
    this.changeCash(marginRel.add(pnl).sub(fee));
    if (p.qtyOpen.lte(0)) this.finish(p);
  }

  private finish(p: SimPos) {
    p.closed = true;
    p.stop = null;
    p.tp = null;
  }

  registerPosition(ctx: PositionCtx): void {
    this.o.hub.subscribe(ctx.exchange, ctx.symbol, `pos:${ctx.tradeId}`).catch(() => undefined);
    this.pos.set(ctx.tradeId, {
      ctx, qtyOpen: ctx.qty, marginOpen: ctx.margin, stop: null, tp: null, busy: false, closed: false, lastFundingTs: ctx.lastFundingTs,
    });
  }
  unregisterPosition(tradeId: string): void {
    const p = this.pos.get(tradeId);
    if (p) this.o.hub.unsubscribe(p.ctx.exchange, p.ctx.symbol, `pos:${tradeId}`);
    this.pos.delete(tradeId);
  }

  async placeStop(req: StopRequest): Promise<string> {
    const p = this.pos.get(req.tradeId);
    if (!p || p.closed) throw Object.assign(new Error("no position"), { code: "REDUCE_ONLY_REJECTED" });
    const id = `sim-sl-${shortId()}`;
    p.stop = { orderId: id, trigger: req.triggerPrice, qty: req.qty, clientOrderId: req.clientOrderId };
    return id;
  }
  async replaceStop(_old: string, req: StopRequest): Promise<string> {
    return this.placeStop(req);
  }
  async placeTakeProfit(req: TpRequest): Promise<string> {
    const p = this.pos.get(req.tradeId);
    if (!p || p.closed) throw Object.assign(new Error("no position"), { code: "REDUCE_ONLY_REJECTED" });
    const id = `sim-tp-${shortId()}`;
    p.tp = { orderId: id, price: req.price, qty: req.qty, clientOrderId: req.clientOrderId };
    return id;
  }
  async cancel(tradeId: string, orderId: string): Promise<void> {
    const p = this.pos.get(tradeId);
    if (!p) return;
    if (p.stop?.orderId === orderId) p.stop = null;
    if (p.tp?.orderId === orderId) p.tp = null;
  }
  onEvent(fn: (e: AdapterEvent) => void): () => void {
    this.ee.on("e", fn);
    return () => this.ee.off("e", fn);
  }
  private emit(e: AdapterEvent) {
    this.ee.emit("e", e);
  }

  private async onTick(t: Tick): Promise<void> {
    for (const p of this.pos.values()) {
      if (p.closed || p.busy || p.ctx.exchange !== t.exchange || p.ctx.symbol !== t.symbol) continue;
      this.chargeFunding(p, t);
      await this.evaluate(p, t.mark, t.ts, p.ctx.triggerPrice === "mark" ? t.mark : t.last);
    }
  }

  private chargeFunding(p: SimPos, t: Tick) {
    const f = this.o.hub.funding(t.exchange, t.symbol);
    if (!f || !f.intervalMs) return;
    // Funding timestamps that passed since the last charge while the position was open.
    let ts = f.nextTime - f.intervalMs;
    while (ts > p.lastFundingTs && ts <= t.ts) {
      const amount = fundingCostLong(p.qtyOpen.mul(t.mark), f.rate);
      p.lastFundingTs = ts;
      this.changeCash(amount.neg());
      this.emit({ type: "funding", tradeId: p.ctx.tradeId, amount, rate: f.rate, ts });
      ts -= f.intervalMs; // at most one charge per interval in practice
    }
  }

  /** Liquidation (mark) first, then stop, then TP. Fills walk the real book after latency. */
  private async evaluate(p: SimPos, mark: Decimal, ts: number, trig: Decimal): Promise<void> {
    if (mark.lte(p.ctx.liqPrice)) {
      const qty = p.qtyOpen;
      p.marginOpen = ZERO; // isolated margin lost (includes liquidation clearance fee)
      p.qtyOpen = ZERO;
      this.finish(p);
      this.o.onAccountChange(this.o.account);
      this.emit({ type: "liquidated", tradeId: p.ctx.tradeId, price: p.ctx.liqPrice, qty, ts });
      return;
    }
    if (p.stop && trig.lte(p.stop.trigger)) {
      const stop = p.stop;
      p.busy = true;
      try {
        const lat = this.latency(p.ctx.exchange);
        await this.o.clock.sleep(lat);
        const book = this.o.hub.book(p.ctx.exchange, p.ctx.symbol);
        if (!book || p.closed) return;
        const qty = stop.qty.gt(p.qtyOpen) ? p.qtyOpen : stop.qty;
        const w = simulateMarket(book, "sell", qty);
        if (w.filledQty.isZero()) return;
        const fee = feeFor(w.notional, this.takerPct(p.ctx.exchange, p.ctx.symbol));
        const fill = this.mkFill(stop.clientOrderId, stop.orderId, qty, w.filledQty, w.avgPrice!, fee, ts, lat);
        this.applyReduce(p, w.filledQty, w.avgPrice!, fee);
        this.emit({ type: "stop_filled", tradeId: p.ctx.tradeId, fill, triggerPrice: stop.trigger, ts: fill.ts });
      } finally {
        p.busy = false;
      }
      return;
    }
    if (p.tp) {
      const book = this.o.hub.book(p.ctx.exchange, p.ctx.symbol);
      const bid = book?.bids[0]?.[0];
      if (bid && bid.gte(p.tp.price)) {
        const tp = p.tp;
        p.tp = null;
        const qty = tp.qty.gt(p.qtyOpen) ? p.qtyOpen : tp.qty;
        // Resting limit fills at its own price. Conservative: taker fee (PRD 9.2 "taker fee on every fill").
        const fee = feeFor(qty.mul(tp.price), this.takerPct(p.ctx.exchange, p.ctx.symbol));
        const fill = this.mkFill(tp.clientOrderId, tp.orderId, qty, qty, tp.price, fee, ts, 0);
        this.applyReduce(p, qty, tp.price, fee);
        this.emit({ type: "tp_filled", tradeId: p.ctx.tradeId, fill, ts });
      }
    }
  }

  private mkFill(cid: string, oid: string, req: Decimal, filled: Decimal, price: Decimal, fee: Decimal, sentAt: number, lat: number): FillResult {
    return {
      status: filled.lt(req) ? "partial" : "filled", code: null, message: null, clientOrderId: cid, orderId: oid,
      requestedQty: req, filledQty: filled, avgPrice: price, fee, capPrice: price, sentAt, ackTs: this.o.clock.now(), ts: this.o.clock.now(),
      latencyMs: lat, simFillPrice: price, realFillPrice: null,
    };
  }

  /** WS gap: replay trades in the window to see if SL / TP / liq was crossed. */
  private async onGap(ex: ExchangeId, symbol: string, from: number, to: number): Promise<void> {
    const affected = [...this.pos.values()].filter((p) => !p.closed && p.ctx.exchange === ex && p.ctx.symbol === symbol);
    if (!affected.length) return;
    const pts = await this.o.hub.tradesBetween(ex, symbol, from, to);
    for (const p of affected) {
      this.emit({ type: "data_gap", tradeId: p.ctx.tradeId, from, to });
      for (const pt of pts) {
        if (p.closed) break;
        await this.evaluate(p, pt.price, pt.ts, pt.price);
      }
    }
  }

  async reconcile(open: PositionCtx[]) {
    // Paper positions live in the agent. Simulated resting orders are not persisted, so they must be re-placed.
    return open.map((c) => ({ exchange: c.exchange, symbol: c.symbol, qty: c.qty.toString(), tradeId: c.tradeId, status: "missing" as const }));
  }

  /** Replay trades from exchange REST for the downtime window (PRD 16: agent crash, paper). */
  async catchUp(open: PositionCtx[], since: Record<string, number>): Promise<void> {
    const now = this.o.clock.now();
    for (const ctx of open) {
      const p = this.pos.get(ctx.tradeId);
      if (!p) continue;
      const pts = await this.o.hub.tradesBetween(ctx.exchange, ctx.symbol, since[ctx.tradeId] ?? ctx.openedAt, now).catch(() => []);
      for (const pt of pts) {
        if (p.closed) break;
        await this.evaluate(p, pt.price, pt.ts, pt.price);
      }
    }
  }

  async close(): Promise<void> {
    this.unsubTick();
    this.unsubGap();
  }
}
