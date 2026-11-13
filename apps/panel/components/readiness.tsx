"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "@/lib/agent";
import { Badge, Button, Card, cx, Empty, ErrorBox, Loading } from "./ui";

interface Item { id: string; label: string; ok: boolean; detail: string }
interface Readiness { ready: boolean; exchanges: { exchange: string; ready: boolean; items: Item[] }[] }

/** Real can't start until every item is green for every exchange the Real bot may trade on. */
export function RealReadiness() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["readiness"], queryFn: () => api<Readiness>("/api/real/readiness"), refetchInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const prepare = async (ex: string) => {
    if (!confirm(`Set isolated margin, one-way mode and the Real leverage on ${ex} BTC/USDT, then read them back? These are account settings the bot sets anyway before its first order.`)) return;
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
            <div key={e.exchange} className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-semibold capitalize">{e.exchange}</span>
                <Badge tone={e.ready ? "pos" : "neg"}>{e.ready ? "green" : "blocked"}</Badge>
                <span className="flex-1" />
                <Button size="sm" disabled={busy === e.exchange} onClick={() => void prepare(e.exchange)}>{busy === e.exchange ? "Checking…" : "Check & prepare"}</Button>
              </div>
              <ul className="space-y-1 text-sm">
                {e.items.map((i) => (
                  <li key={i.id} className="flex gap-2">
                    <span className={cx("w-4 shrink-0 font-bold", i.ok ? "text-pos" : "text-neg")}>{i.ok ? "✓" : "✕"}</span>
                    <span className="shrink-0">{i.label}</span>
                    <span className="truncate text-xs text-muted" title={i.detail}>{i.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="mt-3"><ErrorBox error={msg} /></div>}
      <p className="mt-3 text-xs text-muted">Testnet pass comes from <code>pnpm test:testnet</code> (Binance futures testnet, Bybit testnet, OKX demo). Exchanges without a testnet cannot pass this item, so Real will not trade on them.</p>
    </Card>
  );
}
