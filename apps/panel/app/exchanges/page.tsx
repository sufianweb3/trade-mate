"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorBox, Field, Input, Loading, StatusBadge } from "@/components/ui";
import { api, ApiError } from "@/lib/agent";
import { KeyReportView } from "@/components/key-report";
import { RealReadiness } from "@/components/readiness";
import type { ExchangeResp, KeyReport } from "@/lib/types";

const EMPTY = { apiKey: "", secret: "", passphrase: "" };

/**
 * Paste -> Test & connect -> Connected / Warning / Not connected, one row per check. Real account first, the
 * exchange's testnet / demo automatically if the real one refuses the key. Secrets leave the page right after the test,
 * except while the user is asked to confirm "no withdrawal permission".
 */
function KeyForm({ ex, onDone }: { ex: ExchangeResp; onDone: () => void }) {
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<KeyReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (confirmNoWithdraw: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<KeyReport>(`/api/exchanges/${ex.exchange}/keys`, { method: "POST", json: { ...f, passphrase: f.passphrase || undefined, confirmNoWithdraw } });
      setReport(r);
      if (!r.needsConfirm) setF(EMPTY); // never keep secrets in the page
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <Field label="API key"><Input autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value.trim() })} /></Field>
      <Field label="Secret"><Input type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value.trim() })} /></Field>
      {ex.needsPassphrase && <Field label="Passphrase"><Input type="password" autoComplete="off" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} /></Field>}
      <Button variant="primary" size="sm" disabled={busy || !f.apiKey || !f.secret || (ex.needsPassphrase && !f.passphrase)} onClick={() => void submit(false)}>{busy ? "Testing…" : "Test & connect"}</Button>
      {busy && <p className="text-xs text-muted">Checking the key, permissions, balance, trading and account setup. This takes a few seconds.</p>}
      {report && <KeyReportView r={report} />}
      {report?.needsConfirm === "no_withdraw" && (
        <div className="rounded-lg border border-warn/40 p-3 text-sm">
          <p>{ex.exchange} does not tell apps whether a key can withdraw. Open the key on {ex.exchange} and check that withdrawal is off.</p>
          <Button className="mt-2" size="sm" disabled={busy} onClick={() => void submit(true)}>Withdrawal is off, connect</Button>
        </div>
      )}
      {err && <p className="text-sm text-neg">{err}</p>}
      <p className="text-[11px] text-muted">Keys are encrypted (AES-256-GCM) on this device and only sent to the exchange. Needed: read + futures trade. Keys that can withdraw are refused. Testing also sets isolated margin, one-way mode and the Real leverage on BTC/USDT.</p>
    </div>
  );
}

export default function Exchanges() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["exchanges"], queryFn: () => api<ExchangeResp[]>("/api/exchanges"), refetchInterval: 10000 });
  const [open, setOpen] = useState<string | null>(null);
  const [retested, setRetested] = useState<Record<string, KeyReport>>({});
  const [retesting, setRetesting] = useState<string | null>(null);
  const [retestErr, setRetestErr] = useState<Record<string, string>>({});
  const retest = async (ex: string) => {
    setRetesting(ex);
    setRetestErr({ ...retestErr, [ex]: "" });
    try {
      const r = await api<KeyReport>(`/api/exchanges/${ex}/keys/retest`, { method: "POST", json: {} });
      setRetested((m) => ({ ...m, [ex]: r }));
      void qc.invalidateQueries();
    } catch (e) {
      setRetestErr((m) => ({ ...m, [ex]: e instanceof ApiError ? e.message : String(e) }));
    } finally {
      setRetesting(null);
    }
  };
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
            {!ex.key && <><dt className="text-muted">Key</dt><dd>none (paper only)</dd></>}
          </dl>
          {ex.health?.error && <p className="mt-2 text-xs text-neg">{ex.health.error}</p>}
          {ex.key && open !== ex.exchange && (
            <div className="mt-3 border-t border-line pt-3">
              {retested[ex.exchange] || ex.report ? <KeyReportView r={retested[ex.exchange] ?? ex.report!} showOk={!!retested[ex.exchange]} /> : <p className="text-sm text-muted">{ex.key.masked} · not tested since the app started</p>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant={ex.key ? "default" : "primary"} onClick={() => setOpen(open === ex.exchange ? null : ex.exchange)}>{open === ex.exchange ? "Close" : ex.key ? "Replace key" : "Connect key"}</Button>
            {ex.key && <Button size="sm" disabled={retesting === ex.exchange} onClick={() => void retest(ex.exchange)}>{retesting === ex.exchange ? "Testing…" : "Test again"}</Button>}
            {ex.key && <Button size="sm" variant="ghost" onClick={async () => { await api(`/api/exchanges/${ex.exchange}/keys`, { method: "DELETE" }); void qc.invalidateQueries(); }}>Remove</Button>}
          </div>
          {retestErr[ex.exchange] && <p className="mt-2 text-sm text-neg">{retestErr[ex.exchange]}</p>}
          {open === ex.exchange && <KeyForm ex={ex} onDone={() => void qc.invalidateQueries()} />}
        </Card>
      ))}
    </div>
    </div>
  );
}
