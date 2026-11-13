import { computeKpis, D, equityCurve, type Kpis } from "@oisniper/core";
import type { App } from "../app";
import type { TradeRecord } from "../store/types";

const kp = (ts: TradeRecord[], start: string | null): Kpis =>
  computeKpis(
    ts.filter((t) => t.status === "closed").map((t) => ({
      netPnl: t.result.net_pnl ?? "0", fees: t.result.fees ?? "0", funding: t.result.funding,
      slippageUsd: t.execution.slippage_usd, exitTime: t.timing.exit_time ?? 0, simGapPct: t.execution.sim_gap_pct,
    })),
    start ? D(start) : null,
  );

function group(ts: TradeRecord[], key: (t: TradeRecord) => string) {
  const m = new Map<string, TradeRecord[]>();
  for (const t of ts) {
    const k = key(t);
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m.entries()].map(([k, list]) => {
    const k2 = kp(list, null);
    const roe = list.filter((t) => t.result.net_roe_pct != null);
    return {
      key: k, trades: k2.trades, winRatePct: k2.winRatePct, netPnl: k2.netPnl, profitFactor: k2.profitFactor,
      avgRoePct: roe.length ? roe.reduce((a, t) => a.add(t.result.net_roe_pct!), D(0)).div(roe.length).toFixed(2) : null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

const bucket = (v: number | null, edges: number[]) => {
  if (v == null) return "null";
  for (let i = 0; i < edges.length; i++) if (v < edges[i]!) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
  return `>=${edges[edges.length - 1]}`;
};

export function analytics(app: App, botId: string | undefined, runId: string | undefined) {
  const ts = app.store.records.listTrades({ botId, runId, status: "closed" });
  const hold = (t: TradeRecord) => bucket(t.timing.hold_seconds != null ? t.timing.hold_seconds / 60 : null, [5, 15, 60, 240]) + " min";
  const variants = new Map<string, TradeRecord[]>();
  for (const t of ts.filter((x) => x.bot_id === "test" || x.variant_id.includes("-T"))) {
    const k = t.variant_id;
    variants.set(k, [...(variants.get(k) ?? []), t]);
  }
  const matrix = [...variants.entries()].map(([id, list]) => {
    const k = kp(list, null);
    const [lev, tv] = id.split("-");
    const roe = list.reduce((a, t) => a.add(t.result.net_roe_pct ?? "0"), D(0));
    return { leverage: Number(lev!.replace("x", "")), variant: tv ?? "base", trades: k.trades, netPnl: k.netPnl, winRatePct: k.winRatePct, profitFactor: k.profitFactor, avgRoePct: list.length ? roe.div(list.length).toFixed(2) : null };
  });
  return {
    trades: ts.length,
    byExchange: group(ts, (t) => t.exchange),
    byLeverage: group(ts, (t) => `${t.config.leverage}x`),
    byHour: group(ts, (t) => String(new Date(t.timing.entry_fill_time).getUTCHours()).padStart(2, "0")),
    byOi5m: group(ts, (t) => bucket(t.signal.oi_chg_5m, [1, 2, 3, 5, 10]) + "%"),
    byHold: group(ts, hold),
    byExitReason: group(ts, (t) => t.exit.reason ?? "?"),
    variantMatrix: matrix,
  };
}

export async function overview(app: App, botId: string | "all", rangeFrom: number) {
  const bots = botId === "all" ? [...app.bots.bots.values()] : [app.bots.get(botId)];
  const out = [];
  for (const b of bots) {
    const run = b.run();
    const ts = app.store.records.listTrades({ botId: b.id, runId: run.id });
    const k = kp(ts, run.start_balance);
    const eq = await b.equity();
    const curve = app.store.records.equity(b.id, run.id, rangeFrom);
    const closedCurve = equityCurve(
      ts.filter((t) => t.status === "closed").map((t) => ({ netPnl: t.result.net_pnl ?? "0", fees: "0", funding: "0", slippageUsd: null, exitTime: t.timing.exit_time ?? 0 })),
      D(run.start_balance ?? "0"),
    ).filter((p) => p.t >= rangeFrom);
    const row = b.row();
    out.push({
      botId: b.id, name: row.name, mode: b.mode, status: row.status, statusReason: row.status_reason, runId: run.id,
      startBalance: run.start_balance, totalBalance: eq.equity?.toFixed(4) ?? null, wallet: eq.wallet?.toFixed(4) ?? null,
      unrealized: eq.unrealized.toFixed(4), unlimited: run.unlimited === 1, kpis: k,
      equityCurve: curve.length ? curve : closedCurve.map((p) => ({ ts: p.t, equity: p.equity })),
      open: b.pm.openTrades().map((t) => openRow(app, t)),
    });
  }
  return out;
}

export function openRow(app: App, t: TradeRecord) {
  const tk = app.o.hub.lastTick(t.exchange, t.exchange_symbol);
  const entry = D(t.execution.avg_entry_price);
  const roe = tk ? tk.mark.div(entry).sub(1).mul(t.config.leverage).mul(100) : null;
  return {
    tradeId: t.trade_id, botId: t.bot_id, symbol: t.symbol, exchange: t.exchange, exchangeSymbol: t.exchange_symbol,
    variantId: t.variant_id, leverage: t.config.leverage, entry: t.execution.avg_entry_price, mark: tk?.mark.toString() ?? null,
    qty: t.state.qty_open, roePct: roe?.toFixed(2) ?? null, slPrice: t.state.sl_price, slRoe: t.state.sl_roe,
    tp1Price: t.config.tp1_price, tp1Hit: t.path.tp1_hit, liqPrice: t.config.liq_price, openedAt: t.timing.entry_fill_time,
    unrealized: tk ? tk.mark.sub(entry).mul(t.state.qty_open).toFixed(4) : null, armed: t.state.armed,
  };
}
