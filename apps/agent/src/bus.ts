import { EventEmitter } from "node:events";
import type { MetricsSnapshot, ScraperStatus } from "@oisniper/core";

export interface Alert {
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  botId?: string;
  tradeId?: string;
  ts: number;
}

export interface BusEvents {
  snapshot: [MetricsSnapshot];
  "scraper:status": [{ status: ScraperStatus; reason?: string; ts: number }];
  signal: [{ botId: string; signalId: string; symbol: string; status: string }];
  "trade:opened": [{ botId: string; tradeId: string }];
  "trade:updated": [{ botId: string; tradeId: string }];
  "trade:closed": [{ botId: string; tradeId: string; reason: string; netPnl: string }];
  "bot:status": [{ botId: string; status: string; reason?: string }];
  alert: [Alert];
}

/** Typed in-memory bus. One process, no queues. */
export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(100);
  }
  on<K extends keyof BusEvents>(k: K, fn: (...a: BusEvents[K]) => void): () => void {
    this.ee.on(k, fn as (...a: unknown[]) => void);
    return () => this.ee.off(k, fn as (...a: unknown[]) => void);
  }
  emit<K extends keyof BusEvents>(k: K, ...a: BusEvents[K]): void {
    this.ee.emit(k, ...a);
  }
}
