import { D, type BotConfig } from "@oisniper/core";
import type { MarketHub } from "../market/types";
import type { RunRow, Store } from "../store/store";
import type { Clock } from "../util/clock";
import type { LiveAccounts } from "./liveAccounts";
import { LiveAdapter } from "./LiveAdapter";
import { SimAdapter } from "./SimAdapter";
import type { ExecutionAdapter } from "./types";

/** Live runs take their start balance from the adapter at start(); paper runs from the config. */
export function initialRunBalance(cfg: BotConfig): { start: string | null; unlimited: boolean } {
  if (cfg.mode === "live") return { start: null, unlimited: false };
  const unlimited = cfg.paperInitialFunds == null;
  return { start: unlimited ? "0" : cfg.paperInitialFunds!, unlimited };
}

/** The single mode switch in the codebase. */
export function makeAdapterFactory(d: { store: Store; hub: MarketHub; clock: Clock; accounts: LiveAccounts }) {
  return (botId: string, cfg: BotConfig, run: RunRow): ExecutionAdapter => {
    if (cfg.mode === "live") {
      return new LiveAdapter({
        botId, hub: d.hub, clock: d.clock, accounts: d.accounts, maxCapital: D(cfg.risk.maxCapital ?? "0"),
        takerOverridePct: cfg.execution.takerFeeOverridePct,
      });
    }
    const account = { cash: D(run.cash ?? run.start_balance ?? "0"), unlimited: run.unlimited === 1 };
    return new SimAdapter({
      botId, hub: d.hub, clock: d.clock, account, latencyOverrideMs: cfg.execution.latencyOverrideMs,
      takerOverridePct: cfg.execution.takerFeeOverridePct,
      onAccountChange: (a) => d.store.updateRun(run.id, { cash: a.cash.toString() }),
    });
  };
}
