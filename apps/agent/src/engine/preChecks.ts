import { checkFilters, type BotConfig, type MetricRow, type ScraperStatus } from "@oisniper/core";
import type { RiskManager } from "../risk/riskManager";
import type { Store } from "../store/store";
import type { SignalRecord } from "../store/types";
import { cooldownState } from "./cooldown";

/**
 * Checks before any market data is touched, in order: filters, cooldown (open position / 12h since entry or close),
 * risk limits and kill switch, signal source health. Null = pass.
 */
export function preChecks(o: {
  botId: string; cfg: BotConfig; m: MetricRow; status: ScraperStatus; now: number; store: Store; risk: RiskManager;
  runId: string; openCount: number; killed: boolean;
}): { codes: string[]; cooldown?: NonNullable<SignalRecord["cooldown"]> } | null {
  const filt = checkFilters(o.m, o.cfg.filters, null);
  if (filt.length) return { codes: filt };
  const cd = cooldownState({
    hasOpen: o.store.records.hasOpenOnSymbol(o.botId, o.m.symbol),
    lastEntry: o.store.lastEntry(o.botId, o.m.symbol),
    lastClose: o.store.lastClose(o.botId, o.m.symbol),
    now: o.now,
    hours: o.cfg.cooldownHours,
    reentry: o.cfg.reentry,
  });
  if (cd.blocked) return { codes: cd.cause === "open_position" ? ["COOLDOWN", "OPEN_POSITION"] : ["COOLDOWN"], cooldown: { cause: cd.cause!, until: cd.until } };
  const rc = o.risk.canEnter(o.runId, o.cfg.risk, o.openCount, o.killed);
  if (!rc.ok) return { codes: [rc.code!] };
  if (o.status !== "OK") return { codes: [o.status === "STALE" ? "SCRAPER_STALE" : "SCRAPER_DEGRADED"] };
  return null;
}
