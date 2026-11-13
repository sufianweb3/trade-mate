import type { App } from "../app";
import { sourceKind } from "../engine/sources";

export interface StageStat {
  stage: string;
  n: number;
  p50: number | null;
  p95: number | null;
  target: string | null;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

const stat = (stage: string, xs: number[], target: string | null = null): StageStat => {
  const v = xs.filter((x) => Number.isFinite(x) && x >= 0);
  return { stage, n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), target };
};

/** p50 / p95 per latency stage, from the last 500 non-shadow signals and trades per mode (paper latency is simulated). */
export function latencyStats(app: App) {
  const out: Record<string, StageStat[]> = {};
  for (const mode of ["paper", "live"] as const) {
    const trades = app.store.records.listTrades({ mode, limit: 500 }).filter((t) => t.timing.detected_ts);
    // Extracted in SQLite: parsing 2000 full signals (~50 KB each with per-variant gates) stalled the agent for seconds.
    const sigs = app.store.records.signalLatencies(mode, 500).filter((s) => s.detected_ts != null);
    const src = (k: "coinglass" | "exchange") =>
      sigs.filter((s) => s.data_source && s.source_data_ts != null && sourceKind(s.data_source) === k).map((s) => s.detected_ts! - s.source_data_ts!);
    out[mode] = [
      stat("source → detected (Exchange)", src("exchange"), "< 1000 ms"),
      stat("source → detected (CoinGlass)", src("coinglass"), "< 2000 ms"),
      stat("detected → gates done", sigs.filter((s) => s.gates_done_ts).map((s) => s.gates_done_ts! - s.detected_ts!)),
      stat("gates done → order sent", trades.filter((t) => t.timing.gates_done_ts).map((t) => t.timing.order_sent_time - t.timing.gates_done_ts!)),
      stat("detected → order sent", trades.map((t) => t.timing.order_sent_time - t.timing.detected_ts), "p95 < 300 ms"),
      stat("order sent → ack", trades.map((t) => t.timing.order_ack_ts - t.timing.order_sent_time)),
      stat("ack → fill", trades.map((t) => t.timing.entry_fill_time - t.timing.order_ack_ts)),
      stat("fill → SL placed", trades.filter((t) => t.timing.sl_placed_ts).map((t) => t.timing.sl_placed_ts! - t.timing.entry_fill_time), "< 500 ms"),
      stat("source → fill (total)", trades.map((t) => t.timing.entry_fill_time - t.timing.source_data_ts)),
    ];
  }
  return out;
}
