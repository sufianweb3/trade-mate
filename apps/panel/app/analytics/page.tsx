"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, Empty, ErrorBox, Loading, Segmented, Signed, Table, Td, cx } from "@/components/ui";
import { api } from "@/lib/agent";
import { useRunParam, ViewSelect } from "@/components/bot-controls";
import { SourceCompare } from "@/components/source-compare";
import { useView } from "@/lib/view";
import { n, pct, usd } from "@/lib/format";
import type { AnalyticsResp, Breakdown } from "@/lib/types";

const pf = (v: string | null) => (v == null ? "—" : v === "Infinity" ? "∞" : Number(v).toFixed(2));

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <Empty>No closed trades.</Empty> : (
        <Table head={["", "Trades", "Win rate", "Net PnL", "PF", "Avg ROE"]}>
          {rows.map((r) => (
            <tr key={r.key}><Td className="font-medium">{r.key}</Td><Td>{r.trades}</Td><Td>{r.winRatePct ? `${r.winRatePct}%` : "—"}</Td>
              <Td><Signed v={r.netPnl} fmt={(v) => usd(v, true)} /></Td><Td>{pf(r.profitFactor)}</Td><Td><Signed v={r.avgRoePct} fmt={(v) => pct(v, 1)} /></Td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export default function Analytics() {
  const bot = useView((s) => s.view);
  const [metric, setMetric] = useState<"netPnl" | "winRatePct" | "profitFactor" | "avgRoePct">("netPnl");
  const run = useRunParam();
  const q = useQuery({ queryKey: ["analytics", bot, run], queryFn: () => api<AnalyticsResp>(`/api/analytics?bot=${bot}${run ? `&run=${run}` : ""}`), refetchInterval: 30_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const a = q.data!;
  const levs = [...new Set(a.variantMatrix.map((c) => c.leverage))].sort((x, y) => x - y);
  const vars = [...new Set(a.variantMatrix.map((c) => c.variant))].sort();
  const cell = (l: number, v: string) => a.variantMatrix.find((c) => c.leverage === l && c.variant === v);
  const fmt = (v: string | null) => (metric === "netPnl" ? usd(v, true) : metric === "winRatePct" ? (v ? `${v}%` : "—") : metric === "avgRoePct" ? pct(v, 1) : pf(v));
  return (
    <div className="space-y-4">
      <ViewSelect runScope />
      <SourceCompare bot={bot} />
      {bot === "test" && <Card title="Variant matrix (leverage x trail)" action={<Segmented value={metric} onChange={setMetric} options={[{ value: "netPnl", label: "Net PnL" }, { value: "winRatePct", label: "Win rate" }, { value: "profitFactor", label: "PF" }, { value: "avgRoePct", label: "Avg ROE" }]} />}>
        {a.variantMatrix.length === 0 ? <Empty>The matrix fills as Bot 2 grid trades close.</Empty> : (
          <Table head={["Leverage", ...vars]}>
            {levs.map((l) => (
              <tr key={l}><Td className="font-medium">{l}x</Td>
                {vars.map((v) => {
                  const c = cell(l, v);
                  const val = c ? (c[metric] as string | null) : null;
                  const x = metric === "winRatePct" ? (n(val) ?? 50) - 50 : metric === "profitFactor" ? (n(val) ?? 1) - 1 : n(val);
                  return <Td key={v} className={cx("text-center", x != null && x > 0 ? "bg-pos/10 text-pos" : x != null && x < 0 ? "bg-neg/10 text-neg" : "text-muted")}>{c ? <><div>{fmt(val)}</div><div className="text-[10px] text-muted">{c.trades} trades</div></> : "—"}</Td>;
                })}
              </tr>
            ))}
          </Table>
        )}
      </Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable title="By exchange" rows={a.byExchange} />
        <BreakdownTable title="By leverage" rows={a.byLeverage} />
        <BreakdownTable title="By exit reason" rows={a.byExitReason} />
        <BreakdownTable title="By OI 5m bucket" rows={a.byOi5m} />
        <BreakdownTable title="By holding time" rows={a.byHold} />
        <BreakdownTable title="By hour of day (UTC)" rows={a.byHour} />
      </div>
    </div>
  );
}
