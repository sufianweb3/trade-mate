import type { Decimal, ErrorCode, ExchangeId } from "@oisniper/core";

export interface PositionCtx {
  tradeId: string;
  botId: string;
  exchange: ExchangeId;
  symbol: string;
  leverage: number;
  entryPrice: Decimal;
  qty: Decimal;
  margin: Decimal;
  liqPrice: Decimal;
  triggerPrice: "mark" | "last";
  openedAt: number;
  /** Last funding timestamp already settled (persisted so restarts never double-charge). */
  lastFundingTs: number;
}

export interface IocRequest {
  clientOrderId: string;
  tradeId: string;
  exchange: ExchangeId;
  symbol: string;
  side: "buy" | "sell";
  qty: Decimal;
  /** Best price at decision time; IOC cap = ref +/- maxSlippagePct. */
  refPrice: Decimal;
  maxSlippagePct: number;
  reduceOnly: boolean;
  leverage: number;
}

export interface FillResult {
  status: "filled" | "partial" | "rejected";
  code: ErrorCode | null;
  message: string | null;
  clientOrderId: string;
  orderId: string | null;
  requestedQty: Decimal;
  filledQty: Decimal;
  avgPrice: Decimal | null;
  fee: Decimal;
  capPrice: Decimal;
  sentAt: number;
  /** When the venue acknowledged the order (live: API response; paper: send + simulated latency). */
  ackTs: number;
  ts: number;
  latencyMs: number;
  /** Shadow sim fill (Live) or own fill (Paper). */
  simFillPrice: Decimal | null;
  /** Exchange-reported fill (Live only). */
  realFillPrice: Decimal | null;
}

export type AdapterEvent =
  | { type: "stop_filled"; tradeId: string; fill: FillResult; triggerPrice: Decimal; ts: number }
  | { type: "tp_filled"; tradeId: string; fill: FillResult; ts: number }
  | { type: "liquidated"; tradeId: string; price: Decimal; qty: Decimal; ts: number }
  | { type: "funding"; tradeId: string; amount: Decimal; rate: Decimal; ts: number }
  | { type: "data_gap"; tradeId: string; from: number; to: number }
  | { type: "position_gone"; tradeId: string; ts: number };

export interface StopRequest {
  tradeId: string;
  exchange: ExchangeId;
  symbol: string;
  qty: Decimal;
  triggerPrice: Decimal;
  clientOrderId: string;
}

export interface TpRequest {
  tradeId: string;
  exchange: ExchangeId;
  symbol: string;
  qty: Decimal;
  price: Decimal;
  clientOrderId: string;
}

export interface ReconcileItem {
  exchange: ExchangeId;
  symbol: string;
  qty: string;
  tradeId: string | null;
  status: "matched" | "external" | "missing" | "stop_restored";
}

/**
 * The ONLY component that differs between Paper and Live.
 * Everything upstream (signals, gates, router, sizing, positions, logging) is shared.
 */
export interface ExecutionAdapter {
  readonly kind: "sim" | "live";
  /** Account identity for the cross-bot symbol lock. Each paper bot has its own virtual account. */
  accountId(ex: ExchangeId): string;
  /** Isolated margin, one-way mode, leverage. Cached per symbol + leverage: a prewarmed symbol costs nothing here. */
  prepare(ex: ExchangeId, symbol: string, leverage: number): Promise<void>;
  /** Near-trigger watchlist: prepare ahead of the signal. Errors are swallowed; prepare() re-checks at entry. */
  prewarm(ex: ExchangeId, symbol: string, leverage: number): Promise<void>;
  takerPct(ex: ExchangeId, symbol: string): Decimal;
  /** Free balance for sizing. null = unlimited (Bot 2 paper). */
  available(): Promise<Decimal | null>;
  /** Cash + locked margin (excludes unrealized). null when unknown. */
  walletBalance(): Promise<Decimal | null>;
  canTrade(ex: ExchangeId): boolean;
  placeIoc(req: IocRequest): Promise<FillResult>;
  registerPosition(ctx: PositionCtx): void;
  unregisterPosition(tradeId: string): void;
  placeStop(req: StopRequest): Promise<string>;
  /** Cancel-replace: the new stop is placed before the old one is cancelled. */
  replaceStop(oldOrderId: string, req: StopRequest): Promise<string>;
  placeTakeProfit(req: TpRequest): Promise<string>;
  cancel(tradeId: string, orderId: string): Promise<void>;
  onEvent(fn: (e: AdapterEvent) => void): () => void;
  /** Match agent positions with the venue. status "missing" = protective orders must be re-placed. */
  reconcile(open: PositionCtx[]): Promise<ReconcileItem[]>;
  /** After restart: resolve SL/TP/liquidation that happened while the agent was down. */
  catchUp(open: PositionCtx[], since: Record<string, number>): Promise<void>;
  close(): Promise<void>;
}
