import { BotConfigSchema, canonicalJson, type BotConfig } from "@oisniper/core";
import { sha256 } from "../util/ids";
import { openDb, type Db } from "./db";
import { Records } from "./records";

export interface BotRow {
  id: string;
  name: string;
  preset: string;
  current_version_id: string;
  current_run_id: string | null;
  running: number;
  status: string;
  status_reason: string | null;
  layout: string | null;
  created_at: number;
}

export interface RunRow {
  id: string;
  bot_id: string;
  mode: "paper" | "live";
  start_balance: string | null;
  cash: string | null;
  unlimited: number;
  peak_equity: string | null;
  day_key: string | null;
  day_start_equity: string | null;
  paused_until: number | null;
  pause_reason: string | null;
  consecutive_losses: number;
  started_at: number;
  ended_at: number | null;
  archived: number;
}

export interface VersionRow {
  id: string;
  bot_id: string;
  hash: string;
  config: BotConfig;
  created_at: number;
}

export class Store {
  readonly db: Db;
  readonly records: Records;

  constructor(file: string) {
    this.db = openDb(file);
    this.records = new Records(this.db);
  }

  close(): void {
    this.db.close();
  }

  // settings
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  // bots
  listBots(): BotRow[] {
    return this.db.prepare("SELECT * FROM bots ORDER BY created_at, id").all() as unknown as BotRow[];
  }
  // Bot rows and versions are read on hot paths (every tick / signal). Bot rows are cached and invalidated on every
  // write (all writes go through insertBot / updateBot); versions are immutable and handed out as copies.
  private botCache = new Map<string, BotRow>();
  private versionCache = new Map<string, VersionRow>();

  getBot(id: string): BotRow | null {
    const c = this.botCache.get(id);
    if (c) return { ...c };
    const r = (this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as unknown as BotRow | undefined) ?? null;
    if (r) this.botCache.set(id, { ...r });
    return r;
  }
  insertBot(b: Omit<BotRow, "running" | "status" | "status_reason" | "layout" | "current_run_id">): void {
    this.botCache.delete(b.id);
    this.db
      .prepare("INSERT INTO bots (id, name, preset, current_version_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(b.id, b.name, b.preset, b.current_version_id, b.created_at);
  }
  updateBot(id: string, patch: Partial<Omit<BotRow, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.botCache.delete(id);
    const sql = `UPDATE bots SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...(keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null)), id);
  }

  // strategy versions (immutable)
  saveVersion(botId: string, config: BotConfig, now: number): VersionRow {
    const parsed = BotConfigSchema.parse(config);
    const json = canonicalJson(parsed);
    const hash = sha256(json);
    const id = `sv_${hash.slice(0, 12)}`;
    const existing = this.getVersion(id);
    if (existing) return existing;
    this.db
      .prepare("INSERT INTO strategy_versions (id, bot_id, hash, config, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, botId, hash, json, now);
    return { id, bot_id: botId, hash, config: parsed, created_at: now };
  }
  getVersion(id: string): VersionRow | null {
    const c = this.versionCache.get(id);
    if (c) return structuredClone(c);
    const r = this.db.prepare("SELECT * FROM strategy_versions WHERE id = ?").get(id) as
      | { id: string; bot_id: string; hash: string; config: string; created_at: number }
      | undefined;
    if (!r) return null;
    const v = { ...r, config: BotConfigSchema.parse(JSON.parse(r.config)) };
    this.versionCache.set(id, v);
    return structuredClone(v);
  }
  listVersions(botId?: string): VersionRow[] {
    const rows = (
      botId
        ? this.db.prepare("SELECT * FROM strategy_versions WHERE bot_id = ? ORDER BY created_at").all(botId)
        : this.db.prepare("SELECT * FROM strategy_versions ORDER BY created_at").all()
    ) as { id: string; bot_id: string; hash: string; config: string; created_at: number }[];
    return rows.map((r) => ({ ...r, config: BotConfigSchema.parse(JSON.parse(r.config)) }));
  }

  // runs
  insertRun(r: RunRow): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, bot_id, mode, start_balance, cash, unlimited, peak_equity, day_key, day_start_equity,
         paused_until, pause_reason, consecutive_losses, started_at, ended_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.bot_id, r.mode, r.start_balance, r.cash, r.unlimited, r.peak_equity, r.day_key, r.day_start_equity,
        r.paused_until, r.pause_reason, r.consecutive_losses, r.started_at, r.ended_at, r.archived,
      );
  }
  getRun(id: string): RunRow | null {
    return (this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined) ?? null;
  }
  listRuns(botId?: string): RunRow[] {
    return (
      botId
        ? this.db.prepare("SELECT * FROM runs WHERE bot_id = ? ORDER BY started_at").all(botId)
        : this.db.prepare("SELECT * FROM runs ORDER BY started_at").all()
    ) as unknown as RunRow[];
  }
  updateRun(id: string, patch: Partial<Omit<RunRow, "id">>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sql = `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...(keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null)), id);
  }

  // cooldowns (persisted so restarts do not reset them)
  lastEntry(botId: string, symbol: string): number | null {
    const r = this.db.prepare("SELECT last_entry_at FROM cooldowns WHERE bot_id = ? AND symbol = ?").get(botId, symbol) as
      | { last_entry_at: number }
      | undefined;
    return r?.last_entry_at ?? null;
  }
  setLastEntry(botId: string, symbol: string, ts: number): void {
    this.db
      .prepare(
        "INSERT INTO cooldowns (bot_id, symbol, last_entry_at) VALUES (?, ?, ?) ON CONFLICT(bot_id, symbol) DO UPDATE SET last_entry_at = excluded.last_entry_at",
      )
      .run(botId, symbol, ts);
  }
  lastClose(botId: string, symbol: string): number | null {
    const r = this.db.prepare("SELECT last_close_at FROM cooldowns WHERE bot_id = ? AND symbol = ?").get(botId, symbol) as
      | { last_close_at: number | null }
      | undefined;
    return r?.last_close_at ?? null;
  }
  /** Latest close wins (grid variants close at different times). */
  setLastClose(botId: string, symbol: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO cooldowns (bot_id, symbol, last_entry_at, last_close_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bot_id, symbol) DO UPDATE SET last_close_at = MAX(COALESCE(last_close_at, 0), excluded.last_close_at)`,
      )
      .run(botId, symbol, ts, ts);
  }
  cooldownRows(botId: string): { symbol: string; last_entry_at: number; last_close_at: number | null }[] {
    return this.db.prepare("SELECT symbol, last_entry_at, last_close_at FROM cooldowns WHERE bot_id = ?").all(botId) as {
      symbol: string;
      last_entry_at: number;
      last_close_at: number | null;
    }[];
  }
}
