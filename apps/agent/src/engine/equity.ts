import { ZERO, type BotConfig, type Decimal } from "@oisniper/core";
import type { Bus } from "../bus";
import type { ExecutionAdapter } from "../execution/types";
import type { MarketHub } from "../market/types";
import type { PositionManager } from "../positions/positionManager";
import type { RiskManager } from "../risk/riskManager";
import type { RunRow, Store } from "../store/store";
import type { BotStatus } from "./botInstance";

export interface Equity {
  wallet: Decimal | null;
  unrealized: Decimal;
  equity: Decimal | null;
}

/** Equity = wallet (cash + locked margin) + unrealized on mark. */
export async function computeEquity(adapter: ExecutionAdapter, pm: PositionManager, hub: MarketHub): Promise<Equity> {
  const wallet = await adapter.walletBalance();
  let un = ZERO;
  for (const t of pm.openTrades()) {
    const tk = hub.lastTick(t.exchange, t.exchange_symbol);
    if (tk) un = un.add(tk.mark.sub(t.execution.avg_entry_price).mul(t.state.qty_open));
  }
  return { wallet, unrealized: un, equity: wallet ? wallet.add(un) : null };
}

/** Record equity and apply drawdown halt / daily-loss pause / resume after the pause window. */
export function applyEquity(o: {
  botId: string; e: Equity; run: RunRow; cfg: BotConfig; status: BotStatus; now: number; store: Store; risk: RiskManager; bus: Bus;
  setStatus: (s: BotStatus, reason?: string | null) => void; currentRun: () => RunRow;
}): void {
  if (!o.e.equity) return;
  o.store.records.addEquity(o.botId, o.run.id, o.now, o.e.equity.toFixed(8));
  const code = o.risk.updateEquity(o.run.id, o.e.equity, o.cfg.risk);
  if (code === "DRAWDOWN_STOP" && o.status !== "halted") {
    o.setStatus("halted", code);
    o.bus.emit("alert", { level: "error", kind: code, message: `${o.cfg.name} stopped: max drawdown`, botId: o.botId, ts: o.now });
  } else if (code === "DAILY_LOSS_PAUSE" && o.status === "running") {
    o.setStatus("paused", code);
  } else if (!code && o.status === "paused") {
    const r = o.currentRun();
    if (!r.paused_until || o.now >= r.paused_until) o.setStatus("running");
  }
}
