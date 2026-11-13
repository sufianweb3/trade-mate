import { D, Decimal, expandProfiles, HUNDRED, priceAtRoe, toRoe, type ExchangeId } from "@oisniper/core";
import type { MarketHub } from "../market/types";
import type { Store } from "../store/store";
import type { SignalRecord } from "../store/types";
import type { SymbolMapper } from "../symbols/mapper";
import type { Clock } from "../util/clock";

const M15 = 15 * 60_000;
const H1 = 3_600_000;
const H4 = 4 * H1;

interface CfState {
  ref_price: string | null;
  chg_15m: string | null;
  chg_1h: string | null;
  chg_4h: string | null;
  first_hit: "TP1" | "SL" | "NONE" | null;
  leverage: number | null;
  exchange: ExchangeId | null;
  symbol: string | null;
  tp: string | null;
  sl: string | null;
}

/**
 * Background job: price after exit (+15m/+1h/+4h) for trades, and counterfactuals for rejected signals
 * (price change and whether TP1 or SL would have hit first). Sampled every 30s.
 */
export class FollowUpJob {
  private stop: (() => void) | null = null;
  constructor(private d: { store: Store; hub: MarketHub; clock: Clock; mapper: SymbolMapper }) {}

  start(): void {
    this.stop = this.d.clock.setInterval(() => void this.run(), 30_000);
  }
  dispose(): void {
    this.stop?.();
  }

  /** One REST price per symbol per cycle, however many signals track it. */
  private cache = new Map<string, Promise<Decimal | null>>();
  private price(ex: ExchangeId, sym: string): Promise<Decimal | null> {
    const tick = this.d.hub.lastTick(ex, sym);
    if (tick && this.d.clock.now() - tick.ts < 60_000) return Promise.resolve(tick.mark);
    const k = `${ex}|${sym}`;
    let p = this.cache.get(k);
    if (!p) this.cache.set(k, (p = this.d.hub.fetchPrice(ex, sym).catch(() => null)));
    return p;
  }

  async run(): Promise<void> {
    this.cache.clear();
    await this.trades();
    await this.signals();
  }

  private async trades() {
    const now = this.d.clock.now();
    const recent = this.d.store.records.listTrades({ status: "closed", from: now - 30 * H1 });
    for (const t of recent) {
      const exit = t.timing.exit_time;
      const ae = t.after_exit;
      if (!exit || (ae.chg_15m && ae.chg_1h && ae.chg_4h)) continue;
      const lastLeg = t.exit.legs[t.exit.legs.length - 1];
      if (!lastLeg) continue;
      const ref = D(lastLeg.price);
      let changed = false;
      for (const [k, dt] of [["chg_15m", M15], ["chg_1h", H1], ["chg_4h", H4]] as const) {
        if (ae[k] == null && now >= exit + dt) {
          const p = await this.price(t.exchange, t.exchange_symbol);
          if (p) {
            ae[k] = p.div(ref).sub(1).mul(HUNDRED).toFixed(6);
            changed = true;
          }
        }
      }
      if (changed) this.d.store.records.upsertTrade(t);
    }
  }

  private async signals() {
    const now = this.d.clock.now();
    // Thousands of pending signals (Test + shadow) are sampled every cycle: parse the full signal only when needed,
    // write only on change, and yield regularly so position management never waits behind this job.
    let n = 0;
    for (const row of this.d.store.records.pendingCounterfactuals()) {
      if (++n % 200 === 0) await new Promise((r) => setImmediate(r));
      let sig: SignalRecord | null = null;
      const sigOf = () => (sig ??= JSON.parse(this.d.store.records.signalData(row.id) ?? "null") as SignalRecord);
      const cf: CfState = row.cf_data ? (JSON.parse(row.cf_data) as CfState) : this.initCf(sigOf());
      const before = row.cf_data;
      const save = (done: boolean) => {
        const s = JSON.stringify(cf);
        if (done || s !== before) this.d.store.records.setCounterfactual(row.id, cf, done);
      };
      if (!cf.exchange || !cf.symbol) {
        save(true);
        continue;
      }
      const p = await this.price(cf.exchange, cf.symbol);
      if (!p) {
        if (now - row.ts > H4 + H1) save(true);
        continue;
      }
      if (!cf.ref_price) cf.ref_price = p.toString();
      const ref = D(cf.ref_price);
      if (!cf.tp || !cf.sl) Object.assign(cf, this.levels(sigOf(), ref));
      if (cf.first_hit == null && cf.tp && cf.sl) {
        if (p.gte(cf.tp)) cf.first_hit = "TP1";
        else if (p.lte(cf.sl)) cf.first_hit = "SL";
      }
      for (const [k, dt] of [["chg_15m", M15], ["chg_1h", H1], ["chg_4h", H4]] as const)
        if (cf[k] == null && now >= row.ts + dt) cf[k] = p.div(ref).sub(1).mul(HUNDRED).toFixed(6);
      const done = cf.chg_4h != null;
      if (done && cf.first_hit == null) cf.first_hit = "NONE";
      save(done);
    }
  }

  /** Signals rejected before routing (cooldown, risk pause) have no candidates: resolve a venue via the mapper. */
  private venueFor(sig: SignalRecord): { exchange: ExchangeId; exchange_symbol: string } | null {
    const fromRouter = sig.router.find((c) => c.exchange === sig.exchange && c.exchange_symbol) ?? sig.router.find((c) => c.exchange_symbol);
    if (fromRouter?.exchange_symbol) return { exchange: fromRouter.exchange, exchange_symbol: fromRouter.exchange_symbol };
    for (const ex of this.d.hub.exchanges) {
      const m = this.d.mapper.resolve(sig.symbol, ex, null, null);
      if (m.ok) return { exchange: ex, exchange_symbol: m.mapping.symbol };
    }
    return null;
  }

  private initCf(sig: SignalRecord): CfState {
    const cand = this.venueFor(sig);
    const tick = cand?.exchange_symbol ? this.d.hub.lastTick(cand.exchange, cand.exchange_symbol) : null;
    const ref = tick?.mark ?? null;
    return {
      ref_price: ref?.toString() ?? null,
      chg_15m: null, chg_1h: null, chg_4h: null, first_hit: null,
      leverage: null,
      exchange: cand?.exchange ?? null,
      symbol: cand?.exchange_symbol ?? null,
      tp: null,
      sl: null,
      ...(ref ? this.levels(sig, ref) : {}),
    };
  }

  /** TP1 / SL prices of the bot's first profile from the reference price. */
  private levels(sig: SignalRecord, ref: Decimal): Pick<CfState, "tp" | "sl" | "leverage"> {
    const ver = this.d.store.getVersion(sig.strategy_version_id)?.config;
    const prof = ver ? expandProfiles({ ...ver, mode: "paper" })[0] : undefined;
    if (!prof) return { tp: null, sl: null, leverage: null };
    return {
      leverage: prof.leverage,
      tp: priceAtRoe(ref, toRoe(prof.tp1Pct, prof.basis, prof.leverage), prof.leverage).toString(),
      sl: priceAtRoe(ref, toRoe(prof.slPct, prof.basis, prof.leverage).neg(), prof.leverage).toString(),
    };
  }
}
