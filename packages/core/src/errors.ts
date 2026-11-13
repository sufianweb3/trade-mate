/** Internal reason / error codes. Exchange errors are mapped to these once, in LiveAdapter. */
export const ERROR_CODES = [
  // signal / risk
  "COOLDOWN",
  "OPEN_POSITION",
  "MAX_OPEN_POSITIONS",
  "DAILY_LOSS_PAUSE",
  "DRAWDOWN_STOP",
  "CONSECUTIVE_LOSS_PAUSE",
  "KILL_SWITCH",
  "BOT_STOPPED",
  "SYMBOL_LOCKED",
  "SYMBOL_BLACKLISTED",
  "SYMBOL_UNMAPPED",
  "SYMBOL_NOT_TRADING",
  "CAPITAL_CAP",
  "SCRAPER_DEGRADED",
  "SCRAPER_STALE",
  "NO_VENUE",
  "CLOCK_DRIFT",
  // gates
  "BOOK_STALE",
  "GATE_SPREAD",
  "GATE_ENTRY_DEPTH",
  "GATE_EXIT_DEPTH",
  "GATE_ENTRY_SLIPPAGE",
  "GATE_COST_TO_TARGET",
  "GATE_CHASE",
  "GATE_VOLATILITY",
  "GATE_VOLUME_24H",
  "GATE_FUNDING",
  "LEVERAGE_UNAVAILABLE",
  "TIER_SIZE_EXCEEDED",
  "LIQ_BUFFER",
  "MIN_NOTIONAL",
  "LOT_SIZE",
  // execution
  "INSUFFICIENT_MARGIN",
  "PRICE_FILTER",
  "REDUCE_ONLY_REJECTED",
  "RATE_LIMIT",
  "MAINTENANCE",
  "ORDER_NOT_FILLED",
  "EXCHANGE_ERROR",
  "EXCHANGE_TRADE_DISABLED",
  "SL_PLACEMENT_FAILED",
  "AUTH_FAILED",
  "WITHDRAW_PERMISSION",
  "INVALID_CONFIG",
  "NOT_FOUND",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }
}

export const isCoreError = (e: unknown): e is CoreError => e instanceof CoreError;
