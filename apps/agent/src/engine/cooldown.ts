/**
 * Cooldown rule (per bot, per CoinGlass base symbol, across all exchanges):
 * after_close: block if (open position on symbol) OR (now < last_entry + H) OR (now < last_close + H).
 * while_open (paper research grid): block only if now < last_entry + H; open positions and closes do not block.
 * The symbol is the CoinGlass base, so 1000PEPE on Binance and PEPE on OKX are the same symbol.
 * A Bot 2 grid signal records one entry for all its variants.
 */
export type CooldownCause = "open_position" | "entry" | "close";

export interface CooldownInput {
  hasOpen: boolean;
  lastEntry: number | null;
  lastClose: number | null;
  now: number;
  hours: number;
  reentry?: "after_close" | "while_open";
}

export interface CooldownState {
  blocked: boolean;
  cause: CooldownCause | null;
  /** When time-based blocking ends. null while a position is open (ends H after it closes). */
  until: number | null;
}

export function cooldownState(i: CooldownInput): CooldownState {
  const h = i.hours * 3_600_000;
  const whileOpen = i.reentry === "while_open";
  if (i.hasOpen && !whileOpen) return { blocked: true, cause: "open_position", until: null };
  const byEntry = i.lastEntry != null ? i.lastEntry + h : null;
  const byClose = i.lastClose != null && !whileOpen ? i.lastClose + h : null;
  const until = Math.max(byEntry ?? 0, byClose ?? 0);
  if (until > i.now) return { blocked: true, cause: byClose != null && byClose >= (byEntry ?? 0) ? "close" : "entry", until };
  return { blocked: false, cause: null, until: null };
}
