import { computeKpis, D, emptyRow, type BotConfig } from "@oisniper/core";
import { strToU8, zip } from "fflate";
import { redact } from "../log";
import type { SignalFilter, TradeFilter } from "../store/records";
import type { Store } from "../store/store";
import type { SignalRecord, TradeRecord } from "../store/types";
import { dictionaryMarkdown, SIGNAL_DICTIONARY, TRADE_DICTIONARY } from "./dictionary";
import { ANALYSIS_PROMPT } from "./prompt";

type Flat = Record<string, string | number | boolean | null>;

/** Nested -> dot notation. Arrays become JSON cells. */
export function flatten(o: unknown, prefix = "", out: Flat = {}): Flat {
  if (o === null || o === undefined) {
    if (prefix) out[prefix] = null;
    return out;
  }
  if (Array.isArray(o)) {
    out[prefix] = JSON.stringify(o);
    return out;
  }
  if (typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = o as string | number | boolean;
  return out;
}

const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvLine = (r: Flat, columns: string[]) => columns.map((c) => cell(r[c])).join(",");

export function toCsv(rows: Flat[], columns: string[]): string {
  return [columns.join(","), ...rows.map((r) => csvLine(r, columns))].join("\n") + "\n";
}

export const tradeExportRow = (t: TradeRecord): Flat => {
  const { state: _s, ...rest } = t; // internal management state is not exported
  return flatten({ ...rest, signal_alt: rest.signal_alt ?? emptyRow(t.symbol) });
};
export const signalExportRow = (s: SignalRecord): Flat => flatten({ ...s, metrics_alt: s.metrics_alt ?? emptyRow(s.symbol) });

export interface ExportFilter {
  botId?: string;
  runId?: string;
  mode?: string;
  exchange?: string;
  from?: number;
  to?: number;
}

export interface ExportResult {
  fileName: string;
  bytes: Uint8Array;
  files: string[];
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

const zipAsync = (files: Record<string, Uint8Array>) =>
  new Promise<Uint8Array>((res, rej) => zip(files, { level: 6 }, (err, out) => (err ? rej(err) : res(out))));

/**
 * One-click "AI Analysis Pack" (PRD 15.3). Contains no keys, balances beyond PnL math, or account ids.
 * Signals are streamed and the loop is yielded every 100 rows; compression runs off the main thread,
 * so a large export never stalls position management.
 */
export async function buildExport(store: Store, f: ExportFilter, now: number): Promise<ExportResult> {
  const tf: TradeFilter = { botId: f.botId, runId: f.runId, mode: f.mode, exchange: f.exchange, from: f.from, to: f.to };
  const sf: SignalFilter = { botId: f.botId, runId: f.runId, from: f.from, to: f.to };
  const trades = store.records.listTrades(tf);
  const sigCols = SIGNAL_DICTIONARY.map((d) => d.field);
  const csvRows: string[] = [sigCols.join(",")];
  const jsonRows: string[] = [];
  const versionIds = new Set(trades.map((t) => t.strategy_version_id));
  let signalsTotal = 0;
  let signalsRejected = 0;
  for (const s of store.records.iterateSignals(sf)) {
    if ((f.mode && s.mode !== f.mode) || (f.exchange && s.exchange !== f.exchange)) continue;
    signalsTotal++;
    if (s.status === "rejected") signalsRejected++;
    versionIds.add(s.strategy_version_id);
    csvRows.push(csvLine(signalExportRow(s), sigCols));
    jsonRows.push(JSON.stringify(s));
    if (signalsTotal % 100 === 0) await yieldLoop();
  }
  const versions = store.listVersions().filter((v) => versionIds.has(v.id)).map((v) => ({ id: v.id, bot_id: v.bot_id, hash: v.hash, created_at: v.created_at, config: v.config as BotConfig }));

  const tradeCols = TRADE_DICTIONARY.map((d) => d.field);
  const closed = trades.filter((t) => t.status === "closed");
  const runs = f.runId ? [store.getRun(f.runId)].filter(Boolean) : store.listRuns(f.botId);
  const start = runs.length === 1 && runs[0]!.start_balance ? D(runs[0]!.start_balance) : null;
  const kpis = computeKpis(
    closed.map((t) => ({ netPnl: t.result.net_pnl ?? "0", fees: t.result.fees ?? "0", funding: t.result.funding, slippageUsd: t.execution.slippage_usd, exitTime: t.timing.exit_time ?? 0, simGapPct: t.execution.sim_gap_pct })),
    start,
  );
  const summary = {
    generated_at: now,
    filters: f,
    trades_total: trades.length,
    trades_open: trades.length - closed.length,
    signals_total: signalsTotal,
    signals_rejected: signalsRejected,
    kpis,
    exit_reasons: closed.reduce<Record<string, number>>((a, t) => ((a[t.exit.reason ?? "?"] = (a[t.exit.reason ?? "?"] ?? 0) + 1), a), {}),
  };
  const jsonl = trades.map((t) => JSON.stringify({ ...t, state: undefined, events: store.records.events(t.trade_id) })).join("\n");
  const files: Record<string, Uint8Array> = {
    "trades.csv": strToU8(toCsv(trades.map(tradeExportRow), tradeCols)),
    "trades.jsonl": strToU8(jsonl + (jsonl ? "\n" : "")),
    "signals.csv": strToU8(csvRows.join("\n") + "\n"),
    // Full signal records: every variant's gate results, router candidates, rules and counterfactual.
    "signals.jsonl": strToU8(jsonRows.join("\n") + (jsonRows.length ? "\n" : "")),
    "strategy_versions.json": strToU8(JSON.stringify(redact(versions), null, 2)),
    "summary.json": strToU8(JSON.stringify(summary, null, 2)),
    "DATA_DICTIONARY.md": strToU8(dictionaryMarkdown()),
    "ANALYSIS_PROMPT.md": strToU8(ANALYSIS_PROMPT),
  };
  const date = new Date(now).toISOString().slice(0, 10);
  return {
    fileName: `oisniper-export-${f.botId ?? "all"}-${f.runId ?? "all"}-${date}.zip`,
    bytes: await zipAsync(files),
    files: Object.keys(files),
  };
}
