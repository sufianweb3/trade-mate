"use client";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Card, Empty, ErrorBox, Input, Loading, ModeBadge, Segmented, Signed, StatusBadge, Table, Td } from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { api } from "@/lib/agent";
import { useRunParam, ViewSelect } from "@/components/bot-controls";
import { useView } from "@/lib/view";
import { dur, pct, price, time, usd } from "@/lib/format";
import type { TradeRec } from "@/lib/types";

function Detail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["trade", id], queryFn: () => api<{ trade: TradeRec; events: { ts: number; type: string; data: unknown }[] }>(`/api/trades/${id}`) });
  if (!q.data) return <Loading />;
  const t = q.data.trade;
  return (
    <div className="grid gap-4 text-xs md:grid-cols-3">
      <div className="space-y-0.5 tabular">
        <div className="mb-1 font-semibold">Execution</div>
        <div>Entry {price(t.execution.avg_entry_price)} · fill {Number(t.execution.fill_pct).toFixed(1)}% · slip {pct(t.execution.slippage_pct, 4)}</div>
        <div>Latency {t.execution.latency_ms}ms · signal→fill {t.timing.signal_to_fill_ms}ms</div>
        <div>Margin {usd(t.config.margin)} · notional {usd(t.config.notional)} · {t.config.leverage}x{t.config.fitted ? ` (adaptive: config ${t.config.requested_leverage}x, size ${t.config.size_pct}%)` : ""}</div>
        <div>SL {price(t.config.sl_price)} · TP1 {price(t.config.tp1_price)} · liq {price(t.config.liq_price)}</div>
        <div>MFE {pct(t.path.mfe_pct, 3)} · MAE {pct(t.path.mae_pct, 3)} · peak ROE {pct(t.path.peak_roe, 1)}</div>
        <div>After exit: +15m {pct(t.after_exit.chg_15m, 3)} · +1h {pct(t.after_exit.chg_1h, 3)} · +4h {pct(t.after_exit.chg_4h, 3)}</div>
        <div>Fees {usd(t.result.fees)} · funding {usd(t.result.funding, true)} · R {t.result.r_multiple ?? "—"}</div>
      </div>
      <div>
        <div className="mb-1 font-semibold">Exit legs</div>
        {t.exit.legs.map((l, i) => <div key={i} className="tabular">{l.reason} {Number(l.qty)} @ {price(l.price)} fee {usd(l.fee)} slip {pct(l.slippage_pct, 4)}</div>)}
      </div>
      <div className="max-h-56 overflow-y-auto">
        <div className="mb-1 font-semibold">Timeline</div>
        {q.data.events.map((e, i) => <div key={i} className="tabular"><span className="text-muted">{time(e.ts)}</span> {e.type} <span className="text-muted">{JSON.stringify(e.data).slice(0, 80)}</span></div>)}
      </div>
    </div>
  );
}

export default function History() {
  const bot = useView((s) => s.view);
  const [f, setF] = useState({ status: "all", symbol: "", exchange: "", leverage: "", result: "all" });
  const [open, setOpen] = useState<string | null>(null);
  const run = useRunParam();
  const qs = new URLSearchParams({ limit: "500", bot, ...(run && { run }) });
  if (f.status !== "all") qs.set("status", f.status);
  if (f.result !== "all") qs.set("result", f.result);
  if (f.symbol) qs.set("symbol", f.symbol);
  if (f.exchange) qs.set("exchange", f.exchange);
  if (f.leverage) qs.set("leverage", f.leverage);
  const q = useQuery({ queryKey: ["trades", qs.toString()], queryFn: () => api<TradeRec[]>(`/api/trades?${qs}`) });
  return (
    <Card title="Trade history" action={<ExportButton bot={bot} run={run} label="Export AI Analysis Pack" />}>
      <div className="mb-4 flex flex-wrap gap-2">
        <ViewSelect runScope />
        <Segmented value={f.status} onChange={(v) => setF({ ...f, status: v })} options={["all", "open", "closed"].map((v) => ({ value: v, label: v }))} />
        <Segmented value={f.result} onChange={(v) => setF({ ...f, result: v })} options={["all", "win", "loss"].map((v) => ({ value: v, label: v }))} />
        <Input className="!w-28" placeholder="symbol" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} />
        <Input className="!w-28" placeholder="exchange" value={f.exchange} onChange={(e) => setF({ ...f, exchange: e.target.value.toLowerCase() })} />
        <Input className="!w-24" placeholder="leverage" value={f.leverage} onChange={(e) => setF({ ...f, leverage: e.target.value })} />
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <Empty>No trades match.</Empty> : (
        <Table head={["Opened", "Bot", "Symbol", "Venue", "Variant", "Mode", "Status", "Exit", "Entry", "Net PnL", "ROE", "Hold"]}>
          {q.data.map((t) => (
            <Fragment key={t.trade_id}>
              <tr className="cursor-pointer hover:bg-elevated" onClick={() => setOpen(open === t.trade_id ? null : t.trade_id)}>
                <Td>{time(t.timing.entry_fill_time)}</Td><Td>{t.bot_id}</Td><Td className="font-medium">{t.symbol}</Td><Td>{t.exchange}</Td><Td>{t.variant_id}{t.config.fitted ? <span className="text-muted"> → {t.config.leverage}x</span> : null}</Td>
                <Td><ModeBadge mode={t.mode} /></Td><Td><StatusBadge s={t.status} /></Td><Td>{t.exit.reason ?? "—"}</Td><Td>{price(t.execution.avg_entry_price)}</Td>
                <Td><Signed v={t.result.net_pnl} fmt={(v) => usd(v, true)} /></Td><Td><Signed v={t.result.net_roe_pct} fmt={(v) => pct(v, 1)} /></Td><Td>{dur(t.timing.hold_seconds)}</Td>
              </tr>
              {open === t.trade_id && <tr><td colSpan={12} className="bg-elevated p-4"><Detail id={t.trade_id} /></td></tr>}
            </Fragment>
          ))}
        </Table>
      )}
    </Card>
  );
}
