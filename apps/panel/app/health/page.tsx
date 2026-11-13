"use client";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Empty, ErrorBox, Kpi, Loading, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/agent";
import { dur, time } from "@/lib/format";
import type { StateResp } from "@/lib/types";

interface Stage { stage: string; n: number; p50: number | null; p95: number | null; target: string | null }

interface HealthResp {
  version: string; uptimeMs: number; scraper: StateResp["scraper"] & { note: string | null; loggedIn: boolean | null }; exchangeData: (StateResp["scraper"] & { note: string | null }) | null; sleepGuard: boolean; vault: string; vaultReason?: string | null;
  exchanges: { exchange: string; status: string; wsConnected: boolean; rttMs: number | null; clockOffsetMs: number | null; subscriptions: number; lastMessageTs: number | null; error: string | null }[];
  snapshots: { id: string; ts: number; row_count: number; health: { status: string; parseMs: number } }[];
  errors: { ts: number; source: string; code: string | null; message: string }[];
}

export default function Health() {
  const q = useQuery({ queryKey: ["health"], queryFn: () => api<HealthResp>("/api/health") });
  const lat = useQuery({ queryKey: ["latency"], queryFn: () => api<Record<string, Stage[]>>("/api/latency"), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const h = q.data!;
  const s = h.scraper;
  const fill = Object.entries(s.lastHealth?.fillRates ?? {});
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Agent" value={`v${h.version}`} sub={`up ${dur(h.uptimeMs / 1000)}`} />
        <Kpi label="CoinGlass" value={<StatusBadge s={s.status} />} sub={`${s.loggedIn == null ? "" : s.loggedIn ? "logged in · " : "logged out · "}${s.note ?? s.reason ?? s.source}`} />
        <Kpi label="Exchange data" value={<StatusBadge s={h.exchangeData?.status ?? "STOPPED"} />} sub={h.exchangeData ? `${h.exchangeData.lastHealth?.rowCount ?? 0} coins · ${h.exchangeData.note ?? h.exchangeData.reason ?? "ok"}` : "not configured"} />
        <Kpi label="Last parse" value={s.lastSnapshotTs ? `${Math.round((Date.now() - s.lastSnapshotTs) / 1000)}s ago` : "—"} sub={`${s.lastHealth?.rowCount ?? 0} rows · ${s.lastHealth?.parseMs ?? 0}ms`} />
        <Kpi label="Sleep guard" value={h.sleepGuard ? "on" : "off"} sub="on while positions are open" />
        <Kpi label="Key vault" value={h.vault} sub={h.vaultReason ?? undefined} />
      </div>
      <Card title="Signal latency (p50 / p95)" action={<span className="text-xs text-muted">Last 500 trades and 2000 signals; paper latency is simulated from measured live latency</span>}>
        {["live", "paper"].map((m) => (lat.data?.[m] ?? []).some((x) => x.n) ? (
          <div key={m} className="mb-3">
            <div className="mb-1 text-xs font-semibold uppercase text-muted">{m}</div>
            <Table head={["Stage", "n", "p50", "p95", "Target"]}>
              {lat.data![m]!.map((x) => <tr key={x.stage}><Td>{x.stage}</Td><Td>{x.n}</Td><Td>{x.p50 == null ? "—" : `${x.p50} ms`}</Td><Td>{x.p95 == null ? "—" : `${x.p95} ms`}</Td><Td className="text-muted">{x.target ?? ""}</Td></tr>)}
            </Table>
          </div>
        ) : null)}
        {!lat.data || !["live", "paper"].some((m) => (lat.data?.[m] ?? []).some((x) => x.n)) ? <Empty>No signals measured yet.</Empty> : null}
      </Card>
      <Card title="CoinGlass column fill rate" action={<div className="flex gap-2">
        <Button size="sm" onClick={() => void api("/api/scraper/show-browser", { method: "POST", json: { show: true } })} title="Opens a real Chromium window with the bot profile: log in to CoinGlass once or pass a check">Show browser (log in)</Button>
        <Button size="sm" variant="ghost" onClick={() => void api("/api/scraper/show-browser", { method: "POST", json: { show: false } })}>Hide</Button>
      </div>}>
        {s.lastHealth?.missingColumns.length ? <p className="mb-2 text-sm text-neg">Missing: {s.lastHealth.missingColumns.join(", ")}</p> : null}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs tabular md:grid-cols-4">
          {fill.map(([k, v]) => <div key={k} className="flex justify-between"><span className="text-muted">{k}</span><span className={v < 0.5 ? "text-warn" : ""}>{(v * 100).toFixed(0)}%</span></div>)}
        </div>
      </Card>
      <Card title="Exchanges">
        <Table head={["Exchange", "Status", "WS", "RTT", "Clock offset", "Books", "Last message", "Error"]}>
          {h.exchanges.map((e) => <tr key={e.exchange}><Td>{e.exchange}</Td><Td><StatusBadge s={e.status} /></Td><Td>{e.wsConnected ? "up" : "—"}</Td><Td>{e.rttMs ?? "—"} ms</Td><Td>{e.clockOffsetMs != null ? Math.round(e.clockOffsetMs) : "—"} ms</Td><Td>{e.subscriptions}</Td><Td>{time(e.lastMessageTs)}</Td><Td className="max-w-[260px] truncate text-xs text-neg">{e.error ?? ""}</Td></tr>)}
        </Table>
      </Card>
      <Card title="Error log">
        {h.errors.length === 0 ? <Empty>No errors.</Empty> : (
          <Table head={["Time", "Source", "Code", "Message"]}>
            {h.errors.slice(0, 50).map((e, i) => <tr key={i}><Td>{time(e.ts)}</Td><Td>{e.source}</Td><Td>{e.code ?? "—"}</Td><Td className="max-w-[480px] truncate">{e.message}</Td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}
