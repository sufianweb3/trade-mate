"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "@/lib/agent";
import { time, usd } from "@/lib/format";
import type { BotResp } from "@/lib/types";
import { BotEditor } from "./bot-editor";
import { Button, Card, ErrorBox, Loading, ModeBadge } from "./ui";

const INTRO: Record<string, string> = {
  paper: "Bot 1 Sniper on the exchange simulator. Its own account, history and settings.",
  real: "Bot 1 Sniper with real orders. Separate from Paper: editing these never changes Paper settings, and vice versa. Max capital is required.",
  test: "Bot 2 Research Grid: any 3 of 5 OI and any 1 of 3 Volume changes positive opens 5x to 50x x trail variants at $100 each on the simulator, again every 15 min while positions are open.",
};

/** One bot's full strategy, exits, sizing, risk, gates and venues. Each save is a new immutable version. */
export function TradeSettings({ botId }: { botId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots"), refetchInterval: 8000 });
  const [err, setErr] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const b = q.data?.find((x) => x.id === botId);
  if (!b) return <ErrorBox error={`Bot ${botId} not found`} />;
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{b.name} settings</h1>
          <ModeBadge mode={b.config.mode} />
          <span className="flex-1" />
          {b.config.mode === "paper" && (
            <Button variant="ghost" onClick={async () => {
              if (!confirm("Archive this run and start fresh? History stays exportable.")) return;
              try { await api(`/api/bots/${b.id}/reset`, { method: "POST" }); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
              void qc.invalidateQueries();
            }}>Reset stats</Button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">{INTRO[botId]}</p>
        <div className="mt-2 text-xs text-muted tabular">
          Run {b.run.id} since {time(b.run.started_at)} · start {usd(b.run.start_balance)} · version {b.current_version_id} · {b.runs.length} run(s)
        </div>
        {err && <div className="mt-3"><ErrorBox error={err} /></div>}
      </Card>
      <BotEditor key={`${b.id}-${b.current_version_id}`} botId={b.id} initial={b.config} running={!!b.running} onSaved={() => void qc.invalidateQueries()} />
    </div>
  );
}
