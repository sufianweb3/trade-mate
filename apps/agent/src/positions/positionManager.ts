import {
  ceilToStep, D, Decimal, exitLevels, floorToStep, initTrail, onTick, onTp1Fill, priceAtRoe, roeAtPrice, pricePctMove,
  type ExitLevels, type ExitProfile, type TrailState,
} from "@oisniper/core";
import type { Bus } from "../bus";
import type { AdapterEvent, ExecutionAdapter, FillResult, PositionCtx } from "../execution/types";
import { log } from "../log";
import type { MarketHub, Tick } from "../market/types";
import type { Store } from "../store/store";
import type { ExitReason, TradeRecord } from "../store/types";
import type { Clock } from "../util/clock";
import { shortId } from "../util/ids";
import { finalizeResult, legRecord } from "./tradeRecord";

interface Live {
  t: TradeRecord;
  profile: ExitProfile;
  levels: ExitLevels;
  trail: TrailState;
  entry: Decimal;
  tick: Decimal;
  lastSlUpdate: number;
  slTimer: (() => void) | null;
  slBusy: boolean;
  closing: boolean;
  lastPersist: number;
}

export interface PmDeps {
  botId: string;
  store: Store;
  bus: Bus;
  hub: MarketHub;
  clock: Clock;
  adapter: ExecutionAdapter;
  maxSlippagePct: () => number;
  onClosed: (t: TradeRecord) => void;
}

const SL_THROTTLE_MS = 2000;
const SL_RETRIES = 3;
/** Path stats (MFE/MAE) are flushed at most this often; every state change persists immediately. */
const PERSIST_MS = 30_000;

/** TP1, trailing and SL lifecycle. Mode-agnostic: talks only to ExecutionAdapter. */
export class PositionManager {
  private live = new Map<string, Live>();
  private unsub: (() => void)[] = [];

  constructor(private d: PmDeps) {
    this.unsub.push(d.hub.onTick((t) => this.onTick(t)));
    this.unsub.push(d.adapter.onEvent((e) => void this.onAdapter(e)));
  }

  openCount(): number {
    return this.live.size;
  }
  openTrades(): TradeRecord[] {
    return [...this.live.values()].map((l) => l.t);
  }
  has(tradeId: string): boolean {
    return this.live.has(tradeId);
  }

  private ev(tradeId: string, type: string, data: unknown) {
    this.d.store.records.addEvent(tradeId, this.d.clock.now(), type, data);
  }
  private persist(l: Live) {
    l.lastPersist = this.d.clock.now();
    this.d.store.records.upsertTrade(l.t);
    this.d.bus.emit("trade:updated", { botId: this.d.botId, tradeId: l.t.trade_id });
  }

  ctxOf(t: TradeRecord): PositionCtx {
    return {
      tradeId: t.trade_id, botId: t.bot_id, exchange: t.exchange, symbol: t.exchange_symbol, leverage: t.config.leverage,
      entryPrice: D(t.execution.avg_entry_price), qty: D(t.state.qty_open), margin: D(t.state.margin_open),
      liqPrice: D(t.config.liq_price), triggerPrice: t.config.trigger_price, openedAt: t.timing.entry_fill_time,
      lastFundingTs: t.state.last_funding_ts,
    };
  }

  private makeLive(t: TradeRecord, profile: ExitProfile): Live {
    const levels = exitLevels(profile, t.config.taker_fee_pct);
    const trail: TrailState = {
      ...initTrail(levels),
      slRoe: D(t.state.sl_roe),
      armed: t.state.armed,
      tp1Filled: t.state.tp1_filled,
      peakRoe: D(t.path.peak_roe),
    };
    const tick = this.d.hub.market(t.exchange, t.exchange_symbol)?.tickSize ?? D("0.0001");
    return { t, profile, levels, trail, entry: D(t.execution.avg_entry_price), tick, lastSlUpdate: 0, slTimer: null, slBusy: false, closing: false, lastPersist: 0 };
  }

  slPriceFor(entry: Decimal, roe: Decimal, lev: number, tick: Decimal): Decimal {
    return ceilToStep(priceAtRoe(entry, roe, lev), tick);
  }

  /** Called right after the entry fill. Places the exchange stop first (3s rule), then TP1. */
  async adopt(t: TradeRecord, profile: ExitProfile): Promise<void> {
    const l = this.makeLive(t, profile);
    this.live.set(t.trade_id, l);
    this.index = null;
    this.d.adapter.registerPosition(this.ctxOf(t));
    this.ev(t.trade_id, "ENTRY_FILL", { price: t.execution.avg_entry_price, qty: t.execution.filled_qty, fee: t.execution.entry_fee });
    this.persist(l);
    const m = this.d.hub.market(t.exchange, t.exchange_symbol);
    // Dust: filled notional below exchange minimum -> close immediately.
    if (m && D(t.config.notional).lt(m.minNotional)) {
      await this.closeTrade(t.trade_id, "DUST_CLOSE");
      return;
    }
    const placed = await this.placeInitialStop(l);
    if (!placed) return;
    await this.placeTp1(l, m?.qtyStep ?? D(0), m?.minQty ?? D(0));
    this.persist(l);
  }

  private async placeInitialStop(l: Live): Promise<boolean> {
    const t = l.t;
    const started = this.d.clock.now();
    for (let i = 1; i <= SL_RETRIES; i++) {
      try {
        const id = await this.d.adapter.placeStop({
          tradeId: t.trade_id, exchange: t.exchange, symbol: t.exchange_symbol, qty: D(t.state.qty_open),
          triggerPrice: D(t.state.sl_price), clientOrderId: `${t.trade_id.slice(-10)}-sl-${i}`,
        });
        t.state.stop_order_id = id;
        t.timing.sl_placed_ts ??= this.d.clock.now(); // first placement only (latency: fill -> stop on exchange)
        this.ev(t.trade_id, "SL_PLACED", { price: t.state.sl_price, order_id: id, attempt: i, ms: this.d.clock.now() - started });
        return true;
      } catch (e) {
        this.ev(t.trade_id, "SL_RETRY", { attempt: i, error: (e as Error).message });
        if (i < SL_RETRIES) await this.d.clock.sleep(500);
      }
    }
    this.d.bus.emit("alert", {
      level: "error", kind: "SL_PLACEMENT_FAILED", message: `Stop placement failed for ${t.symbol}; market-closing`,
      botId: t.bot_id, tradeId: t.trade_id, ts: this.d.clock.now(),
    });
    this.d.store.records.addError(this.d.clock.now(), "positions", "SL_PLACEMENT_FAILED", `${t.trade_id} ${t.symbol}`);
    await this.closeTrade(t.trade_id, "SL_PLACEMENT_FAILED");
    return false;
  }

  private async placeTp1(l: Live, step: Decimal, minQty: Decimal): Promise<void> {
    const t = l.t;
    const closePct = l.levels.tp1ClosePct;
    if (closePct.lte(0)) return;
    const open = D(t.state.qty_open);
    const qty = closePct.gte(100) ? open : floorToStep(open.mul(closePct).div(100), step);
    if (qty.lt(minQty) || qty.lte(0)) {
      t.state.tp1_skipped = true; // TP1 below min lot: keep full size, trailing still activates by price
      this.ev(t.trade_id, "TP1_SKIPPED", { qty: qty.toString(), min_qty: minQty.toString() });
      return;
    }
    try {
      const id = await this.d.adapter.placeTakeProfit({
        tradeId: t.trade_id, exchange: t.exchange, symbol: t.exchange_symbol, qty, price: D(t.config.tp1_price),
        clientOrderId: `${t.trade_id.slice(-10)}-tp1`,
      });
      t.state.tp1_order_id = id;
      this.ev(t.trade_id, "TP1_PLACED", { price: t.config.tp1_price, qty: qty.toString(), order_id: id });
    } catch (e) {
      t.state.tp1_skipped = true;
      this.ev(t.trade_id, "TP1_FAILED", { error: (e as Error).message });
    }
  }

  private keyOf(ex: string, sym: string) {
    return `${ex}|${sym}`;
  }
  private bySymbol(): Map<string, Live[]> {
    if (!this.index) {
      this.index = new Map();
      for (const l of this.live.values()) {
        const k = this.keyOf(l.t.exchange, l.t.exchange_symbol);
        this.index.set(k, [...(this.index.get(k) ?? []), l]);
      }
    }
    return this.index;
  }
  private index: Map<string, Live[]> | null = null;

  private onTick(tk: Tick): void {
    const list = this.bySymbol().get(this.keyOf(tk.exchange, tk.symbol));
    if (!list) return;
    for (const l of list) {
      const t = l.t;
      if (l.closing || !this.live.has(t.trade_id)) continue;
      const price = t.config.trigger_price === "mark" ? tk.mark : tk.last;
      const now = tk.ts;
      const held = (now - t.timing.entry_fill_time) / 1000;
      // path stats on mark
      const move = pricePctMove(l.entry, tk.mark);
      if (move.gt(t.path.mfe_pct)) {
        t.path.mfe_pct = move.toFixed(6);
        t.path.time_to_mfe_s = Math.round(held);
      }
      if (move.lt(t.path.mae_pct)) {
        t.path.mae_pct = move.toFixed(6);
        t.path.time_to_mae_s = Math.round(held);
      }
      t.state.last_tick_ts = now;
      const roe = roeAtPrice(l.entry, price, t.config.leverage);
      const step = onTick(l.trail, l.levels, roe, t.state.tp1_order_id != null);
      l.trail = step.state;
      t.path.peak_roe = l.trail.peakRoe.toFixed(4);
      if (step.armedNow) {
        t.state.armed = true;
        this.ev(t.trade_id, "TRAIL_ARMED", { roe: roe.toFixed(4) });
      }
      if (step.newSlRoe) this.requestSlMove(l);
      if (t.config.max_hold_hours > 0 && held >= t.config.max_hold_hours * 3600) {
        void this.closeTrade(t.trade_id, "MAX_HOLD");
        continue;
      }
      if (now - l.lastPersist > PERSIST_MS) this.persist(l);
    }
  }

  /** Max 1 stop update per 2s per position, only if it moves >= 1 tick. Never moves down. */
  private requestSlMove(l: Live): void {
    if (l.slTimer || l.slBusy) return;
    const wait = l.lastSlUpdate + SL_THROTTLE_MS - this.d.clock.now();
    if (wait > 0) {
      l.slTimer = this.d.clock.setTimeout(() => {
        l.slTimer = null;
        void this.applySl(l);
      }, wait);
      return;
    }
    void this.applySl(l);
  }

  private async applySl(l: Live, force = false): Promise<void> {
    const t = l.t;
    if (l.closing || !this.live.has(t.trade_id) || !t.state.stop_order_id) return;
    const target = this.slPriceFor(l.entry, l.trail.slRoe, t.config.leverage, l.tick);
    const cur = D(t.state.sl_price);
    if (!force && target.sub(cur).lt(l.tick)) return;
    const newPrice = target.gt(cur) ? target : cur;
    l.slBusy = true;
    try {
      const id = await this.d.adapter.replaceStop(t.state.stop_order_id, {
        tradeId: t.trade_id, exchange: t.exchange, symbol: t.exchange_symbol, qty: D(t.state.qty_open), triggerPrice: newPrice,
        clientOrderId: `${t.trade_id.slice(-10)}-sl-${t.state.sl_moves + 10}`,
      });
      if (!this.live.has(t.trade_id)) return;
      t.state.stop_order_id = id;
      t.state.sl_price = newPrice.toString();
      t.state.sl_roe = l.trail.slRoe.toFixed(4);
      t.state.sl_moves++;
      l.lastSlUpdate = this.d.clock.now();
      this.ev(t.trade_id, "SL_MOVED", { price: t.state.sl_price, roe: t.state.sl_roe, order_id: id });
      this.persist(l);
    } catch (e) {
      // Old stop stays in place (cancel-replace places new first). Retry on next tick.
      this.ev(t.trade_id, "SL_MOVE_FAILED", { error: (e as Error).message });
    } finally {
      l.slBusy = false;
    }
  }

  private async onAdapter(e: AdapterEvent): Promise<void> {
    const l = this.live.get(e.tradeId);
    if (!l) return;
    const t = l.t;
    switch (e.type) {
      case "funding": {
        t.result.funding = D(t.result.funding).add(e.amount).toString();
        t.state.last_funding_ts = e.ts;
        this.ev(t.trade_id, "FUNDING", { amount: e.amount.toString(), rate: e.rate.toString() });
        this.persist(l);
        return;
      }
      case "data_gap": {
        t.state.data_gap = true;
        this.ev(t.trade_id, "DATA_GAP", { from: e.from, to: e.to });
        return;
      }
      case "tp_filled": {
        this.addLeg(l, "TP1_PARTIAL", e.fill, D(t.config.tp1_price));
        t.state.tp1_order_id = null;
        t.timing.tp1_time = e.ts;
        t.path.tp1_hit = true;
        this.ev(t.trade_id, "TP1_FILL", { price: e.fill.avgPrice?.toString(), qty: e.fill.filledQty.toString() });
        if (D(t.state.qty_open).lte(0)) return this.finish(l, "TP_FULL");
        const step = onTp1Fill(l.trail, l.levels);
        l.trail = step.state;
        t.state.tp1_filled = true;
        t.state.armed = l.trail.armed;
        await this.applySl(l, true); // resize stop to remaining qty and lock
        this.persist(l);
        return;
      }
      case "stop_filled": {
        const reason: ExitReason = t.state.armed || t.state.tp1_filled ? "TRAIL" : "SL";
        this.addLeg(l, reason, e.fill, e.triggerPrice);
        this.ev(t.trade_id, "STOP_FILL", { price: e.fill.avgPrice?.toString(), trigger: e.triggerPrice.toString() });
        if (D(t.state.qty_open).gt(0)) {
          this.persist(l);
          return; // partial stop fill; remaining stop still rests
        }
        return this.finish(l, reason);
      }
      case "liquidated": {
        const qty = e.qty;
        const entry = l.entry;
        // isolated: the whole remaining margin is lost; clearance fee = margin - price loss
        const marginLeft = D(t.state.margin_open);
        const priceLoss = entry.sub(e.price).mul(qty);
        const fee = marginLeft.sub(priceLoss);
        t.exit.legs.push(legRecord("EXIT", "LIQUIDATION", e.price, qty, fee.gt(0) ? fee : D(0), null, e.ts));
        t.state.qty_open = "0";
        this.ev(t.trade_id, "LIQUIDATION", { price: e.price.toString(), qty: qty.toString() });
        return this.finish(l, "LIQUIDATION");
      }
      case "position_gone": {
        this.ev(t.trade_id, "POSITION_GONE", {});
        return this.finish(l, "MANUAL");
      }
    }
  }

  private addLeg(l: Live, reason: ExitReason, f: FillResult, ref: Decimal | null) {
    const t = l.t;
    const leg = reason === "TP1_PARTIAL" ? "TP1_PARTIAL" : "EXIT";
    t.exit.legs.push(legRecord(leg, reason, f.avgPrice!, f.filledQty, f.fee, ref, f.ts));
    const open = D(t.state.qty_open);
    const share = f.filledQty.div(open);
    t.state.margin_open = D(t.state.margin_open).mul(D(1).sub(share)).toString();
    t.state.qty_open = open.sub(f.filledQty).toString();
  }

  private finish(l: Live, reason: ExitReason): void {
    const t = l.t;
    if (!this.live.has(t.trade_id)) return;
    l.slTimer?.();
    this.live.delete(t.trade_id);
    this.index = null;
    t.exit.reason = reason;
    finalizeResult(t);
    this.d.adapter.unregisterPosition(t.trade_id);
    this.ev(t.trade_id, "EXIT", { reason, net_pnl: t.result.net_pnl });
    this.d.store.records.upsertTrade(t);
    this.d.bus.emit("trade:closed", { botId: t.bot_id, tradeId: t.trade_id, reason, netPnl: t.result.net_pnl ?? "0" });
    this.d.onClosed(t);
    log.info({ botId: t.bot_id, runId: t.run_id, tradeId: t.trade_id, signalId: t.signal_id, reason, net: t.result.net_pnl }, "trade closed");
  }

  /** Protected market close (IOC at bid - slippage), widening the cap up to 3 times. */
  async closeTrade(tradeId: string, reason: ExitReason): Promise<boolean> {
    const l = this.live.get(tradeId);
    if (!l || l.closing) return false;
    l.closing = true;
    const t = l.t;
    try {
      for (let attempt = 1; attempt <= 3 && D(t.state.qty_open).gt(0); attempt++) {
        const book = this.d.hub.book(t.exchange, t.exchange_symbol);
        const ref = book?.bids[0]?.[0] ?? this.d.hub.lastTick(t.exchange, t.exchange_symbol)?.mark;
        if (!ref) break;
        const f = await this.d.adapter.placeIoc({
          clientOrderId: `${t.trade_id.slice(-10)}-x-${attempt}-${shortId().slice(0, 4)}`, tradeId, exchange: t.exchange,
          symbol: t.exchange_symbol, side: "sell", qty: D(t.state.qty_open), refPrice: ref,
          maxSlippagePct: this.d.maxSlippagePct() * attempt * 2, reduceOnly: true, leverage: t.config.leverage,
        });
        if (!this.live.has(tradeId)) return true; // stop filled meanwhile
        if (f.filledQty.gt(0)) this.addLeg(l, reason, f, ref);
        this.ev(tradeId, "CLOSE_ORDER", { attempt, filled: f.filledQty.toString(), price: f.avgPrice?.toString() ?? null, code: f.code });
      }
      if (D(t.state.qty_open).gt(0)) {
        l.closing = false;
        this.d.bus.emit("alert", { level: "error", kind: "CLOSE_FAILED", message: `Could not fully close ${t.symbol}`, botId: t.bot_id, tradeId, ts: this.d.clock.now() });
        this.persist(l);
        return false;
      }
      for (const oid of [t.state.stop_order_id, t.state.tp1_order_id]) if (oid) await this.d.adapter.cancel(tradeId, oid).catch(() => undefined);
      this.finish(l, reason);
      return true;
    } catch (e) {
      l.closing = false;
      this.ev(tradeId, "CLOSE_ERROR", { error: (e as Error).message });
      return false;
    }
  }

  /** Raise the stop to slRoe through the normal amend path (testnet verification). Never lowers it. */
  async raiseStop(tradeId: string, slRoe: Decimal): Promise<void> {
    const l = this.live.get(tradeId);
    if (!l || slRoe.lte(l.trail.slRoe)) return;
    l.trail = { ...l.trail, slRoe };
    await this.applySl(l, true);
  }

  async closeAll(reason: ExitReason): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.closeTrade(id, reason)));
  }

  /** Resume open trades after restart: re-register with the adapter, then reconcile. */
  async restore(trades: TradeRecord[], profileOf: (t: TradeRecord) => ExitProfile): Promise<void> {
    for (const t of trades) {
      const l = this.makeLive(t, profileOf(t));
      this.live.set(t.trade_id, l);
      this.index = null;
      this.d.adapter.registerPosition(this.ctxOf(t));
      await this.d.hub.subscribe(t.exchange, t.exchange_symbol, `pos:${t.trade_id}`).catch(() => undefined);
    }
    const ctxs = trades.map((t) => this.ctxOf(t));
    const report = await this.d.adapter.reconcile(ctxs);
    for (const r of report) if (r.tradeId) this.ev(r.tradeId, "RECONCILE", r);
    // Re-place protective orders the adapter reports missing, then let it catch up on downtime.
    for (const t of trades) {
      const l = this.live.get(t.trade_id);
      if (!l) continue;
      const r = report.find((x) => x.tradeId === t.trade_id);
      if (r?.status === "missing") {
        t.state.stop_order_id = null;
        t.state.tp1_order_id = null;
        if (!(await this.placeInitialStop(l))) continue;
        const m = this.d.hub.market(t.exchange, t.exchange_symbol);
        if (!t.state.tp1_filled && !t.state.tp1_skipped) await this.placeTp1(l, m?.qtyStep ?? D(0), m?.minQty ?? D(0));
      }
      this.persist(l);
    }
    const alive = trades.filter((t) => this.live.has(t.trade_id));
    await this.d.adapter.catchUp(alive.map((t) => this.ctxOf(t)), Object.fromEntries(alive.map((t) => [t.trade_id, t.state.last_tick_ts])));
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const l of this.live.values()) l.slTimer?.();
  }
}
