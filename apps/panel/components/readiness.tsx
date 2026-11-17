"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "@/lib/agent";
import { Badge, Button, Card, ConfirmDialog, cx, Empty, ErrorBox, Loading } from "./ui";

interface Item { id: string; label: string; ok: boolean; detail: string; required?: boolean }
interface Readiness { ready: boolean; exchanges: { exchange: string; ready: boolean; items: Item[] }[] }

/** Real can't start until every required item is green for every exchange the Real bot may trade on. Optional items show as Recommended. */
export function RealReadiness() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["readiness"], queryFn: () => api<Readiness>("/api/real/readiness"), refetchInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const prepare = async (ex: string) => {
    setBusy(ex);
    setMsg(null);
    try {
      await api(`/api/exchanges/${ex}/prepare`, { method: "POST", json: {} });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["readiness"] });
    }
  };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data!;
  return (
    <Card title="Real Mode Readiness" action={<Badge tone={r.ready ? "pos" : "neg"}>{r.ready ? "Ready" : "Not ready"}</Badge>}>
      {r.exchanges.length === 0 ? (
        <Empty>No exchange key connected for the Real bot. Connect a key below, or choose exchanges in Settings → Real Trade Settings.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {r.exchanges.map((e) => (
            <div key={e.exchange} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-semibold capitalize">{e.exchange}</span>
                <Badge tone={e.ready ? "pos" : "neg"}>{e.ready ? "Ready" : "Blocked"}</Badge>
                <span className="flex-1" />
                <ConfirmDialog
                  title={`Prepare ${e.exchange}?`}
                  body={`Sets isolated margin, one-way mode and the Real leverage on ${e.exchange} BTC/USDT, then reads them back. These are account settings the bot sets anyway before its first order.`}
                  confirmLabel="Set and check"
                  onConfirm={() => prepare(e.exchange)}
                  trigger={<Button size="sm" disabled={busy === e.exchange}>{busy === e.exchange ? "Checking…" : "Check & prepare"}</Button>}
                />
              </div>
              <ul className="divide-y divide-border text-sm">
                {e.items.map((i) => { const st = i.ok ? "ok" : i.required === false ? "rec" : "miss"; const color = st === "ok" ? "text-pos" : st === "rec" ? "text-warn" : "text-neg"; return (
                  <li key={i.id} className="flex items-center gap-2 py-1.5">
                    <span aria-hidden className={cx("w-4 shrink-0 font-bold", color)}>{st === "ok" ? "✓" : st === "rec" ? "!" : "✕"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{i.label}</span>
                      <span className="block truncate text-xs text-muted" title={i.detail}>{i.detail}</span>
                    </span>
                    <span className={cx("shrink-0 text-xs font-medium", color)}>{st === "ok" ? "OK" : st === "rec" ? "Recommended" : "Missing"}</span>
                  </li>
                ); })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="mt-3"><ErrorBox error={msg} /></div>}
      <p className="mt-3 text-xs text-muted">Isolated margin, one-way mode and leverage are set when you test the key (Check &amp; prepare repeats it). The testnet pass is optional: it comes from <code>pnpm test:testnet</code> in the source code and does not block Real.</p>
    </Card>
  );
}
