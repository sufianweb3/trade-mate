import type { Book, Decimal, ExchangeId, MarginTier } from "@oisniper/core";

/** Market metadata normalized to base-asset units (contract conversion done in symbols/). */
export interface MarketInfo {
  exchange: ExchangeId;
  /** ccxt unified perp symbol, e.g. 1000PEPE/USDT:USDT */
  symbol: string;
  /** Base as listed on the exchange, e.g. 1000PEPE */
  base: string;
  active: boolean;
  /** Base units per contract (1 for Binance/Bybit). */
  contractSize: Decimal;
  qtyStep: Decimal;
  minQty: Decimal;
  minNotional: Decimal;
  tickSize: Decimal;
  /** 0 = unknown: the leverage gate rejects (never assume a higher limit than the real one). */
  maxLeverage: number;
  tiers: MarginTier[];
  /** Where maxLeverage and tiers came from. "cross_venue_min" = lowest public limit across other venues (unverified). */
  limitsSource: "market" | "exchange_public" | "exchange_private" | "cross_venue_min" | "unknown";
  leverageVerified: boolean;
  takerPct: Decimal;
  makerPct: Decimal;
  listedAt: number | null;
}

export interface Tick {
  exchange: ExchangeId;
  symbol: string;
  ts: number;
  mark: Decimal;
  last: Decimal;
  index: Decimal | null;
}

export interface FundingInfo {
  /** Fraction per interval (0.0001 = 0.01%). */
  rate: Decimal;
  nextTime: number;
  intervalMs: number | null;
}

export interface ExchangeHealth {
  exchange: ExchangeId;
  status: "ok" | "degraded" | "down" | "maintenance" | "disabled";
  wsConnected: boolean;
  rttMs: number | null;
  clockOffsetMs: number | null;
  lastMessageTs: number | null;
  subscriptions: number;
  error: string | null;
}

export interface PricePoint {
  ts: number;
  price: Decimal;
}

export interface MarketHub {
  readonly exchanges: ExchangeId[];
  start(): Promise<void>;
  stop(): Promise<void>;
  markets(ex: ExchangeId): MarketInfo[];
  market(ex: ExchangeId, symbol: string): MarketInfo | null;
  /** On-demand L2 subscription. Reason-counted so positions keep books alive. */
  subscribe(ex: ExchangeId, symbol: string, reason: string): Promise<void>;
  unsubscribe(ex: ExchangeId, symbol: string, reason: string): void;
  book(ex: ExchangeId, symbol: string): Book | null;
  /** Book snapshot at or just after ts from the 10s ring buffer. */
  bookAt(ex: ExchangeId, symbol: string, ts: number): Book | null;
  lastTick(ex: ExchangeId, symbol: string): Tick | null;
  funding(ex: ExchangeId, symbol: string): FundingInfo | null;
  volume24h(ex: ExchangeId, symbol: string): Decimal | null;
  range1mPct(ex: ExchangeId, symbol: string): Decimal | null;
  rttMs(ex: ExchangeId): number;
  /** Live order send -> ack latency (EWMA). Paper uses it so simulated fills see the same delay as real orders. */
  recordOrderLatency(ex: ExchangeId, ms: number): void;
  orderLatencyMs(ex: ExchangeId): number | null;
  health(): ExchangeHealth[];
  /** REST price for follow-up jobs on symbols that are not subscribed. */
  fetchPrice(ex: ExchangeId, symbol: string): Promise<Decimal | null>;
  /** Trades in a window, used to replay data gaps and downtime. */
  tradesBetween(ex: ExchangeId, symbol: string, from: number, to: number): Promise<PricePoint[]>;
  /** Load real leverage limits and maintenance tiers for a symbol (cached 15 min). Never raises a limit. */
  resolveLimits(ex: ExchangeId, symbol: string): Promise<void>;
  onTick(fn: (t: Tick) => void): () => void;
  onGap(fn: (ex: ExchangeId, symbol: string, from: number, to: number) => void): () => void;
}
