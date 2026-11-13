import { z } from "zod";

export const OI_TF = ["5m", "15m", "30m", "1h", "4h", "24h"] as const;
export const VOL_TF = ["5m", "1h", "4h", "24h"] as const;
export const PRICE_TF = ["5m", "15m", "1h", "4h", "24h"] as const;

/** Every metric collected for every symbol on every scrape. Missing = null, never 0. */
export const METRIC_KEYS = [
  "oi_value",
  ...OI_TF.map((t) => `oi_chg_${t}` as const),
  ...VOL_TF.map((t) => `vol_${t}` as const),
  ...VOL_TF.map((t) => `vol_chg_${t}` as const),
  "price",
  ...PRICE_TF.map((t) => `price_chg_${t}` as const),
  "funding_rate",
  "ls_ratio",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/** Metrics a rule may be built on (percentage changes). */
export const RULE_METRICS = [
  "oi_chg_5m",
  "oi_chg_15m",
  "oi_chg_30m",
  "oi_chg_1h",
  "oi_chg_4h",
  "oi_chg_24h",
  "vol_chg_5m",
  "vol_chg_1h",
  "vol_chg_4h",
  "vol_chg_24h",
  "price_chg_5m",
  "price_chg_15m",
  "price_chg_1h",
  "price_chg_4h",
  "price_chg_24h",
] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

/** Columns whose absence marks the scraper DEGRADED. */
export const REQUIRED_METRICS: MetricKey[] = ["price", "oi_value", "oi_chg_5m", "oi_chg_1h"];

const nnum = z.number().finite().nullable();

export const MetricRowSchema = z.object({
  symbol: z.string().min(1).max(30),
  ...Object.fromEntries(METRIC_KEYS.map((k) => [k, nnum])),
}) as unknown as z.ZodType<MetricRow>;

export type MetricRow = { symbol: string } & Record<MetricKey, number | null>;

export const ScraperStatus = z.enum(["OK", "DEGRADED", "CHALLENGE", "STALE", "STOPPED", "STARTING"]);
export type ScraperStatus = z.infer<typeof ScraperStatus>;

export const SnapshotHealthSchema = z.object({
  parseMs: z.number(),
  rowCount: z.number().int(),
  fillRates: z.record(z.string(), z.number()),
  missingColumns: z.array(z.string()),
  status: ScraperStatus,
});
export type SnapshotHealth = z.infer<typeof SnapshotHealthSchema>;

export interface MetricsSnapshot {
  id: string;
  ts: number;
  /** When the source produced the data (CoinGlass table change / exchange response). Latency: source_data_ts. */
  dataTs?: number;
  /** "coinglass" (or a demo feed), "exchange" (aggregated OI) or "exchange:<venue>" (venue-only OI). */
  source: string;
  rows: MetricRow[];
  health: SnapshotHealth;
}

export const emptyRow = (symbol: string): MetricRow => {
  const r = { symbol } as MetricRow;
  for (const k of METRIC_KEYS) r[k] = null;
  return r;
};
