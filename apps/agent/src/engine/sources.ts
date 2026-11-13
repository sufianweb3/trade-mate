import type { BotConfig, ExchangeId } from "@oisniper/core";

/** Snapshot sources: "coinglass" (and demo CoinGlass feeds), "exchange" (aggregated OI), "exchange:<venue>". */
export type SourceKind = "coinglass" | "exchange";

export const sourceKind = (snapSource: string): SourceKind => (snapSource.startsWith("exchange") ? "exchange" : "coinglass");
export const otherKind = (k: SourceKind): SourceKind => (k === "coinglass" ? "exchange" : "coinglass");

const OI_VENUES: ExchangeId[] = ["binance", "bybit", "okx", "gate", "kucoin"];

/** Venue whose OI drives "venue only" scope: the bot's first exchange, Binance for ALL (or a venue without OI data). */
export function oiVenue(cfg: BotConfig): ExchangeId {
  const first = cfg.exchanges === "ALL" ? "binance" : cfg.exchanges[0]!;
  return OI_VENUES.includes(first) ? first : "binance";
}

/** The exact snapshot source name the bot trades on. */
export function tradeSource(cfg: BotConfig): string {
  if (cfg.dataSource.kind === "coinglass") return "coinglass";
  return cfg.dataSource.oiScope === "venue" ? `exchange:${oiVenue(cfg)}` : "exchange";
}

/**
 * "trade": the bot acts on this snapshot. "shadow": log what this source would have fired (comparison mode).
 * Shadow compares CoinGlass with aggregated exchange data; per-venue variants only feed venue-scope bots.
 */
export function sourceRole(cfg: BotConfig, snapSource: string): "trade" | "shadow" | null {
  const want = tradeSource(cfg);
  const kind = sourceKind(snapSource);
  if (want === "coinglass" ? kind === "coinglass" : snapSource === want) return "trade";
  if (kind === cfg.dataSource.kind) return null; // another exchange variant
  return kind === "coinglass" || snapSource === "exchange" ? "shadow" : null;
}
