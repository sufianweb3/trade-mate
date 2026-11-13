"use client";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Card, Empty, ErrorBox, Input, Loading, Segmented, Signed, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/agent";
import { ExportButton } from "@/components/export-button";
import { useRunParam, ViewSelect } from "@/components/bot-controls";
import { useView } from "@/lib/view";
import { pct, time } from "@/lib/format";
import type { SignalRec } from "@/lib/types";

const COLS = ["oi_chg_5m", "oi_chg_1h", "vol_chg_1h", "price_chg_5m", "price_chg_1h"] as const;

interface CooldownRow { symbol: string; cause: string; until: number | null; remainingMs: number | null; lastEntry: number; lastClose: number | null }

const left = (ms: number | null) => (ms == null ? "until the cooldown after close" :`${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`);

function Cooldowns({ bot }: { bot: string }) {
  const q = useQuery({ queryKey: ["cooldowns", bot], queryFn: () => api<CooldownRow[]>(`/api/bots/${bot}/cooldowns`) });
  return (
    <Card title="Cooldown (per symbol, all exchanges)" action={<span className="text-xs text-muted">Blocked: open position, or inside the bot's cooldown since last entry or close (Test: since last entry only)</span>}>
      {!q.data?.length ? <Empty>No symbol in cooldown.</Empty> : (
        <Table head={["Symbol", "Cause", "Remaining", "Ends", "Last entry", "Last close"]}>
          {q.data.map((c) => <tr key={c.symbol}><Td className="font-medium">{c.symbol}</Td><Td>{c.cause.replace("_", " ")}</Td><Td>{left(c.remainingMs)}</Td><Td>{time(c.until)}</Td><Td>{time(c.lastEntry)}</Td><Td>{time(c.lastClose)}</Td></tr>)}
        </Table>
      )}
    </Card>
  );
}

/** The list is slim; the full record (every variant's gates, router) loads when a row is opened. */
function SignalDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["signal", id], queryFn: () => api<SignalRec>(`/api/signals/${id}`), refetchInterval: false });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error("signal not found")} />;
  const s = q.data;
  const failed = s.gate_results.filter((g) => !g.pass).length;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <div><div className="mb-1 font-semibold">Gates (failed first) <span className="font-normal text-muted">{failed} failed / {s.gate_results.length}</span></div>
        <div className="max-h-72 overflow-y-auto tabular">
          {[...s.gate_results].sort((a, b) => Number(a.pass) - Number(b.pass)).map((g, i) => (
            <div key={i} className={g.pass ? "text-muted" : "text-neg"}>{g.pass ? "✓" : "✕"} {g.exchange ? `${g.exchange} ` : ""}{g.variant_id} {g.gate}: {g.value ?? "—"} / {g.limit ?? "—"}</div>
          ))}
        </div>
      </div>
      <div><div className="mb-1 font-semibold">Router</div>
        {s.router.map((r) => <div key={r.exchange}>{r.exchange}: {r.score ? `score ${Number(r.score).toFixed(4)} (cost ${Number(r.est_cost_pct).toFixed(4)}%)` : r.excluded}</div>)}
        {s.venue_tries && s.venue_tries.length > 0 && (
          <div className="mt-2"><div className="font-semibold">Venues gated (in order)</div>
            {s.venue_tries.map((v, i) => (
              <div key={i} className={v.pass ? "text-pos" : "text-neg"}>{i + 1}. {v.exchange}: {v.pass ? `passed${v.leverage != null ? ` at ${v.leverage}x, ${v.size_pct}% size` : ""}` : v.codes.join(", ") || "failed"}</div>
            ))}
          </div>
        )}
        {s.skipped_variants.length > 0 && <div className="mt-2 text-muted">Skipped: {s.skipped_variants.map((v) => `${v.variant_id} ${v.code}`).join(", ")}</div>}
        {s.fit && (s.fit.leverage_mode === "fit" || s.fit.size_mode === "fit") && s.fit.requested_leverage != null && (
          <div className="mt-3"><div className="mb-1 font-semibold">Adaptive entry</div>
            {s.fit.leverage != null
              ? <div className={s.fit.fitted ? "text-pos" : ""}>{s.fit.requested_leverage}x → {s.fit.leverage}x at {s.fit.size_pct}% size{s.fit.fitted ? " (fitted)" : " (as configured)"}</div>
              : <div className="text-neg">No leverage / size passed{s.fit.stopped_by ? `: ${s.fit.stopped_by} cannot be fixed by leverage or size` : ""}</div>}
            <div className="text-muted">{s.fit.attempts} combinations tried · at config failed: {s.fit.requested_fail_codes.join(", ") || "none"}</div>
          </div>
        )}
      </div>
      <div><div className="mb-1 font-semibold">Counterfactual</div>
        {s.counterfactual ? <>
          <div>+15m <Signed v={s.counterfactual.chg_15m} fmt={(v) => pct(v, 3)} /> · +1h <Signed v={s.counterfactual.chg_1h} fmt={(v) => pct(v, 3)} /> · +4h <Signed v={s.counterfactual.chg_4h} fmt={(v) => pct(v, 3)} /></div>
          <div>First hit: {s.counterfactual.first_hit ?? "pending"}</div>
        </> : <span className="text-muted">Pending: price follow-up runs for 4h after the signal.</span>}
        {s.status === "shadow" && <div className="mt-2 text-muted">Shadow: the bot's other data source ({s.data_source}) fired here. Logged for the CoinGlass vs Exchange comparison, never traded and not a failure.</div>}
      </div>
    </div>
  );
}

export default function Signals() {
  const bot = useView((s) => s.view);
  const [status, setStatus] = useState("all");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [cols, setCols] = useState<string[]>([...COLS]);
  const run = useRunParam();
  const qs = new URLSearchParams({ limit: "300", bot, ...(run && { run }), ...(status !== "all" && { status }), ...(reason && { reason }) });
  const q = useQuery({ queryKey: ["signals", qs.toString()], queryFn: () => api<SignalRec[]>(`/api/signals?${qs}`), refetchInterval: 15_000 });
  return (
    <div className="space-y-4">
    <Cooldowns bot={bot} />
    <Card title="Signals" action={<div className="flex flex-wrap gap-2">
      <ViewSelect runScope />
      <Segmented value={status} onChange={setStatus} options={["all", "opened", "rejected", "cooldown", "shadow"].map((v) => ({ value: v, label: v }))} />
      <Input className="!w-48" placeholder="reason e.g. GATE_SPREAD" value={reason} onChange={(e) => setReason(e.target.value.toUpperCase())} />
      <ExportButton bot={bot} run={run} />
    </div>}>
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted">
        Columns:
        {["oi_chg_5m", "oi_chg_15m", "oi_chg_1h", "oi_chg_4h", "vol_chg_1h", "price_chg_5m", "price_chg_1h", "funding_rate"].map((c) => (
          <label key={c} className="flex items-center gap-1"><input type="checkbox" checked={cols.includes(c)} onChange={() => setCols(cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c])} />{c}</label>
        ))}
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <Empty>No signals yet. Rule matches appear here, including rejected ones.</Empty> : (
        <Table head={["Time", "Bot", "Symbol", "Status", "Venue", ...cols, "Reasons", "Opened", "Rematch"]}>
          {q.data.map((s) => (
            <Fragment key={s.signal_id}>
              <tr className="cursor-pointer hover:bg-elevated" onClick={() => setOpen(open === s.signal_id ? null : s.signal_id)}>
                <Td>{time(s.ts)}</Td><Td>{s.bot_id}</Td><Td className="font-medium">{s.symbol}</Td><Td><StatusBadge s={s.status} /></Td><Td>{s.exchange ?? "—"}</Td>
                {cols.map((c) => <Td key={c}><Signed v={s.metrics[c]} fmt={(v) => pct(v)} /></Td>)}
                <Td className="max-w-[280px] truncate text-xs">{s.reject_reasons.join(", ") || "—"}{s.cooldown && <span className="text-muted"> · {s.cooldown.cause.replace("_", " ")}{s.cooldown.until ? ` until ${time(s.cooldown.until)}` : ""}</span>}</Td><Td>{s.opened_trades}</Td><Td>{s.rematch_count}</Td>
              </tr>
              {open === s.signal_id && (
                <tr><td colSpan={9 + cols.length} className="bg-elevated p-4 text-xs"><SignalDetail id={s.signal_id} /></td></tr>
              )}
            </Fragment>
          ))}
        </Table>
      )}
    </Card>
    </div>
  );
}
