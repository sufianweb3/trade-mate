import type { ExchangeId } from "@oisniper/core";
import { randomBytes } from "node:crypto";
import { Bus } from "./bus";
import { BotManager } from "./engine/botManager";
import { makeAdapterFactory } from "./execution/factory";
import { LiveAccounts } from "./execution/liveAccounts";
import { FollowUpJob } from "./jobs/followUp";
import { log } from "./log";
import type { MarketHub } from "./market/types";
import { SymbolLock } from "./risk/riskManager";
import { SleepGuard } from "./risk/sleepGuard";
import { KEEP_MS, ScraperService } from "./scraper/service";
import type { RequiredGroup } from "./scraper/parser";
import type { SnapshotSource } from "./scraper/source";
import { Store } from "./store/store";
import { SymbolMapper } from "./symbols/mapper";
import type { Clock } from "./util/clock";
import { KeychainProvider, PassphraseProvider, Vault } from "./vault/vault";
import { WarmSet } from "./market/warmSet";
import { CcxtHub } from "./market/ccxtHub";
import { sourceKind, type SourceKind } from "./engine/sources";
import type { MetricKey, MetricRow } from "@oisniper/core";
import { call } from "./market/quirks/types";

export interface AppOptions {
  dbFile: string;
  clock: Clock;
  hub: MarketHub;
  source: SnapshotSource;
  /** Exchange-data signal source (always collected for comparison mode). Omitted in pure demos. */
  exchangeSource?: SnapshotSource;
  sleepGuard?: boolean;
  useKeychain?: boolean;
  passphrase?: string;
  dataDir?: string;
}

/** Composition root: one process, one bus, one SQLite file. */
export class App {
  readonly bus = new Bus();
  readonly store: Store;
  readonly mapper: SymbolMapper;
  readonly vault: Vault;
  readonly accounts: LiveAccounts;
  readonly scraper: ScraperService;
  /** Exchange data engine snapshots (null when no exchange source is configured). */
  readonly exchangeData: ScraperService | null;
  /** Latest row per symbol per source kind, so every signal can store both sources. */
  private latest = new Map<SourceKind, Map<string, MetricRow>>();
  readonly bots: BotManager;
  readonly followUp: FollowUpJob;
  readonly locks = new SymbolLock();
  readonly sleep: SleepGuard;
  readonly startedAt: number;
  private warm: WarmSet;

  constructor(readonly o: AppOptions) {
    this.store = new Store(o.dbFile);
    this.startedAt = o.clock.now();
    this.mapper = new SymbolMapper(o.hub);
    let salt = this.store.getSetting<string | null>("vault_salt", null);
    if (!salt) {
      salt = randomBytes(16).toString("base64");
      this.store.setSetting("vault_salt", salt);
    }
    const providers = [
      ...(o.useKeychain === false ? [] : [new KeychainProvider()]),
      new PassphraseProvider(o.passphrase ?? process.env.OISNIPER_PASSPHRASE, Buffer.from(salt, "base64")),
    ];
    this.vault = new Vault(providers);
    this.accounts = new LiveAccounts({ store: this.store, vault: this.vault });
    const interval = this.store.getSetting<number>("scrape_interval_ms", 30_000);
    // Degraded = a metric that an enabled rule (any bot) or the chase gate (price) needs has no column or no data.
    // Metrics inside an "at least N of" rule group may be absent (e.g. CoinGlass has no 5m volume change): the group
    // only degrades the source when fewer than N of its metrics have data.
    const cfgs = () => [...(this.bots?.bots.values() ?? [])].map((b) => b.config());
    const required = (): MetricKey[] => [...new Set<MetricKey>(["price", ...cfgs().flatMap((c) => {
      const grouped = new Set<string>((c.ruleGroups ?? []).flatMap((g) => g.metrics));
      return c.rules.filter((r) => r.enabled && !grouped.has(r.metric)).map((r) => r.metric);
    })])];
    const requiredGroups = (): RequiredGroup[] => cfgs().flatMap((c) => (c.ruleGroups ?? []).map((g) => ({
      metrics: g.metrics.filter((m) => c.rules.some((r) => r.metric === m && r.enabled)), minPass: g.minPass,
    })));
    this.scraper = new ScraperService(o.source, { bus: this.bus, store: this.store, clock: o.clock }, interval, { persistEveryMs: 0, keepMs: KEEP_MS, required, requiredGroups });
    // Exchange snapshots every 20s; persisted once a minute for 2 days (the full series lives in memory).
    this.exchangeData = o.exchangeSource
      ? new ScraperService(o.exchangeSource, { bus: this.bus, store: this.store, clock: o.clock }, 20_000, { persistEveryMs: 60_000, keepMs: 2 * 86_400_000, required, requiredGroups })
      : null;
    this.sleep = new SleepGuard(o.sleepGuard !== false);
    this.bots = new BotManager(
      {
        store: this.store, bus: this.bus, hub: o.hub, mapper: this.mapper, clock: o.clock, locks: this.locks,
        scrapeIntervalMs: () => Math.max(this.scraper.state.intervalMs, this.exchangeData?.state.intervalMs ?? 0),
        latestRow: (kind, symbol) => this.latest.get(kind)?.get(symbol) ?? null,
        createAdapter: makeAdapterFactory({ store: this.store, hub: o.hub, clock: o.clock, accounts: this.accounts }),
      },
      this.bus,
      this.sleep,
    );
    this.followUp = new FollowUpJob({ store: this.store, hub: o.hub, clock: o.clock, mapper: this.mapper });
    // Superseded by each bot's near-trigger watchlist; kept as an opt-in setting (0 = off).
    this.warm = new WarmSet(o.hub, this.mapper, () => this.store.getSetting<number>("warm_set_size", 0));
    this.bus.on("alert", (a) => {
      this.store.records.addError(a.ts, a.kind, a.kind, a.message);
      log.warn({ kind: a.kind, botId: a.botId, tradeId: a.tradeId }, a.message);
    });
    this.bus.on("snapshot", (s) => {
      // comparison mode keeps CoinGlass and aggregated exchange rows; per-venue variants are not compared
      if (s.source === "exchange" || sourceKind(s.source) === "coinglass") this.latest.set(sourceKind(s.source), new Map(s.rows.map((r) => [r.symbol, r])));
      void this.warm.update(s);
    });
  }

  /** Binance leverage brackets are private: use them as soon as any Binance key (read-only is enough) is connected. */
  syncLimitLoaders(): void {
    const hub = this.o.hub;
    if (!(hub instanceof CcxtHub)) return;
    const c = this.accounts.get("binance");
    hub.limits.setPrivateLoader(
      "binance",
      c ? async (s) => ((await call(c, "fetchLeverageTiers", [s])) as Record<string, unknown>)[s] : null,
    );
  }

  token(): string {
    let t = this.store.getSetting<string | null>("pair_token", null);
    if (!t) t = this.rotateToken();
    return t;
  }
  rotateToken(): string {
    const t = randomBytes(24).toString("base64url");
    this.store.setSetting("pair_token", t);
    return t;
  }

  /** Start order: market data, reconcile (inside bots.init) before anything trades, then scraper. */
  async start(opts: { scraper?: boolean } = {}): Promise<void> {
    await this.vault.unlock();
    await this.o.hub.start();
    this.mapper.reindex(this.o.hub.exchanges as ExchangeId[]);
    this.mapper.setOverrides(this.store.records.symbolOverrides());
    await this.accounts.loadStored();
    this.syncLimitLoaders();
    await this.bots.init();
    this.followUp.start();
    if (opts.scraper !== false) {
      // Exchange data does not depend on CoinGlass: start it alongside, never behind, the scraper.
      void this.exchangeData?.start();
      await this.scraper.start();
    }
  }

  async stop(): Promise<void> {
    this.followUp.dispose();
    await this.scraper.stop();
    await this.exchangeData?.stop();
    await this.bots.dispose();
    await this.o.hub.stop();
    this.sleep.set(false);
    this.store.close();
  }
}
