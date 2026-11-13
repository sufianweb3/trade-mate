import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";

// Loaded at runtime: bundlers (esbuild) do not know node:sqlite yet and strip its "node:" prefix.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncT;

/**
 * SQLite via Node's built-in node:sqlite (no native build step on Node 22.5+).
 * Migrations are append-only; never edit a shipped one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE bots (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL,
    current_version_id TEXT NOT NULL, current_run_id TEXT,
    running INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'stopped', status_reason TEXT,
    layout TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE strategy_versions (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, hash TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_sv_bot ON strategy_versions(bot_id);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, mode TEXT NOT NULL,
    start_balance TEXT, cash TEXT, unlimited INTEGER NOT NULL DEFAULT 0,
    peak_equity TEXT, day_key TEXT, day_start_equity TEXT,
    paused_until INTEGER, pause_reason TEXT, consecutive_losses INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, ended_at INTEGER, archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_runs_bot ON runs(bot_id);
  CREATE TABLE signals (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, run_id TEXT NOT NULL, version_id TEXT NOT NULL, mode TEXT NOT NULL,
    symbol TEXT NOT NULL, ts INTEGER NOT NULL, snapshot_id TEXT, status TEXT NOT NULL,
    reject_reasons TEXT NOT NULL DEFAULT '[]', exchange TEXT, rematch_count INTEGER NOT NULL DEFAULT 0,
    last_match_ts INTEGER NOT NULL, data TEXT NOT NULL,
    cf_status TEXT, cf_data TEXT
  );
  CREATE INDEX ix_signals_bot_ts ON signals(bot_id, ts);
  CREATE INDEX ix_signals_sym ON signals(bot_id, symbol, ts);
  CREATE TABLE trades (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, run_id TEXT NOT NULL, signal_id TEXT NOT NULL, version_id TEXT NOT NULL,
    variant_id TEXT NOT NULL, mode TEXT NOT NULL, exchange TEXT NOT NULL, symbol TEXT NOT NULL, leverage INTEGER NOT NULL,
    status TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, exit_reason TEXT, net_pnl TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX ix_trades_bot ON trades(bot_id, run_id, status);
  CREATE INDEX ix_trades_sym ON trades(bot_id, symbol, status);
  CREATE TABLE trade_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX ix_te_trade ON trade_events(trade_id);
  CREATE TABLE cooldowns (bot_id TEXT NOT NULL, symbol TEXT NOT NULL, last_entry_at INTEGER NOT NULL, PRIMARY KEY (bot_id, symbol));
  CREATE TABLE snapshots (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, row_count INTEGER NOT NULL, health TEXT NOT NULL, rows TEXT NOT NULL);
  CREATE INDEX ix_snap_ts ON snapshots(ts);
  CREATE TABLE api_keys (
    exchange TEXT PRIMARY KEY, enc TEXT NOT NULL, masked TEXT NOT NULL, permissions TEXT NOT NULL,
    status TEXT NOT NULL, testnet INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, run_id TEXT NOT NULL, ts INTEGER NOT NULL, equity TEXT NOT NULL);
  CREATE INDEX ix_eq ON equity(bot_id, run_id, ts);
  CREATE TABLE errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, code TEXT, message TEXT NOT NULL);
  CREATE TABLE symbol_overrides (coinglass TEXT NOT NULL, exchange TEXT NOT NULL, unified TEXT NOT NULL, PRIMARY KEY (coinglass, exchange));
  `,
  // 2: cooldown also runs 12h from the last close
  `ALTER TABLE cooldowns ADD COLUMN last_close_at INTEGER;`,
  // 3: follow-up job reads pending counterfactuals every 30s; avoid scanning every signal row
  `CREATE INDEX ix_signals_cf_pending ON signals(cf_status) WHERE cf_status = 'pending';`,
  // 4: source comparison and latency stats read index-only, never the ~50 KB signal JSON (columns added after `data`
  // sit behind its overflow pages, so only a covering index keeps these reads cheap)
  `ALTER TABLE signals ADD COLUMN data_source TEXT;
   ALTER TABLE signals ADD COLUMN lat_source_ts INTEGER;
   ALTER TABLE signals ADD COLUMN lat_detected_ts INTEGER;
   ALTER TABLE signals ADD COLUMN lat_gates_ts INTEGER;
   UPDATE signals SET data_source = json_extract(data, '$.data_source'),
     lat_source_ts = json_extract(data, '$.latency.source_data_ts'), lat_detected_ts = json_extract(data, '$.latency.detected_ts'),
     lat_gates_ts = json_extract(data, '$.latency.gates_done_ts')
   WHERE json_valid(data);
   CREATE INDEX ix_signals_summary ON signals(bot_id, ts, id, symbol, status, data_source, cf_data);
   CREATE INDEX ix_signals_latency ON signals(mode, ts, status, data_source, lat_source_ts, lat_detected_ts, lat_gates_ts);`,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(n) AS n FROM _migrations").get() as { n: number | null } | undefined;
  const done = row?.n ?? 0;
  if (done > 0 && done < MIGRATIONS.length) console.log("  Updating the database (one time after an update, can take a minute)...");
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO _migrations (n, at) VALUES (?, ?)").run(i + 1, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const MIGRATION_SQL = MIGRATIONS;
