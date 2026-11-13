import {
  D, Decimal, evaluateRules, expandProfiles, validateBotConfig, ZERO, EXCHANGES, marginFor,
  type BotConfig, type ExchangeId, type ExitProfile, type MetricRow, type MetricsSnapshot, type ScraperStatus,
} from "@oisniper/core";
import type { Bus } from "../bus";
import type { ExecutionAdapter } from "../execution/types";
import { initialRunBalance } from "../execution/factory";
import { log } from "../log";
import type { MarketHub } from "../market/types";
import { PositionManager } from "../positions/positionManager";
import { RiskManager, type SymbolLock } from "../risk/riskManager";
import { route, type Venue } from "../router/router";
import type { BotRow, RunRow, Store } from "../store/store";
import type { FitInfo, GateResult, SignalRecord, TradeRecord, VenueTry } from "../store/types";
import type { SymbolMapper } from "../symbols/mapper";
import type { Clock } from "../util/clock";
import { newId } from "../util/ids";
import { preChecks } from "./preChecks";
import { applyEquity, computeEquity, type Equity } from "./equity";
import { newSignalRecord, openOne } from "./openTrade";
import { Watchlist } from "./watchlist";
import { sourceRole, type SourceKind } from "./sources";
import { marketAtEntry, planProfiles } from "./entry";

export interface BotDeps {
  store: Store;
  bus: Bus;
  hub: MarketHub;
  mapper: SymbolMapper;
  clock: Clock;
  locks: SymbolLock;
  scrapeIntervalMs: () => number;
  killSwitch: () => boolean;
  createAdapter: (botId: string, cfg: BotConfig, run: RunRow) => ExecutionAdapter;
  /** Latest metric row for a symbol from a source (comparison mode stores both sources on every signal). */
  latestRow: (kind: SourceKind, symbol: string) => MetricRow | null;
}

export type BotStatus = "stopped" | "running" | "paused" | "halted";

interface VenueOutcome {
  exchange: ExchangeId;
  opened: boolean;
  codes: string[];
  retry: boolean;
  gates: GateResult[];
  fit: FitInfo | null;
  skipped: { variant_id: string; code: string }[];
}

const cfg0 = (c: BotConfig): ExchangeId[] => (c.exchanges === "ALL" ? [...EXCHANGES] : c.exchanges);

/** One engine instance. Bot 1 and Bot 2 are the same class with different configs. */
export class BotInstance {
  readonly id: string;
  private adapter!: ExecutionAdapter;
  pm!: PositionManager;
  private risk: RiskManager;
  private queue: Promise<void> = Promise.resolve();
  private prevMatched = new Set<string>();
  private prevShadow = new Set<string>();
  private watch: Watchlist | null = null;
  private stopEquity: (() => void) | null = null;

  constructor(private d: BotDeps, row: BotRow) {
    this.id = row.id;
    this.risk = new RiskManager(d.store, row.id, () => d.clock.now());
  }

  row(): BotRow {
    return this.d.store.getBot(this.id)!;
  }
  config(): BotConfig {
    return this.d.store.getVersion(this.row().current_version_id)!.config;
  }
  versionId(): string {
    return this.row().current_version_id;
  }
  run(): RunRow {
    return this.d.store.getRun(this.row().current_run_id!)!;
  }
  get mode() {
    return this.config().mode;
  }
  adapterRef(): ExecutionAdapter {
    return this.adapter;
  }

  /** Build the adapter + position manager for the current run and resume open trades. */
  async init(): Promise<void> {
    if (!this.row().current_run_id) this.newRun();
    this.attach();
    const open = this.d.store.records.listTrades({ botId: this.id, runId: this.run().id, status: "open" });
    for (const t of open) this.d.locks.tryLock(this.adapter.accountId(t.exchange), t.exchange_symbol, this.id);
    await this.pm.restore(open, (t) => this.profileOf(t));
    this.stopEquity = this.d.clock.setInterval(() => void this.recordEquity(), 60_000);
  }

  private attach() {
    const cfg = this.config();
    this.adapter = this.d.createAdapter(this.id, cfg, this.run());
    this.watch = new Watchlist({ botId: this.id, hub: this.d.hub, mapper: this.d.mapper, adapter: () => this.adapter });
    this.pm = new PositionManager({
      botId: this.id, store: this.d.store, bus: this.d.bus, hub: this.d.hub, clock: this.d.clock, adapter: this.adapter,
      maxSlippagePct: () => this.config().execution.maxSlippagePct,
      onClosed: (t) => this.onClosed(t),
    });
  }

  private async detach() {
    this.watch?.clear();
    this.pm?.dispose();
    await this.adapter?.close();
  }

  profileOf(t: TradeRecord): ExitProfile {
    const v = this.d.store.getVersion(t.strategy_version_id)?.config ?? this.config();
    const all = expandProfiles({ ...v, mode: "paper" });
    const p = all.find((x) => x.variantId === t.variant_id) ?? all[0]!;
    // Adaptive entry may have traded below the configured leverage: the trade's own leverage is the truth.
    return p.leverage === t.config.leverage ? p : { ...p, leverage: t.config.leverage };
  }

  private newRun(): RunRow {
    const cfg = this.config();
    const now = this.d.clock.now();
    const { start, unlimited } = initialRunBalance(cfg);
    const run: RunRow = {
      id: newId("run"), bot_id: this.id, mode: cfg.mode, start_balance: start, cash: start, unlimited: unlimited ? 1 : 0,
      peak_equity: start, day_key: null, day_start_equity: null, paused_until: null, pause_reason: null,
      consecutive_losses: 0, started_at: now, ended_at: null, archived: 0,
    };
    this.d.store.insertRun(run);
    this.d.store.updateBot(this.id, { current_run_id: run.id });
    return run;
  }

  setStatus(status: BotStatus, reason: string | null = null): void {
    this.d.store.updateBot(this.id, { status, status_reason: reason, running: status === "stopped" || status === "halted" ? 0 : 1 });
    this.d.bus.emit("bot:status", { botId: this.id, status, reason: reason ?? undefined });
  }

  async start(): Promise<void> {
    const v = validateBotConfig(this.config());
    if (v.errors.length) throw Object.assign(new Error(v.errors.map((e) => e.message).join("; ")), { code: "INVALID_CONFIG" });
    // Live: at least one configured exchange must have connected, validated, trade-enabled keys.
    const exchanges = cfg0(this.config());
    if (!exchanges.some((ex) => this.adapter.canTrade(ex)))
      throw Object.assign(new Error("No configured exchange has connected and validated API keys."), { code: "AUTH_FAILED" });
    const r = this.run();
    if (r.start_balance == null) {
      const bal = await this.adapter.walletBalance();
      this.d.store.updateRun(r.id, { start_balance: bal?.toString() ?? null, peak_equity: bal?.toString() ?? null });
    }
    this.setStatus("running");
  }

  /** Stop new entries. Open positions keep being managed unless closeAll is set. */
  async stop(reason: string | null = null, closeAll = false): Promise<void> {
    this.setStatus("stopped", reason);
    if (closeAll) await this.pm.closeAll("MANUAL");
  }

  /** Save creates a new immutable version. Open positions keep the version they opened with. Mode is fixed per bot. */
  saveConfig(cfg: BotConfig): string {
    const cur = this.config();
    if (cfg.mode !== cur.mode)
      throw Object.assign(new Error(`This bot is ${cur.mode} only. Paper and Real are separate bots with separate settings.`), { code: "INVALID_CONFIG" });
    const v = validateBotConfig(cfg);
    if (v.errors.length) throw Object.assign(new Error(v.errors.map((e) => e.message).join("; ")), { code: "INVALID_CONFIG", issues: v.errors });
    const ver = this.d.store.saveVersion(this.id, cfg, this.d.clock.now());
    this.d.store.updateBot(this.id, { current_version_id: ver.id, name: cfg.name });
    if (cfg.paperInitialFunds !== cur.paperInitialFunds && this.pm.openCount() === 0) void this.resetRun();
    return ver.id;
  }

  /** Paper reset archives the run; history stays exportable. */
  async resetRun(): Promise<RunRow> {
    if (this.pm.openCount() > 0) throw Object.assign(new Error("Close open positions before reset."), { code: "INVALID_CONFIG" });
    const old = this.run();
    this.d.store.updateRun(old.id, { archived: 1, ended_at: this.d.clock.now() });
    await this.detach();
    const run = this.newRun();
    this.attach();
    return run;
  }

  /** Called by the scraper fan-out. Signals for one bot are processed in order. */
  handleSnapshot(snap: MetricsSnapshot, status: ScraperStatus): Promise<void> {
    this.queue = this.queue.then(() => this.process(snap, status)).catch((e) => {
      log.error({ botId: this.id, err: (e as Error).message }, "snapshot processing failed");
      this.d.store.records.addError(this.d.clock.now(), `bot:${this.id}`, "EXCHANGE_ERROR", (e as Error).message);
    });
    return this.queue;
  }

  private async process(snap: MetricsSnapshot, status: ScraperStatus): Promise<void> {
    const row = this.row();
    if (!row.running) return;
    const cfg = this.config();
    const role = sourceRole(cfg, snap.source);
    if (role === "shadow") return this.shadow(cfg, snap);
    if (role !== "trade") return;
    const matched = new Set<string>();
    const cooldownMs = cfg.cooldownHours * 3_600_000;
    const btc = snap.rows.find((r) => r.symbol === "BTC");
    const todo: { m: MetricRow; rules: SignalRecord["rule_results"] }[] = [];
    for (const m of snap.rows) {
      const ev = evaluateRules(m, cfg.rules, cfg.ruleGroups);
      if (!ev.matched) continue;
      matched.add(m.symbol);
      // Dedupe: consecutive re-matches inside the cooldown window bump one signal.
      const last = this.d.store.records.lastSignalFor(this.id, m.symbol);
      if (last && this.prevMatched.has(m.symbol) && snap.ts - last.ts < Math.max(cooldownMs, 1)) {
        this.d.store.records.bumpRematch(last.id, snap.ts);
        continue;
      }
      todo.push({ m, rules: ev.results });
    }
    this.prevMatched = matched;
    // One at a time when a max-open-positions limit must be counted exactly; otherwise (Test grid) up to 4 symbols
    // in parallel so a burst of matches is not judged stale by the freshness gate. Symbols are distinct, so the
    // cooldown and symbol lock cannot collide.
    const parallel = cfg.risk.maxOpenPositions == null ? 4 : 1;
    for (let i = 0; i < todo.length; i += parallel)
      await Promise.all(todo.slice(i, i + parallel).map((x) => this.onSignal(cfg, snap, x.m, x.rules, status, btc)));
    // Near-trigger watchlist: warm books, limits and (live) account setup before the next trigger.
    void this.watch?.update(cfg, snap.rows).catch(() => undefined);
  }

  /** Comparison mode: what the other source would have fired. Rules only, no gates, never trades. */
  private shadow(cfg: BotConfig, snap: MetricsSnapshot): void {
    const matched = new Set<string>();
    for (const m of snap.rows) {
      const ev = evaluateRules(m, cfg.rules, cfg.ruleGroups);
      if (!ev.matched) continue;
      matched.add(m.symbol);
      if (this.prevShadow.has(m.symbol)) continue; // consecutive re-match: one shadow signal
      const sig = this.newSignal(cfg, snap, m, ev.results);
      sig.status = "shadow";
      this.saveSignal(sig);
    }
    this.prevShadow = matched;
  }

  private newSignal(cfg: BotConfig, snap: MetricsSnapshot, m: MetricRow, rules: SignalRecord["rule_results"]): SignalRecord {
    return newSignalRecord({ botId: this.id, runId: this.run().id, versionId: this.versionId(), now: this.d.clock.now(), cfg, snap, m, rules, latestRow: this.d.latestRow });
  }

  private async onSignal(cfg: BotConfig, snap: MetricsSnapshot, m: MetricRow, rules: SignalRecord["rule_results"], status: ScraperStatus, btc: MetricRow | undefined) {
    const now = this.d.clock.now();
    const run = this.run();
    const sig = this.newSignal(cfg, snap, m, rules);
    const reject = (codes: string[], st: SignalRecord["status"] = "rejected") => {
      sig.status = st;
      sig.reject_reasons = [...new Set(codes)];
      this.saveSignal(sig);
    };
    const pre = preChecks({ botId: this.id, cfg, m, status, now, store: this.d.store, risk: this.risk, runId: run.id, openCount: this.pm.openCount(), killed: this.d.killSwitch() });
    if (pre) {
      if (pre.cooldown) sig.cooldown = pre.cooldown;
      return reject(pre.codes, pre.cooldown ? "cooldown" : "rejected");
    }

    const profiles = expandProfiles(cfg);
    const wallet = await this.adapter.walletBalance();
    const avail = await this.adapter.available();
    const margin = marginFor(cfg.sizing, wallet);
    const maxNotional = profiles.reduce((a, p) => Decimal.max(a, margin.mul(p.leverage)), ZERO);
    // Adaptive entry can trade a smaller order: the router must not drop a venue that fills the smallest fit.
    const ad = cfg.adaptive;
    const fitting = (ad.leverage === "fit" || ad.size === "fit") && profiles.length === 1;
    const minNotional = fitting
      ? margin.mul(ad.size === "fit" ? ad.minSizePct : 100).div(100).mul(ad.leverage === "fit" ? Math.min(ad.minLeverage, profiles[0]!.leverage) : profiles[0]!.leverage)
      : null;
    const exchanges = (cfg.exchanges === "ALL" ? [...EXCHANGES] : cfg.exchanges).filter((e) => this.d.hub.exchanges.includes(e));
    const rt = await route(this.d.hub, this.d.mapper, {
      coinglass: m.symbol, cgPrice: m.price, exchanges, notional: maxNotional, minNotional,
      fitLeverage: fitting && ad.leverage === "fit" ? profiles[0]!.leverage : null, gates: cfg.gates, now: this.d.clock.now(),
      canTrade: (ex) => this.adapter.canTrade(ex), takerPct: (ex, s) => this.adapter.takerPct(ex, s),
      hasFreeMargin: () => avail == null || avail.gte(margin),
      reason: `cand:${sig.signal_id}`,
    });
    sig.router = rt.candidates;
    if (!rt.ranked.length) return reject(avail != null && avail.lt(margin) ? ["INSUFFICIENT_MARGIN"] : ["NO_VENUE"]);
    // Gate the ranked venues in order; the first that passes trades. When none passes, reasons and fit come from the
    // best-ranked venue; gate_results keep every venue's gates, tagged with the exchange.
    const tries: VenueTry[] = [];
    const gates: GateResult[] = [];
    let best: VenueOutcome | null = null;
    try {
      for (const v of rt.ranked) {
        const o = await this.enter(cfg, snap, m, sig, btc, profiles, wallet, v);
        tries.push({ exchange: v.exchange, pass: o.opened, codes: o.codes, leverage: o.fit?.leverage ?? null, size_pct: o.fit?.size_pct ?? null });
        gates.push(...o.gates.map((g) => ({ ...g, exchange: v.exchange })));
        if (o.opened) best = o;
        else best ??= o;
        if (o.opened || !o.retry) break;
      }
    } finally {
      for (const v of rt.ranked) this.d.hub.unsubscribe(v.exchange, v.symbol, `cand:${sig.signal_id}`); // open positions hold their own subscription
    }
    const o = best!;
    sig.exchange = o.exchange;
    sig.gate_results = gates;
    sig.venue_tries = tries;
    if (o.fit) sig.fit = o.fit;
    sig.skipped_variants = o.skipped;
    sig.latency.gates_done_ts = this.d.clock.now();
    if (!o.opened) return reject(o.codes);
    this.d.store.setLastEntry(this.id, m.symbol, this.d.clock.now());
    sig.status = "opened";
    this.saveSignal(sig);
  }

  /** Gate and, if every gate passes, open on one venue. `retry` = safe to try the next venue (no order was sent). */
  private async enter(
    cfg: BotConfig, snap: MetricsSnapshot, m: MetricRow, sig: SignalRecord, btc: MetricRow | undefined, profiles: ExitProfile[],
    wallet: Decimal | null, v: Venue,
  ): Promise<VenueOutcome> {
    const { exchange, symbol, multiplier } = v;
    const out = (opened: boolean, codes: string[], retry: boolean, rest: Partial<VenueOutcome> = {}): VenueOutcome =>
      ({ exchange, opened, codes: [...new Set(codes)], retry, gates: [], fit: null, skipped: [], ...rest });
    const account = this.adapter.accountId(exchange);
    if (!this.d.locks.tryLock(account, symbol, this.id)) return out(false, ["SYMBOL_LOCKED"], true);
    // Re-entry while open (paper grid): a failed re-entry must not release the lock its open positions hold.
    const release = () => {
      if (!this.pm.openTrades().some((x) => x.exchange === exchange && x.exchange_symbol === symbol))
        this.d.locks.release(account, symbol, this.id);
    };
    try {
      await this.d.hub.resolveLimits(exchange, symbol); // cached; pre-warmed for the near-trigger watchlist
      const market = this.d.hub.market(exchange, symbol)!;
      const plan = planProfiles({
        cfg, profiles, hub: this.d.hub, adapter: this.adapter, exchange, symbol, market, snapshot: snap,
        scrapeIntervalMs: this.d.scrapeIntervalMs(), signalPrice: m.price != null ? D(m.price).mul(multiplier) : null,
        balance: wallet, now: this.d.clock.now(),
      });
      const skipped = plan.rejected.map((r) => ({ variant_id: r.profile.variantId, code: r.codes[0] ?? "UNKNOWN" }));
      const info = { gates: plan.gateResults, fit: plan.fit, skipped };
      if (!plan.accepted.length) {
        release();
        return out(false, plan.rejected.flatMap((r) => r.codes), true, info);
      }
      sig.exchange = exchange; // the trade record copies the signal's venue
      sig.skipped_variants = [...skipped]; // openOne appends order failures here
      const mkt = marketAtEntry(this.d.hub, exchange, symbol, btc);
      const od = { botId: this.id, cfg: this.config(), adapter: this.adapter, hub: this.d.hub, store: this.d.store, bus: this.d.bus, pm: this.pm };
      const opened = await Promise.all(plan.accepted.map((c, n) => openOne(od, sig, c, n, exchange, symbol, market, mkt)));
      sig.opened_trades = opened.filter(Boolean).length;
      const after = { ...info, skipped: [...sig.skipped_variants] };
      if (sig.opened_trades === 0) {
        release();
        // An order was attempted on this venue: never try another one within the same signal.
        return out(false, after.skipped.map((s) => s.code), false, after);
      }
      return out(true, [], false, after);
    } catch (e) {
      release();
      throw e;
    }
  }

  private saveSignal(sig: SignalRecord) {
    if (this.d.store.records.getSignal(sig.signal_id)) this.d.store.records.updateSignal(sig);
    else this.d.store.records.insertSignal(sig);
    this.d.bus.emit("signal", { botId: this.id, signalId: sig.signal_id, symbol: sig.symbol, status: sig.status });
  }

  private onClosed(t: TradeRecord) {
    const cfg = this.config();
    // Cooldown also runs 12h from the close (latest close wins for grid variants).
    this.d.store.setLastClose(this.id, t.symbol, t.timing.exit_time ?? this.d.clock.now());
    if (!this.pm.openTrades().some((x) => x.exchange === t.exchange && x.exchange_symbol === t.exchange_symbol))
      this.d.locks.release(this.adapter.accountId(t.exchange), t.exchange_symbol, this.id);
    const code = this.risk.onTradeClosed(t.run_id, D(t.result.net_pnl ?? "0"), cfg.risk);
    // A pause must never revive a stopped/halted bot (e.g. losses realized by the kill switch).
    if (code && this.row().status === "running") {
      this.setStatus("paused", code);
      this.d.bus.emit("alert", { level: "warn", kind: code, message: `${cfg.name} paused: ${code}`, botId: this.id, ts: this.d.clock.now() });
    }
    void this.recordEquity();
  }

  equity(): Promise<Equity> {
    return computeEquity(this.adapter, this.pm, this.d.hub);
  }

  async recordEquity(): Promise<void> {
    const e = await this.equity();
    applyEquity({
      botId: this.id, e, run: this.run(), cfg: this.config(), status: this.row().status as BotStatus, now: this.d.clock.now(),
      store: this.d.store, risk: this.risk, bus: this.d.bus, setStatus: (s, r) => this.setStatus(s, r ?? null), currentRun: () => this.run(),
    });
  }

  async kill(): Promise<void> {
    this.setStatus("stopped", "KILL_SWITCH");
    await this.pm.closeAll("KILL_SWITCH");
  }

  async dispose(): Promise<void> {
    this.stopEquity?.();
    await this.queue.catch(() => undefined);
    await this.detach();
  }
}
