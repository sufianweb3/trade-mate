import { D, Decimal, ZERO, type ErrorCode, type ExchangeId } from "@oisniper/core";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { MarketHub } from "../market/types";
import { QUIRKS } from "../market/quirks";
import { call } from "../market/quirks/types";
import { baseToContracts, contractsToBase } from "../symbols/contracts";
import type { Clock } from "../util/clock";
import type { LiveAccounts } from "./liveAccounts";
import { iocCap, simulateIoc } from "./simFill";
import type { AdapterEvent, ExecutionAdapter, FillResult, IocRequest, PositionCtx, ReconcileItem, StopRequest, TpRequest } from "./types";

const Order = z.object({
  id: z.string(),
  status: z.string().nullable().optional(),
  filled: z.number().nullable().optional(),
  average: z.number().nullable().optional(),
  price: z.number().nullable().optional(),
  fee: z.object({ cost: z.number().nullable().optional() }).nullable().optional(),
  timestamp: z.number().nullable().optional(),
}).passthrough();
const Position = z.object({ symbol: z.string(), contracts: z.number().nullable().optional(), side: z.string().nullable().optional() }).passthrough();

/** Map exchange errors to internal codes. The only place this happens. */
export function mapExchangeError(e: unknown): ErrorCode {
  const n = String((e as { name?: string })?.name ?? "");
  const m = String((e as Error)?.message ?? "").toLowerCase();
  if (n === "InsufficientFunds" || /insufficient|margin is insufficient|balance/.test(m)) return "INSUFFICIENT_MARGIN";
  if (n === "RateLimitExceeded" || n === "DDoSProtection" || /too many|rate limit/.test(m)) return "RATE_LIMIT";
  if (n === "OnMaintenance" || n === "ExchangeNotAvailable" || /maintenance/.test(m)) return "MAINTENANCE";
  if (/reduce.?only|reduceonly/.test(m)) return "REDUCE_ONLY_REJECTED";
  if (/min(imum)? ?notional|notional must|too small|min order/.test(m)) return "MIN_NOTIONAL";
  if (/price filter|tick size|invalid price|price precision/.test(m)) return "PRICE_FILTER";
  if (/leverage/.test(m)) return "LEVERAGE_UNAVAILABLE";
  if (n === "AuthenticationError" || n === "PermissionDenied") return "AUTH_FAILED";
  return "EXCHANGE_ERROR";
}

interface Tracked { ctx: PositionCtx; stopId: string | null; tpId: string | null; stopTrigger: Decimal | null; tpPrice: Decimal | null; capitalUsed: Decimal }

export interface LiveOptions {
  botId: string; hub: MarketHub; clock: Clock; accounts: LiveAccounts;
  /** Read on every use: a saved settings change (raise or lower) applies at once, without a restart. */
  maxCapital: () => Decimal;
  takerOverridePct: Record<string, number>;
}

/** Real orders through ccxt. Every entry also gets a shadow SimAdapter fill for calibration. */
export class LiveAdapter implements ExecutionAdapter {
  readonly kind = "live" as const;
  private ee = new EventEmitter();
  private tracked = new Map<string, Tracked>();
  private stopPoll: () => void;

  constructor(private o: LiveOptions) {
    this.stopPoll = o.clock.setInterval(() => void this.poll(), 3000); // REST fallback for fills
  }

  accountId(ex: ExchangeId): string {
    return `live:${ex}`;
  }
  canTrade(ex: ExchangeId): boolean {
    return this.o.accounts.canTrade(ex);
  }
  private client(ex: ExchangeId) {
    const c = this.o.accounts.get(ex);
    if (!c) throw Object.assign(new Error(`${ex} not connected`), { code: "AUTH_FAILED" });
    return c;
  }
  private contracts(ex: ExchangeId, symbol: string, base: Decimal): number {
    const m = this.o.hub.market(ex, symbol)!;
    const step = m.qtyStep.div(m.contractSize);
    return baseToContracts(base, m.contractSize, step).toNumber();
  }
  private checkClock(ex: ExchangeId) {
    const h = this.o.hub.health().find((x) => x.exchange === ex);
    // Unknown offset (sync never succeeded) blocks too: signed requests with a bad clock are rejected or mistimed.
    if (h?.clockOffsetMs == null || Math.abs(h.clockOffsetMs) > 500) throw Object.assign(new Error("clock drift"), { code: "CLOCK_DRIFT" });
  }

  /** ex|symbol|leverage already set up on the exchange (valid until the agent restarts). */
  private prepared = new Map<string, Promise<void>>();
  private wsBroken = new Set<ExchangeId>();

  prepare(ex: ExchangeId, symbol: string, leverage: number): Promise<void> {
    const k = `${ex}|${symbol}|${leverage}`;
    let p = this.prepared.get(k);
    if (!p) {
      p = (async () => {
        const c = this.client(ex);
        await call(c, "setMarginMode", "isolated", symbol).catch(() => undefined); // already isolated -> error, fine
        await call(c, "setPositionMode", false, symbol).catch(() => undefined); // one-way
        try {
          await call(c, "setLeverage", leverage, symbol);
        } catch (e) {
          throw Object.assign(new Error((e as Error).message), { code: "LEVERAGE_UNAVAILABLE" }); // never clamp
        }
      })();
      this.prepared.set(k, p);
      p.catch(() => this.prepared.delete(k)); // failed setup is retried next time
    }
    return p;
  }
  async prewarm(ex: ExchangeId, symbol: string, leverage: number): Promise<void> {
    if (this.o.accounts.canTrade(ex)) await this.prepare(ex, symbol, leverage).catch(() => undefined);
  }

  /**
   * Order call: WebSocket API where ccxt supports it (Binance WS API, Bybit WS trade, OKX WS), REST otherwise.
   * Falls back to REST only on transport / not-supported errors; the clientOrderId makes a retry idempotent.
   */
  private async orderCall(ex: ExchangeId, args: unknown[]): Promise<unknown> {
    const c = this.client(ex);
    if (c.has.createOrderWs && !this.wsBroken.has(ex)) {
      try {
        return await call(c, "createOrderWs", ...args);
      } catch (e) {
        const n = String((e as { name?: string }).name ?? "");
        if (!/NotSupported|NetworkError|RequestTimeout|ExchangeNotAvailable|WebSocket/i.test(n + String((e as Error).message))) throw e;
        this.wsBroken.add(ex); // stay on REST for this session
      }
    }
    return call(c, "createOrder", ...args);
  }
  takerPct(ex: ExchangeId, symbol: string): Decimal {
    const ov = this.o.takerOverridePct[ex];
    if (ov != null) return D(ov);
    const s = this.o.accounts.statusOf(ex)?.takerPct;
    return s ? D(s) : (this.o.hub.market(ex, symbol)?.takerPct ?? D("0.05"));
  }
  private used(): Decimal {
    let u = ZERO;
    for (const t of this.tracked.values()) u = u.add(t.capitalUsed);
    return u;
  }
  async available(): Promise<Decimal | null> {
    return Decimal.max(this.o.maxCapital().sub(this.used()), 0);
  }
  async walletBalance(): Promise<Decimal | null> {
    return this.o.maxCapital();
  }

  async placeIoc(req: IocRequest): Promise<FillResult> {
    const sentAt = this.o.clock.now();
    const m = this.o.hub.market(req.exchange, req.symbol);
    const cap = iocCap(req.side, req.refPrice, req.maxSlippagePct, m?.tickSize ?? D("0.0001"));
    const base: FillResult = { status: "rejected", code: null, message: null, clientOrderId: req.clientOrderId, orderId: null, requestedQty: req.qty, filledQty: ZERO, avgPrice: null, fee: ZERO, capPrice: cap, sentAt, ackTs: sentAt, ts: sentAt, latencyMs: 0, simFillPrice: null, realFillPrice: null };
    if (!req.reduceOnly && req.qty.mul(cap).div(req.leverage).gt(await this.available() ?? ZERO)) return { ...base, code: "CAPITAL_CAP", message: "max capital reached" };
    // shadow sim against the live book at send + latency
    const lat = Math.round(this.o.hub.rttMs(req.exchange) / 2) + 50;
    const shadowBook = this.o.hub.book(req.exchange, req.symbol);
    try {
      this.checkClock(req.exchange);
      const q = QUIRKS[req.exchange];
      const raw = await this.orderCall(req.exchange, [req.symbol, "limit", req.side, this.contracts(req.exchange, req.symbol, req.qty), cap.toNumber(), { ...q.iocParams(), reduceOnly: req.reduceOnly, clientOrderId: req.clientOrderId }]);
      const ackTs = this.o.clock.now();
      this.o.hub.recordOrderLatency(req.exchange, ackTs - sentAt);
      const o = Order.parse(raw);
      // IOC is final once acknowledged: use the response when it carries the fill, else one REST read.
      const final = ["closed", "canceled", "cancelled", "expired"].includes(o.status ?? "") && o.filled != null;
      const full = final ? o : Order.parse(await call(this.client(req.exchange), "fetchOrder", o.id, req.symbol).catch(() => raw));
      base.ackTs = ackTs;
      const filled = contractsToBase(full.filled ?? 0, m!.contractSize);
      const avg = full.average != null ? D(full.average) : null;
      const sim = shadowBook ? simulateIoc(this.o.hub.bookAt(req.exchange, req.symbol, sentAt + lat) ?? shadowBook, req.side, req.qty, cap).avgPrice : null;
      const fee = full.fee?.cost != null ? D(full.fee.cost) : avg ? avg.mul(filled).mul(this.takerPct(req.exchange, req.symbol)).div(100) : ZERO;
      return { ...base, status: filled.isZero() ? "rejected" : filled.lt(req.qty) ? "partial" : "filled", code: filled.isZero() ? "ORDER_NOT_FILLED" : null, orderId: o.id, filledQty: filled, avgPrice: avg, fee, ts: full.timestamp ?? this.o.clock.now(), latencyMs: this.o.clock.now() - sentAt, simFillPrice: sim, realFillPrice: avg };
    } catch (e) {
      const code = (e as { code?: ErrorCode }).code ?? mapExchangeError(e);
      return { ...base, code, message: String((e as Error).message).slice(0, 160) };
    }
  }

  registerPosition(ctx: PositionCtx): void {
    this.tracked.set(ctx.tradeId, { ctx, stopId: null, tpId: null, stopTrigger: null, tpPrice: null, capitalUsed: ctx.margin });
  }
  unregisterPosition(tradeId: string): void {
    this.tracked.delete(tradeId);
  }

  async placeStop(r: StopRequest): Promise<string> {
    const q = QUIRKS[r.exchange];
    const t = this.tracked.get(r.tradeId);
    try {
      const raw = await this.orderCall(r.exchange, [r.symbol, "market", "sell", this.contracts(r.exchange, r.symbol, r.qty), undefined, { ...q.stopParams(t?.ctx.triggerPrice ?? "mark"), stopLossPrice: r.triggerPrice.toNumber(), clientOrderId: r.clientOrderId }]);
      const o = Order.parse(raw);
      if (t) {
        t.stopId = o.id;
        t.stopTrigger = r.triggerPrice;
      }
      return o.id;
    } catch (e) {
      throw Object.assign(new Error(String((e as Error).message).slice(0, 160)), { code: mapExchangeError(e) });
    }
  }
  /** New stop first, then cancel the old one: the position is never unprotected. */
  async replaceStop(oldId: string, r: StopRequest): Promise<string> {
    const id = await this.placeStop(r);
    await this.cancel(r.tradeId, oldId).catch(() => undefined);
    return id;
  }
  async placeTakeProfit(r: TpRequest): Promise<string> {
    const raw = await call(this.client(r.exchange), "createOrder", r.symbol, "limit", "sell", this.contracts(r.exchange, r.symbol, r.qty), r.price.toNumber(), { reduceOnly: true, clientOrderId: r.clientOrderId });
    const o = Order.parse(raw);
    const t = this.tracked.get(r.tradeId);
    if (t) {
      t.tpId = o.id;
      t.tpPrice = r.price;
    }
    return o.id;
  }
  async cancel(tradeId: string, orderId: string): Promise<void> {
    const t = this.tracked.get(tradeId);
    if (!t) return;
    await call(this.client(t.ctx.exchange), "cancelOrder", orderId, t.ctx.symbol, { stop: orderId === t.stopId, trigger: orderId === t.stopId });
    if (t.stopId === orderId) t.stopId = null;
    if (t.tpId === orderId) t.tpId = null;
  }
  onEvent(fn: (e: AdapterEvent) => void): () => void {
    this.ee.on("e", fn);
    return () => this.ee.off("e", fn);
  }

  /** REST poll fallback (3s): resting stop / TP fills and positions closed elsewhere. */
  private async poll(): Promise<void> {
    for (const t of this.tracked.values()) {
      const c = this.o.accounts.get(t.ctx.exchange);
      if (!c) continue;
      for (const kind of ["tp", "stop"] as const) {
        const id = kind === "tp" ? t.tpId : t.stopId;
        if (!id) continue;
        const o = Order.safeParse(await call(c, "fetchOrder", id, t.ctx.symbol, kind === "stop" ? { stop: true, trigger: true } : {}).catch(() => null));
        if (!o.success || !["closed", "filled"].includes(o.data.status ?? "")) continue;
        const m = this.o.hub.market(t.ctx.exchange, t.ctx.symbol)!;
        const filled = contractsToBase(o.data.filled ?? 0, m.contractSize);
        const avg = D(o.data.average ?? o.data.price ?? 0);
        const fill: FillResult = { status: "filled", code: null, message: null, clientOrderId: id, orderId: id, requestedQty: filled, filledQty: filled, avgPrice: avg, fee: o.data.fee?.cost != null ? D(o.data.fee.cost) : avg.mul(filled).mul(this.takerPct(t.ctx.exchange, t.ctx.symbol)).div(100), capPrice: avg, sentAt: o.data.timestamp ?? this.o.clock.now(), ackTs: o.data.timestamp ?? this.o.clock.now(), ts: this.o.clock.now(), latencyMs: 0, simFillPrice: null, realFillPrice: avg };
        if (kind === "tp") {
          t.tpId = null;
          this.ee.emit("e", { type: "tp_filled", tradeId: t.ctx.tradeId, fill, ts: fill.ts });
        } else {
          t.stopId = null;
          this.ee.emit("e", { type: "stop_filled", tradeId: t.ctx.tradeId, fill, triggerPrice: t.stopTrigger ?? avg, ts: fill.ts });
        }
      }
    }
  }

  async reconcile(open: PositionCtx[]): Promise<ReconcileItem[]> {
    const out: ReconcileItem[] = [];
    const byEx = new Set(open.map((o) => o.exchange));
    for (const ex of byEx) {
      const c = this.o.accounts.get(ex);
      if (!c) continue;
      const positions = z.array(Position).parse(await call(c, "fetchPositions"));
      const orders = z.array(Order.extend({ symbol: z.string(), reduceOnly: z.boolean().nullable().optional(), triggerPrice: z.number().nullable().optional() })).parse(await call(c, "fetchOpenOrders", undefined, undefined, undefined, { stop: true, trigger: true }).catch(() => []));
      for (const p of positions.filter((x) => (x.contracts ?? 0) > 0)) {
        const mine = open.find((o) => o.exchange === ex && o.symbol === p.symbol);
        if (!mine) {
          out.push({ exchange: ex, symbol: p.symbol, qty: String(p.contracts), tradeId: null, status: "external" }); // never touched
          continue;
        }
        const stop = orders.find((o) => o.symbol === p.symbol && o.triggerPrice != null);
        const t = this.tracked.get(mine.tradeId);
        if (t && stop) {
          t.stopId = stop.id;
          t.stopTrigger = D(stop.triggerPrice!);
        }
        out.push({ exchange: ex, symbol: p.symbol, qty: String(p.contracts), tradeId: mine.tradeId, status: stop ? "matched" : "missing" });
      }
      for (const o of open.filter((x) => x.exchange === ex && !positions.some((p) => p.symbol === x.symbol && (p.contracts ?? 0) > 0))) {
        this.ee.emit("e", { type: "position_gone", tradeId: o.tradeId, ts: this.o.clock.now() });
        out.push({ exchange: ex, symbol: o.symbol, qty: "0", tradeId: o.tradeId, status: "matched" });
      }
    }
    return out;
  }

  /** Live: the exchange stop handled downtime; fills are picked up by the poller. */
  async catchUp(): Promise<void> {}

  async close(): Promise<void> {
    this.stopPoll();
  }
}
