"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, cx, ErrorBox, Field, Input, Loading, StatusBadge, Switch } from "@/components/ui";
import { api, ApiError } from "@/lib/agent";
import { RealReadiness } from "@/components/readiness";
import type { ExchangeResp } from "@/lib/types";

const yn = (v: boolean | null | undefined) => (v == null ? "unknown" : v ? "yes" : "no");

function KeyForm({ ex, onDone }: { ex: ExchangeResp; onDone: () => void }) {
  const [f, setF] = useState({ apiKey: "", secret: "", passphrase: "", testnet: true, confirmNoWithdraw: false });
  const [res, setRes] = useState<string | null>(null);
  const submit = async () => {
    setRes(null);
    try {
      const r = await api<{ status: string; reason: string | null; warnings: string[] }>(`/api/exchanges/${ex.exchange}/keys`, { method: "POST", json: { ...f, passphrase: f.passphrase || undefined } });
      setRes(`${r.status}${r.reason ? `: ${r.reason}` : ""}${r.warnings.length ? ` (${r.warnings.join("; ")})` : ""}`);
      setF({ ...f, apiKey: "", secret: "", passphrase: "" }); // never keep secrets in the page
      onDone();
    } catch (e) {
      setRes(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <Field label="API key"><Input autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></Field>
      <Field label="Secret"><Input type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>
      {ex.needsPassphrase && <Field label="Passphrase"><Input type="password" autoComplete="off" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} /></Field>}
      <div className="flex items-center gap-2 text-xs">{ex.testnetAvailable && <><Switch checked={f.testnet} onChange={(v) => setF({ ...f, testnet: v })} label="testnet" /> Testnet / demo</>}</div>
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={f.confirmNoWithdraw} onChange={(e) => setF({ ...f, confirmNoWithdraw: e.target.checked })} />I confirm this key has no withdrawal permission (required where the exchange hides permissions)</label>
      <Button variant="primary" size="sm" disabled={!f.apiKey || !f.secret} onClick={submit}>Validate and save</Button>
      {res && <div className="text-xs">{res}</div>}
      <p className="text-[11px] text-muted">Keys are encrypted (AES-256-GCM) on this device and only sent to the exchange. Required: read + futures trade. Keys with withdrawal permission are refused.</p>
    </div>
  );
}

export default function Exchanges() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["exchanges"], queryFn: () => api<ExchangeResp[]>("/api/exchanges"), refetchInterval: 10000 });
  const [open, setOpen] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, Record<string, string>>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="space-y-4">
    <RealReadiness />
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {q.data!.map((ex) => (
        <Card key={ex.exchange} title={<span className="capitalize">{ex.exchange}</span>} action={<StatusBadge s={ex.health?.status ?? "down"} />}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm tabular">
            <dt className="text-muted">Markets</dt><dd>{ex.markets}</dd>
            <dt className="text-muted">Latency</dt><dd>{ex.health?.rttMs != null ? `${ex.health.rttMs} ms` : "—"}</dd>
            <dt className="text-muted">Clock offset</dt><dd>{ex.health?.clockOffsetMs != null ? `${Math.round(ex.health.clockOffsetMs)} ms` : "—"}</dd>
            <dt className="text-muted">WS / books</dt><dd>{ex.health?.wsConnected ? "connected" : "—"} · {ex.health?.subscriptions ?? 0}</dd>
            <dt className="text-muted">Key</dt><dd>{ex.key ? <span>{ex.key.masked} <StatusBadge s={ex.key.status} /></span> : "none (paper only)"}</dd>
            {ex.key && <>
              <dt className="text-muted">Trading</dt><dd>{ex.key.tradeEnabled ? "enabled" : "data + paper only"}</dd>
              <dt className="text-muted">Withdraw perm</dt><dd>{yn(ex.key.permissions?.withdraw)}</dd>
              <dt className="text-muted">IP whitelist</dt><dd>{yn(ex.key.permissions?.ipWhitelist)}</dd>
              <dt className="text-muted">Taker fee</dt><dd>{ex.key.takerPct ? `${ex.key.takerPct}%` : "base tier"}</dd>
            </>}
          </dl>
          {ex.health?.error && <p className="mt-2 text-xs text-neg">{ex.health.error}</p>}
          {ex.key?.reason && <p className="mt-2 text-xs text-warn">{ex.key.reason}</p>}
          {ex.key?.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warn">{w}</p>)}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => setOpen(open === ex.exchange ? null : ex.exchange)}>{ex.key ? "Replace key" : "Connect key"}</Button>
            {ex.key && <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/exchanges/${ex.exchange}/keys`, { method: "DELETE" }); void qc.invalidateQueries(); }}>Remove</Button>}
            {ex.key && <Button size="sm" variant="ghost" onClick={async () => setChecks({ ...checks, [ex.exchange]: await api<Record<string, string>>(`/api/exchanges/${ex.exchange}/readonly-check`, { method: "POST", json: {} }) })}>Read-only check</Button>}
          </div>
          {checks[ex.exchange] && (
            <dl className="mt-3 space-y-0.5 border-t border-line pt-2 text-xs">
              {Object.entries(checks[ex.exchange]!).map(([k, v]) => <div key={k} className="flex gap-2"><dt className="w-20 shrink-0 text-muted">{k}</dt><dd className={cx("truncate", v.startsWith("ok") ? "text-pos" : v.startsWith("error") ? "text-neg" : "text-muted")} title={v}>{v}</dd></div>)}
            </dl>
          )}
          {open === ex.exchange && <KeyForm ex={ex} onDone={() => void qc.invalidateQueries()} />}
        </Card>
      ))}
    </div>
    </div>
  );
}
