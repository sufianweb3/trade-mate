import { D, Decimal, HUNDRED, type ErrorCode, type Risk } from "@oisniper/core";
import type { RunRow, Store } from "../store/store";

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const nextUtcDay = (ts: number) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export interface RiskCheck {
  ok: boolean;
  code: ErrorCode | null;
  detail?: string;
}

/** Per-bot limits (PRD 11). Never bypassed in any mode. */
export class RiskManager {
  constructor(
    private store: Store,
    private botId: string,
    private now: () => number,
  ) {}

  private run(runId: string): RunRow {
    const r = this.store.getRun(runId);
    if (!r) throw new Error(`run ${runId} missing`);
    return r;
  }

  /** Roll the daily window and track peak equity. Returns a stop/pause code when a limit trips. */
  updateEquity(runId: string, equity: Decimal, risk: Risk): ErrorCode | null {
    const r = this.run(runId);
    const now = this.now();
    const patch: Partial<RunRow> = {};
    const key = dayKey(now);
    if (r.day_key !== key) {
      patch.day_key = key;
      patch.day_start_equity = equity.toString();
      if (r.pause_reason === "DAILY_LOSS_PAUSE") {
        patch.paused_until = null;
        patch.pause_reason = null;
      }
    }
    const peak = r.peak_equity ? D(r.peak_equity) : equity;
    if (equity.gt(peak) || !r.peak_equity) patch.peak_equity = equity.toString();
    this.store.updateRun(runId, patch);
    const cur = { ...r, ...patch };
    // Bot 2 unlimited paper: equity is cumulative PnL from 0; percentage limits are off by preset.
    if (risk.maxDrawdownPct != null && cur.peak_equity) {
      const pk = D(cur.peak_equity);
      if (pk.gt(0) && pk.sub(equity).div(pk).mul(HUNDRED).gte(risk.maxDrawdownPct)) return "DRAWDOWN_STOP";
    }
    if (risk.maxDailyLossPct != null && cur.day_start_equity) {
      const ds = D(cur.day_start_equity);
      if (ds.gt(0) && ds.sub(equity).div(ds).mul(HUNDRED).gte(risk.maxDailyLossPct)) {
        if (cur.pause_reason !== "DAILY_LOSS_PAUSE")
          this.store.updateRun(runId, { paused_until: nextUtcDay(now), pause_reason: "DAILY_LOSS_PAUSE" });
        return "DAILY_LOSS_PAUSE";
      }
    }
    return null;
  }

  onTradeClosed(runId: string, netPnl: Decimal, risk: Risk): ErrorCode | null {
    const r = this.run(runId);
    const losses = netPnl.lte(0) ? r.consecutive_losses + 1 : 0;
    this.store.updateRun(runId, { consecutive_losses: losses });
    if (risk.consecutiveLossLimit != null && losses >= risk.consecutiveLossLimit) {
      this.store.updateRun(runId, {
        paused_until: this.now() + risk.consecutiveLossPauseMin * 60_000,
        pause_reason: "CONSECUTIVE_LOSS_PAUSE",
        consecutive_losses: 0,
      });
      return "CONSECUTIVE_LOSS_PAUSE";
    }
    return null;
  }

  /** Entry permission. Cheap, local, runs before the router and gates. */
  canEnter(runId: string, risk: Risk, openCount: number, killSwitch: boolean): RiskCheck {
    if (killSwitch) return { ok: false, code: "KILL_SWITCH" };
    const r = this.run(runId);
    const now = this.now();
    if (r.paused_until && now < r.paused_until) return { ok: false, code: (r.pause_reason as ErrorCode) ?? "BOT_STOPPED", detail: `until ${new Date(r.paused_until).toISOString()}` };
    if (r.paused_until && now >= r.paused_until) this.store.updateRun(runId, { paused_until: null, pause_reason: null });
    if (risk.maxOpenPositions != null && openCount >= risk.maxOpenPositions) return { ok: false, code: "MAX_OPEN_POSITIONS", detail: `${openCount}/${risk.maxOpenPositions}` };
    return { ok: true, code: null };
  }
}

/** Cross-bot symbol lock per exchange account (one-way mode = one position per symbol per account). */
export class SymbolLock {
  private locks = new Map<string, string>();
  key(account: string, symbol: string) {
    return `${account}|${symbol}`;
  }
  tryLock(account: string, symbol: string, owner: string): boolean {
    const k = this.key(account, symbol);
    const cur = this.locks.get(k);
    if (cur && cur !== owner) return false;
    this.locks.set(k, owner);
    return true;
  }
  release(account: string, symbol: string, owner: string): void {
    const k = this.key(account, symbol);
    if (this.locks.get(k) === owner) this.locks.delete(k);
  }
  holder(account: string, symbol: string): string | null {
    return this.locks.get(this.key(account, symbol)) ?? null;
  }
}
