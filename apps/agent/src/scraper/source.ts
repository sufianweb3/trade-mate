import type { MetricRow } from "@oisniper/core";
import type { ConnectStatus } from "./coinglassConnect";
import type { RawTable } from "./parser";

export interface SourceResult {
  table: RawTable;
  /** Set when a Cloudflare / bot challenge is on screen. */
  challenge: boolean;
  /** Sources that compute metrics themselves (exchange data) return rows instead of a table. */
  rows?: MetricRow[];
  /** Extra row sets published as their own snapshots, e.g. "exchange:binance" for venue-only OI scope. */
  variants?: Record<string, MetricRow[]>;
  /** When the underlying data was produced (latency: source_data_ts). */
  dataTs?: number;
  /** Shown on Health (e.g. "kucoin warming up"). */
  note?: string;
  /** Session state for login-capable sources. */
  loggedIn?: boolean | null;
  /** Nothing read this time (e.g. the user is logging in): keep the last snapshot and status, show `note`. */
  skip?: boolean;
}

/** Where metric snapshots come from: CoinGlass (Playwright), exchange APIs, or a scripted feed in demos. */
export interface SnapshotSource {
  readonly name: string;
  start(): Promise<void>;
  read(): Promise<SourceResult>;
  stop(): Promise<void>;
  /** Login-capable sources: one-click connect (opens a window, waits for the login, closes it). */
  connect?(): ConnectStatus;
  cancelConnect?(): void;
  connectStatus?(): ConnectStatus;
  /** Optional push: call cb whenever new data is ready so the service reads immediately (no fixed wait). */
  onChange?(cb: () => void): void;
}
