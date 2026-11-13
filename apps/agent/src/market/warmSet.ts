import type { ExchangeId, MetricsSnapshot } from "@oisniper/core";
import type { SymbolMapper } from "../symbols/mapper";
import type { MarketHub } from "./types";

/** Keep books warm for the top-N symbols by CoinGlass OI change (5m) to hit the latency target. */
export class WarmSet {
  private current = new Set<string>();
  constructor(private hub: MarketHub, private mapper: SymbolMapper, private size: () => number) {}

  async update(s: MetricsSnapshot): Promise<void> {
    const n = this.size();
    const top = [...s.rows]
      .filter((r) => r.oi_chg_5m != null)
      .sort((a, b) => (b.oi_chg_5m ?? 0) - (a.oi_chg_5m ?? 0))
      .slice(0, n);
    const next = new Set<string>();
    for (const r of top)
      for (const ex of this.hub.exchanges as ExchangeId[]) {
        const m = this.mapper.resolve(r.symbol, ex, null, null);
        if (m.ok) next.add(`${ex}|${m.mapping.symbol}`);
      }
    for (const k of this.current)
      if (!next.has(k)) {
        const [ex, sym] = k.split("|") as [ExchangeId, string];
        this.hub.unsubscribe(ex, sym, "warm");
      }
    for (const k of next)
      if (!this.current.has(k)) {
        const [ex, sym] = k.split("|") as [ExchangeId, string];
        await this.hub.subscribe(ex, sym, "warm").catch(() => undefined);
      }
    this.current = next;
  }
}
