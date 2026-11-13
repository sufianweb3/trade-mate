import type { MetricKey, MetricsSnapshot, ScraperStatus, SnapshotHealth } from "@oisniper/core";
import type { Bus } from "../bus";
import { log } from "../log";
import type { Store } from "../store/store";
import type { Clock } from "../util/clock";
import { newId } from "../util/ids";
import { healthFor, parseTable, type RequiredGroup } from "./parser";
import type { SnapshotSource } from "./source";

export const KEEP_MS = 7 * 24 * 3_600_000;

export interface ScraperState {
  status: ScraperStatus;
  reason: string | null;
  lastSnapshotTs: number | null;
  lastHealth: SnapshotHealth | null;
  mapping: Record<string, string | null>;
  source: string;
  intervalMs: number;
  /** Source notes, e.g. "warming up: kucoin" or CoinGlass session info. */
  note: string | null;
  /** CoinGlass login state (null = unknown / not applicable). */
  loggedIn: boolean | null;
}

/** Runs the source on an interval, parses by header, tracks health and staleness. */
export class ScraperService {
  private stopTimer: (() => void) | null = null;
  private staleTimer: (() => void) | null = null;
  private busy = false;
  private prevRows: number | null = null;
  private latest: MetricsSnapshot | null = null;
  private lastPersist = 0;
  private lastTick = 0;
  state: ScraperState;

  constructor(
    private src: SnapshotSource,
    private d: { bus: Bus; store: Store; clock: Clock },
    intervalMs: number,
    private opts: { persistEveryMs: number; keepMs: number; minIntervalMs?: number; required?: () => MetricKey[]; requiredGroups?: () => RequiredGroup[] } = { persistEveryMs: 0, keepMs: KEEP_MS },
  ) {
    this.state = { status: "STOPPED", reason: null, lastSnapshotTs: null, lastHealth: null, mapping: {}, source: src.name, intervalMs, note: null, loggedIn: null };
  }

  get sourceName(): string {
    return this.src.name;
  }

  latestSnapshot(): MetricsSnapshot | null {
    return this.latest;
  }

  private setStatus(status: ScraperStatus, reason: string | null) {
    if (this.state.status === status && this.state.reason === reason) return;
    this.state.status = status;
    this.state.reason = reason;
    this.d.bus.emit("scraper:status", { status, reason: reason ?? undefined, ts: this.d.clock.now() });
    if (status === "DEGRADED" || status === "CHALLENGE")
      this.d.bus.emit("alert", { level: "warn", kind: `SCRAPER_${status}`, message: reason ?? status, ts: this.d.clock.now() });
  }

  async start(): Promise<void> {
    this.setStatus("STARTING", null);
    try {
      await this.src.start();
    } catch (e) {
      this.setStatus("STOPPED", (e as Error).message);
      this.d.store.records.addError(this.d.clock.now(), "scraper", "SCRAPER_DEGRADED", (e as Error).message);
      return;
    }
    this.schedule();
    // Push mode: the source tells us when new data is on screen; the interval stays as a fallback.
    this.src.onChange?.(() => {
      if (this.d.clock.now() - this.lastTick >= (this.opts.minIntervalMs ?? 2000)) void this.tick();
    });
    await this.tick();
  }

  private schedule() {
    this.stopTimer?.();
    this.stopTimer = this.d.clock.setInterval(() => void this.tick(), this.state.intervalMs);
    this.staleTimer?.();
    this.staleTimer = this.d.clock.setInterval(() => this.checkStale(), 5000);
  }

  setInterval(ms: number): void {
    this.state.intervalMs = Math.min(120_000, Math.max(15_000, ms));
    if (this.stopTimer) this.schedule();
  }

  private checkStale() {
    const last = this.state.lastSnapshotTs;
    if (last != null && this.d.clock.now() - last > 2 * this.state.intervalMs && this.state.status === "OK")
      this.setStatus("STALE", "snapshot older than 2x interval");
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const started = this.d.clock.now();
    this.lastTick = started;
    try {
      const res = await this.src.read();
      this.state.loggedIn = res.loggedIn ?? this.state.loggedIn;
      this.state.note = res.note ?? null;
      if (res.challenge) {
        this.setStatus("CHALLENGE", res.note ?? "Blocked or challenged: open Health and click Show browser");
        return;
      }
      const required = this.opts.required?.();
      const groups = this.opts.requiredGroups?.() ?? [];
      const parsed = res.rows ? null : parseTable(res.table, this.prevRows, started, required, groups);
      const rows = res.rows ?? parsed!.rows;
      const health = parsed ? parsed.health : healthFor(rows, this.prevRows, started, [], required, groups);
      this.prevRows = rows.length || this.prevRows;
      const now = this.d.clock.now();
      const snap: MetricsSnapshot = { id: newId("snap"), ts: now, dataTs: res.dataTs ?? now, source: this.src.name, rows, health };
      this.state.lastHealth = health;
      this.state.mapping = parsed?.mapping ?? {};
      this.state.lastSnapshotTs = snap.ts;
      if (now - this.lastPersist >= this.opts.persistEveryMs) {
        this.lastPersist = now;
        this.d.store.records.insertSnapshot(snap, this.opts.keepMs);
      }
      this.setStatus(health.status, health.status === "DEGRADED" ? `missing: ${health.missingColumns.join(", ") || "rows dropped"}${res.note ? ` (${res.note})` : ""}` : null);
      this.latest = snap;
      this.d.bus.emit("snapshot", snap);
      for (const [source, vrows] of Object.entries(res.variants ?? {}))
        this.d.bus.emit("snapshot", { ...snap, id: newId("snap"), source, rows: vrows, health: healthFor(vrows, null, started) });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "scrape failed");
      this.d.store.records.addError(this.d.clock.now(), "scraper", null, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  async showBrowser(show: boolean): Promise<void> {
    await this.src.setVisible(show);
  }

  async stop(): Promise<void> {
    this.stopTimer?.();
    this.staleTimer?.();
    this.stopTimer = null;
    await this.src.stop();
    this.setStatus("STOPPED", null);
  }
}
