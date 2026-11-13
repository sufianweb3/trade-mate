import type { MetricsSnapshot } from "@oisniper/core";
import type { Db } from "./db";
import type { SignalRecord, TradeRecord } from "./types";

export interface TradeFilter {
  botId?: string;
  runId?: string;
  status?: "open" | "closed";
  exchange?: string;
  symbol?: string;
  leverage?: number;
  variantId?: string;
  mode?: string;
  result?: "win" | "loss";
  from?: number;
  to?: number;
  limit?: number;
}

export interface SignalFilter {
  botId?: string;
  runId?: string;
  status?: string;
  reason?: string;
  from?: number;
  to?: number;
  limit?: number;
}

type Param = string | number | null;

export type SignalSummary = Pick<SignalRecord, "signal_id" | "symbol" | "ts" | "status" | "counterfactual"> & { data_source: string | null };

export class Records {
  constructor(private db: Db) {}

  // signals
  insertSignal(s: SignalRecord): void {
    this.db
      .prepare(
        `INSERT INTO signals (id, bot_id, run_id, version_id, mode, symbol, ts, snapshot_id, status, reject_reasons, exchange,
         rematch_count, last_match_ts, data, cf_status, cf_data, data_source, lat_source_ts, lat_detected_ts, lat_gates_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.signal_id, s.bot_id, s.run_id, s.strategy_version_id, s.mode, s.symbol, s.ts, s.snapshot_id, s.status,
        JSON.stringify(s.reject_reasons), s.exchange, s.rematch_count, s.ts, JSON.stringify(s),
        "pending", null, // every signal gets a counterfactual: CoinGlass vs Exchange is compared on the same basis
        s.data_source ?? null, s.latency?.source_data_ts ?? null, s.latency?.detected_ts ?? null, s.latency?.gates_done_ts ?? null,
      );
  }
  updateSignal(s: SignalRecord): void {
    this.db
      .prepare(
        `UPDATE signals SET status = ?, reject_reasons = ?, exchange = ?, rematch_count = ?, data = ?, cf_status = COALESCE(cf_status, ?),
         lat_gates_ts = ? WHERE id = ?`,
      )
      .run(
        s.status, JSON.stringify(s.reject_reasons), s.exchange, s.rematch_count, JSON.stringify(s),
        "pending", s.latency?.gates_done_ts ?? null, s.signal_id,
      );
  }
  bumpRematch(id: string, ts: number): void {
    const s = this.getSignal(id);
    if (!s) return;
    s.rematch_count++;
    this.db.prepare("UPDATE signals SET rematch_count = ?, last_match_ts = ?, data = ? WHERE id = ?").run(s.rematch_count, ts, JSON.stringify(s), id);
  }
  getSignal(id: string): SignalRecord | null {
    const r = this.db.prepare("SELECT data FROM signals WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as SignalRecord) : null;
  }
  lastSignalFor(botId: string, symbol: string): { id: string; ts: number; last_match_ts: number } | null {
    return (
      (this.db
        .prepare("SELECT id, ts, last_match_ts FROM signals WHERE bot_id = ? AND symbol = ? ORDER BY ts DESC LIMIT 1")
        .get(botId, symbol) as { id: string; ts: number; last_match_ts: number } | undefined) ?? null
    );
  }
  private signalWhere(f: SignalFilter): { where: string; p: Param[] } {
    const w: string[] = [];
    const p: Param[] = [];
    const add = (clause: string, v: Param) => { w.push(clause); p.push(v); };
    if (f.botId) add("bot_id = ?", f.botId);
    if (f.runId) add("run_id = ?", f.runId);
    if (f.status) add("status = ?", f.status);
    if (f.reason) add("reject_reasons LIKE ?", `%"${f.reason.replace(/[%_"]/g, "")}%`);
    if (f.from != null) add("ts >= ?", f.from);
    if (f.to != null) add("ts <= ?", f.to);
    return { where: w.length ? `WHERE ${w.join(" AND ")}` : "", p };
  }
  private static toSignal(r: { data: string; cf_data: string | null }): SignalRecord {
    const s = JSON.parse(r.data) as SignalRecord;
    if (r.cf_data) s.counterfactual = JSON.parse(r.cf_data) as SignalRecord["counterfactual"];
    return s;
  }
  listSignals(f: SignalFilter = {}): SignalRecord[] {
    const { where, p } = this.signalWhere(f);
    const rows = this.db.prepare(`SELECT data, cf_data FROM signals ${where} ORDER BY ts DESC LIMIT ?`).all(...p, f.limit ?? 500) as { data: string; cf_data: string | null }[];
    return rows.map(Records.toSignal);
  }
  /**
   * List view for the panel: per-variant gate results, router candidates and skipped variants are dropped in SQLite
   * (a Test bot signal is ~50 KB with them). The full record comes from getSignalFull.
   */
  listSignalsSlim(f: SignalFilter = {}): SignalRecord[] {
    const { where, p } = this.signalWhere(f);
    const sql = `SELECT json_remove(data, '$.gate_results', '$.router', '$.skipped_variants') AS data, cf_data FROM signals ${where} ORDER BY ts DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...p, f.limit ?? 500) as { data: string; cf_data: string | null }[]).map((r) => {
      const s = Records.toSignal(r);
      return { ...s, gate_results: [], router: [], skipped_variants: [] };
    });
  }
  getSignalFull(id: string): SignalRecord | null {
    const r = this.db.prepare("SELECT data, cf_data FROM signals WHERE id = ?").get(id) as { data: string; cf_data: string | null } | undefined;
    return r ? Records.toSignal(r) : null;
  }
  /** Streams full signals oldest-first without holding every row in memory (exports). */
  *iterateSignals(f: SignalFilter = {}): Generator<SignalRecord> {
    const { where, p } = this.signalWhere(f);
    for (const r of this.db.prepare(`SELECT data, cf_data FROM signals ${where} ORDER BY ts`).iterate(...p) as Iterable<{ data: string; cf_data: string | null }>)
      yield Records.toSignal(r);
  }
  /** Source comparison: counts and counterfactuals only (index-only: ix_signals_summary), no signal JSON. */
  signalSummaries(botId: string): SignalSummary[] {
    const rows = this.db
      .prepare("SELECT id, symbol, ts, status, data_source, cf_data FROM signals WHERE bot_id = ? ORDER BY ts")
      .all(botId) as { id: string; symbol: string; ts: number; status: string; data_source: string | null; cf_data: string | null }[];
    return rows.map((r) => ({
      signal_id: r.id, symbol: r.symbol, ts: r.ts, status: r.status as SignalRecord["status"], data_source: r.data_source,
      counterfactual: r.cf_data ? (JSON.parse(r.cf_data) as SignalRecord["counterfactual"]) : null,
    }));
  }
  /** Latency stages of the most recent non-shadow signals of one mode (index-only: ix_signals_latency). */
  signalLatencies(mode: string, limit: number): { data_source: string | null; source_data_ts: number | null; detected_ts: number | null; gates_done_ts: number | null }[] {
    return this.db
      .prepare(
        `SELECT data_source, lat_source_ts AS source_data_ts, lat_detected_ts AS detected_ts, lat_gates_ts AS gates_done_ts
         FROM signals WHERE mode = ? AND status != 'shadow' ORDER BY ts DESC LIMIT ?`,
      )
      .all(mode, limit) as { data_source: string | null; source_data_ts: number | null; detected_ts: number | null; gates_done_ts: number | null }[];
  }
  /** Without the full signal JSON (large); fetch it with signalData only when a row needs it. */
  pendingCounterfactuals(): { id: string; ts: number; cf_data: string | null }[] {
    return this.db.prepare("SELECT id, ts, cf_data FROM signals WHERE cf_status = 'pending'").all() as {
      id: string;
      ts: number;
      cf_data: string | null;
    }[];
  }
  signalData(id: string): string | null {
    const r = this.db.prepare("SELECT data FROM signals WHERE id = ?").get(id) as { data: string } | undefined;
    return r?.data ?? null;
  }
  setCounterfactual(id: string, cf: unknown, done: boolean): void {
    this.db.prepare("UPDATE signals SET cf_data = ?, cf_status = ? WHERE id = ?").run(JSON.stringify(cf), done ? "done" : "pending", id);
  }

  // trades
  upsertTrade(t: TradeRecord): void {
    this.db
      .prepare(
        `INSERT INTO trades (id, bot_id, run_id, signal_id, version_id, variant_id, mode, exchange, symbol, leverage, status,
          opened_at, closed_at, exit_reason, net_pnl, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at,
          exit_reason = excluded.exit_reason, net_pnl = excluded.net_pnl, data = excluded.data`,
      )
      .run(
        t.trade_id, t.bot_id, t.run_id, t.signal_id, t.strategy_version_id, t.variant_id, t.mode, t.exchange, t.symbol,
        t.config.leverage, t.status, t.timing.entry_fill_time, t.timing.exit_time, t.exit.reason, t.result.net_pnl,
        JSON.stringify(t),
      );
  }
  getTrade(id: string): TradeRecord | null {
    const r = this.db.prepare("SELECT data FROM trades WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as TradeRecord) : null;
  }
  listTrades(f: TradeFilter = {}): TradeRecord[] {
    const w: string[] = [];
    const p: Param[] = [];
    const add = (clause: string, v: Param) => { w.push(clause); p.push(v); };
    if (f.botId) add("bot_id = ?", f.botId);
    if (f.runId) add("run_id = ?", f.runId);
    if (f.status) add("status = ?", f.status);
    if (f.exchange) add("exchange = ?", f.exchange);
    if (f.symbol) add("symbol = ?", f.symbol.toUpperCase());
    if (f.leverage) add("leverage = ?", f.leverage);
    if (f.variantId) add("variant_id = ?", f.variantId);
    if (f.mode) add("mode = ?", f.mode);
    if (f.result === "win") w.push("CAST(net_pnl AS REAL) > 0");
    if (f.result === "loss") w.push("CAST(net_pnl AS REAL) <= 0");
    if (f.from != null) add("opened_at >= ?", f.from);
    if (f.to != null) add("opened_at <= ?", f.to);
    const sql = `SELECT data FROM trades ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY opened_at DESC LIMIT ?`;
    p.push(f.limit ?? 100000);
    return (this.db.prepare(sql).all(...p) as { data: string }[]).map((r) => JSON.parse(r.data) as TradeRecord);
  }
  countOpen(botId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM trades WHERE bot_id = ? AND status = 'open'").get(botId) as { n: number };
    return r.n;
  }
  hasOpenOnSymbol(botId: string, symbol: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM trades WHERE bot_id = ? AND symbol = ? AND status = 'open' LIMIT 1").get(botId, symbol);
  }

  addEvent(tradeId: string, ts: number, type: string, data: unknown): void {
    this.db.prepare("INSERT INTO trade_events (trade_id, ts, type, data) VALUES (?, ?, ?, ?)").run(tradeId, ts, type, JSON.stringify(data));
  }
  events(tradeId: string): { ts: number; type: string; data: unknown }[] {
    return (this.db.prepare("SELECT ts, type, data FROM trade_events WHERE trade_id = ? ORDER BY id").all(tradeId) as {
      ts: number;
      type: string;
      data: string;
    }[]).map((e) => ({ ts: e.ts, type: e.type, data: JSON.parse(e.data) as unknown }));
  }

  // snapshots (7 day rolling)
  insertSnapshot(s: MetricsSnapshot, keepMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO snapshots (id, ts, source, row_count, health, rows) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.id, s.ts, s.source, s.rows.length, JSON.stringify(s.health), JSON.stringify(s.rows));
    this.db.prepare("DELETE FROM snapshots WHERE ts < ?").run(s.ts - keepMs);
  }
  latestSnapshots(n: number): { id: string; ts: number; row_count: number; health: unknown }[] {
    return (this.db.prepare("SELECT id, ts, row_count, health FROM snapshots ORDER BY ts DESC LIMIT ?").all(n) as {
      id: string;
      ts: number;
      row_count: number;
      health: string;
    }[]).map((r) => ({ ...r, health: JSON.parse(r.health) as unknown }));
  }

  // equity curve
  addEquity(botId: string, runId: string, ts: number, equity: string): void {
    this.db.prepare("INSERT INTO equity (bot_id, run_id, ts, equity) VALUES (?, ?, ?, ?)").run(botId, runId, ts, equity);
  }
  equity(botId: string, runId: string, from = 0): { ts: number; equity: string }[] {
    return this.db
      .prepare("SELECT ts, equity FROM equity WHERE bot_id = ? AND run_id = ? AND ts >= ? ORDER BY ts")
      .all(botId, runId, from) as { ts: number; equity: string }[];
  }

  // error log
  addError(ts: number, source: string, code: string | null, message: string): void {
    this.db.prepare("INSERT INTO errors (ts, source, code, message) VALUES (?, ?, ?, ?)").run(ts, source, code, message);
    this.db.prepare("DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 1000)").run();
  }
  errors(limit = 100): { ts: number; source: string; code: string | null; message: string }[] {
    return this.db.prepare("SELECT ts, source, code, message FROM errors ORDER BY id DESC LIMIT ?").all(limit) as {
      ts: number;
      source: string;
      code: string | null;
      message: string;
    }[];
  }

  // api keys (encrypted blob only)
  upsertKey(k: { exchange: string; enc: string; masked: string; permissions: unknown; status: string; testnet: boolean; created_at: number }): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (exchange, enc, masked, permissions, status, testnet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(exchange) DO UPDATE SET enc = excluded.enc, masked = excluded.masked, permissions = excluded.permissions,
         status = excluded.status, testnet = excluded.testnet, created_at = excluded.created_at`,
      )
      .run(k.exchange, k.enc, k.masked, JSON.stringify(k.permissions), k.status, k.testnet ? 1 : 0, k.created_at);
  }
  listKeys(): { exchange: string; enc: string; masked: string; permissions: unknown; status: string; testnet: boolean }[] {
    return (this.db.prepare("SELECT exchange, enc, masked, permissions, status, testnet FROM api_keys").all() as {
      exchange: string;
      enc: string;
      masked: string;
      permissions: string;
      status: string;
      testnet: number;
    }[]).map((r) => ({ ...r, permissions: JSON.parse(r.permissions) as unknown, testnet: r.testnet === 1 }));
  }
  deleteKey(exchange: string): void {
    this.db.prepare("DELETE FROM api_keys WHERE exchange = ?").run(exchange);
  }

  symbolOverrides(): { coinglass: string; exchange: string; unified: string }[] {
    return this.db.prepare("SELECT coinglass, exchange, unified FROM symbol_overrides").all() as {
      coinglass: string;
      exchange: string;
      unified: string;
    }[];
  }
  setSymbolOverride(coinglass: string, exchange: string, unified: string | null): void {
    if (unified == null) this.db.prepare("DELETE FROM symbol_overrides WHERE coinglass = ? AND exchange = ?").run(coinglass, exchange);
    else
      this.db
        .prepare("INSERT OR REPLACE INTO symbol_overrides (coinglass, exchange, unified) VALUES (?, ?, ?)")
        .run(coinglass.toUpperCase(), exchange, unified);
  }
}
