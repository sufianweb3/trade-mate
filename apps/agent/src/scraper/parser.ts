import {
  emptyRow, METRIC_KEYS, MetricRowSchema, REQUIRED_METRICS, type MetricKey, type MetricRow, type SnapshotHealth,
} from "@oisniper/core";
import { parse as parseHtml } from "node-html-parser";
import { z } from "zod";

export const RawTableSchema = z.object({
  headers: z.array(z.string()).max(80),
  rows: z.array(z.array(z.string())).max(2000),
});
export type RawTable = z.infer<typeof RawTableSchema>;

type Col = MetricKey | "symbol";

const norm = (h: string) => h.toLowerCase().replace(/[\s_\-./()[\]%$:]+/g, "").replace(/change|chg/g, "chg");

const TF = "(5m|15m|30m|1h|4h|12h|24h)";

/**
 * Header text -> metric. Never by column position. Unknown headers are ignored.
 * Examples handled: "OI Change (5m)", "OI 5m %", "Open Interest", "Volume(24h)", "Vol Chg 1H", "Price 24h%".
 */
export function classifyHeader(raw: string): Col | null {
  const h = norm(raw);
  // "%" marks a change column: CoinGlass shows both "Volume (24h)" ($) and "Volume (24h%)" (change).
  const isPct = raw.includes("%");
  if (/^(symbol|coin|coins|pair|name|ticker|asset|assets)$/.test(h)) return "symbol";
  if (/^(price|lastprice|last)$/.test(h)) return "price";
  if (/^(funding|fundingrate|fr)$/.test(h)) return "funding_rate";
  if (/^(longshort|longshortratio|lsratio|ls|longshortratio24h)$/.test(h)) return "ls_ratio";
  let m = h.match(new RegExp(`^(oi|openinterest)(?:chg)?${TF}$`));
  if (m) return keyFor("oi_chg", m[2]!);
  m = h.match(new RegExp(`^(oi|openinterest)${TF}chg$`));
  if (m) return keyFor("oi_chg", m[2]!);
  if (/^(oi|openinterest)(value|usd)?$/.test(h)) return "oi_value";
  m = h.match(new RegExp(`^(vol|volume)chg${TF}$`)) ?? h.match(new RegExp(`^(vol|volume)${TF}chg$`));
  if (m) return keyFor("vol_chg", m[2]!);
  m = h.match(new RegExp(`^(vol|volume)(usd)?${TF}$`));
  if (m) return keyFor(isPct ? "vol_chg" : "vol", m[3]!);
  if (/^(vol|volume)(usd)?$/.test(h)) return "vol_24h";
  m = h.match(new RegExp(`^(price)(?:chg)?${TF}$`)) ?? h.match(new RegExp(`^(price)${TF}chg$`));
  if (m) return keyFor("price_chg", m[2]!);
  return null;
}

function keyFor(prefix: string, tf: string): MetricKey | null {
  const k = `${prefix}_${tf}`;
  return (METRIC_KEYS as readonly string[]).includes(k) ? (k as MetricKey) : null;
}

const UNITS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** "$1.23B" -> 1.23e9, "-0.34%" -> -0.34, "--" -> null. Never 0 for missing. */
export function parseValue(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/[,\s$]/g, "").replace(/[−–]/g, "-").replace(/^\+/, "");
  if (!s || /^(-|--|—|n\/?a|null)$/i.test(s)) return null;
  const m = s.match(/^(-?\d*\.?\d+(?:e[-+]?\d+)?)(%|[kmbt])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = m[2]?.toLowerCase();
  return u && u !== "%" ? n * UNITS[u]! : n;
}

export function cleanSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase().split(/\s+/)[0]!.replace(/(USDT|USD|PERP|\/.*)$/g, "");
  return /^[A-Z0-9]{1,20}$/.test(s) ? s : null;
}

export interface ParseResult {
  rows: MetricRow[];
  health: SnapshotHealth;
  mapping: Record<string, Col | null>;
}

/** "At least minPass of these metrics" (a strategy rule group): members may be missing while enough remain. */
export interface RequiredGroup {
  metrics: MetricKey[];
  minPass: number;
}

/**
 * required: metrics whose column must exist and carry data (enabled ungrouped rule metrics + price); default PRD list.
 * groups: rule groups; a group is only short when fewer than minPass of its metrics have data.
 */
export function parseTable(
  table: RawTable, prevRowCount: number | null, startedAt = Date.now(), required: MetricKey[] = REQUIRED_METRICS, groups: RequiredGroup[] = [],
): ParseResult {
  const t = RawTableSchema.parse(table);
  const mapping: Record<string, Col | null> = {};
  const colIndex = new Map<Col, number>();
  t.headers.forEach((h, i) => {
    const c = classifyHeader(h);
    mapping[h] = c;
    if (c && !colIndex.has(c)) colIndex.set(c, i);
  });
  const rows: MetricRow[] = [];
  const symIdx = colIndex.get("symbol");
  if (symIdx != null) {
    for (const cells of t.rows) {
      const sym = cleanSymbol(cells[symIdx] ?? "");
      if (!sym) continue;
      const r = emptyRow(sym);
      for (const k of METRIC_KEYS) {
        const i = colIndex.get(k);
        r[k] = i == null ? null : parseValue(cells[i]);
      }
      const ok = MetricRowSchema.safeParse(r);
      if (ok.success) rows.push(r);
    }
  }
  const h = healthFor(rows, prevRowCount, startedAt, required.filter((k) => !colIndex.has(k)), required, groups);
  if (symIdx == null) h.missingColumns.unshift("symbol" as MetricKey);
  if (h.missingColumns.length) h.status = "DEGRADED";
  return { rows, mapping, health: h };
}

/**
 * Snapshot health: fill rate per metric; DEGRADED when a required metric has no column or no data at all,
 * rows dropped by more than 50%, or nothing parsed. Clears to OK as soon as every required metric has data.
 * A rule group only degrades when fewer than its minPass metrics have data (its absent metrics are then listed).
 */
export function healthFor(
  rows: MetricRow[], prevRowCount: number | null, startedAt: number, missingCols: MetricKey[] = [], required: MetricKey[] = REQUIRED_METRICS,
  groups: RequiredGroup[] = [],
): SnapshotHealth {
  const fillRates: Record<string, number> = {};
  for (const k of METRIC_KEYS) fillRates[k] = rows.length ? rows.filter((r) => r[k] != null).length / rows.length : 0;
  const short = groups.flatMap((g) => {
    const absent = g.metrics.filter((k) => !(fillRates[k]! > 0));
    return rows.length > 0 && g.metrics.length - absent.length < g.minPass ? absent : [];
  });
  const missing = [...new Set([...missingCols, ...required.filter((k) => rows.length > 0 && fillRates[k] === 0), ...short])];
  const dropped = prevRowCount != null && prevRowCount > 0 && rows.length < prevRowCount * 0.5;
  return {
    parseMs: Date.now() - startedAt,
    rowCount: rows.length,
    fillRates,
    missingColumns: missing,
    status: missing.length || dropped || rows.length === 0 ? "DEGRADED" : "OK",
  };
}

/** Extract the largest table from saved HTML (fixtures, and the Playwright DOM dump). */
export function tableFromHtml(html: string): RawTable {
  const root = parseHtml(html);
  let best: RawTable = { headers: [], rows: [] };
  for (const tbl of root.querySelectorAll("table")) {
    const headers = tbl.querySelectorAll("thead th").map((th) => th.text.trim());
    const hdr = headers.length ? headers : (tbl.querySelector("tr")?.querySelectorAll("th,td").map((c) => c.text.trim()) ?? []);
    const bodyRows = tbl.querySelectorAll("tbody tr").map((tr) => tr.querySelectorAll("td").map((td) => td.text.trim()));
    if (bodyRows.length > best.rows.length) best = { headers: hdr, rows: bodyRows };
  }
  return best;
}
