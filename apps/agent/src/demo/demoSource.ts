import type { MetricKey, MetricRow } from "@oisniper/core";
import type { RawTable } from "../scraper/parser";
import type { SnapshotSource, SourceResult } from "../scraper/source";

/** CoinGlass-style header text per metric (the parser maps these back by text, never by position). */
const HEADERS: [string, MetricKey | "symbol"][] = [
  ["Coin", "symbol"],
  ["Price", "price"],
  ["Price (5m%)", "price_chg_5m"],
  ["Price (15m%)", "price_chg_15m"],
  ["Price (1h%)", "price_chg_1h"],
  ["Price (4h%)", "price_chg_4h"],
  ["Price (24h%)", "price_chg_24h"],
  ["Open Interest", "oi_value"],
  ["OI (5m%)", "oi_chg_5m"],
  ["OI (15m%)", "oi_chg_15m"],
  ["OI (30m%)", "oi_chg_30m"],
  ["OI Change (1h)", "oi_chg_1h"],
  ["OI (4h%)", "oi_chg_4h"],
  ["OI (24h%)", "oi_chg_24h"],
  ["Volume (5m)", "vol_5m"],
  ["Volume (1h)", "vol_1h"],
  ["Volume (4h)", "vol_4h"],
  ["Volume (24h)", "vol_24h"],
  ["Vol Chg (5m)", "vol_chg_5m"],
  ["Vol Chg (1h)", "vol_chg_1h"],
  ["Vol Chg (4h)", "vol_chg_4h"],
  ["Vol Chg (24h)", "vol_chg_24h"],
  ["Funding Rate", "funding_rate"],
  ["Long/Short", "ls_ratio"],
];

const USD = new Set<string>(["oi_value", "vol_5m", "vol_1h", "vol_4h", "vol_24h"]);

function fmtUsd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/** Scripted CoinGlass feed. Rendered as text cells exactly like the real table, then parsed by the real parser. */
export class DemoSource implements SnapshotSource {
  /** "demo-coinglass" by default; "exchange" makes it stand in for the exchange data engine in tests. */
  constructor(readonly name = "demo-coinglass") {}
  rows = new Map<string, Partial<MetricRow>>();
  dropColumns = new Set<string>();
  reverseColumns = false;
  challenge = false;

  set(symbol: string, m: Partial<MetricRow>): void {
    this.rows.set(symbol, { ...(this.rows.get(symbol) ?? {}), ...m });
  }
  /** Reset a symbol to quiet metrics (no rule matches). */
  quiet(symbol: string, price: number): void {
    this.rows.set(symbol, {
      price, price_chg_5m: -0.05, price_chg_15m: 0.1, price_chg_1h: -0.2, price_chg_4h: 0.4, price_chg_24h: 1.1,
      oi_value: 4.2e8, oi_chg_5m: 0.1, oi_chg_15m: -0.2, oi_chg_30m: 0.3, oi_chg_1h: -0.4, oi_chg_4h: -0.6, oi_chg_24h: 2.1, // 2 of 5 OI positive: below the Test grid's 3
      vol_5m: 2.1e6, vol_1h: 2.4e7, vol_4h: 9.1e7, vol_24h: 6.2e8, vol_chg_5m: -3, vol_chg_1h: 5, vol_chg_4h: -2, vol_chg_24h: 8,
      funding_rate: 0.01, ls_ratio: 1.02,
    });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setVisible(): Promise<void> {}

  table(): RawTable {
    let cols = HEADERS.filter(([, k]) => !this.dropColumns.has(k));
    if (this.reverseColumns) cols = [cols[0]!, ...cols.slice(1).reverse()];
    const rows: string[][] = [];
    for (const [sym, m] of this.rows) {
      rows.push(
        cols.map(([, k]) => {
          if (k === "symbol") return `${sym}`;
          const v = m[k];
          if (v == null) return "--";
          if (USD.has(k)) return fmtUsd(v);
          if (k === "price") return `$${v}`;
          if (k === "ls_ratio") return v.toFixed(2);
          return `${v >= 0 ? "+" : ""}${v.toFixed(k === "funding_rate" ? 4 : 2)}%`;
        }),
      );
    }
    return { headers: cols.map(([h]) => h), rows };
  }

  async read(): Promise<SourceResult> {
    if (this.challenge) return { table: { headers: [], rows: [] }, challenge: true };
    return { table: this.table(), challenge: false };
  }
}
