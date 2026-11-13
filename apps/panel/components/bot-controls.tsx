"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "@/lib/agent";
import { usd } from "@/lib/format";
import type { BotResp } from "@/lib/types";
import { VIEWS, VIEW_LABEL, useRunScope, useView, type View, VIEW_LABEL as L } from "@/lib/view";
import { Badge, Button, Card, Input, ModeBadge, Segmented } from "./ui";

/** Running / Stopped / Paused / Error from the agent's bot status. */
function statusOf(b: BotResp): { label: string; tone: "pos" | "neutral" | "warn" | "neg" } {
  if (b.status === "running") return { label: "Running", tone: "pos" };
  if (b.status === "paused") return { label: "Paused", tone: "warn" };
  if (b.status === "halted") return { label: "Error", tone: "neg" };
  return { label: "Stopped", tone: "neutral" };
}

export function ViewSelect({ runScope = false }: { runScope?: boolean }) {
  const { view, setView } = useView();
  const { allRuns, setAllRuns } = useRunScope();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented value={view} onChange={setView} options={VIEWS} />
      {runScope && (
        <Segmented value={allRuns ? "all" : "run"} onChange={(v) => setAllRuns(v === "all")}
          options={[{ value: "run", label: "This run" }, { value: "all", label: "All runs" }]} />
      )}
    </div>
  );
}

/** `run=<id>` for the shown bot's current run, or "" when "All runs" is selected. */
export function useRunParam(): string {
  const view = useView((s) => s.view);
  const allRuns = useRunScope((s) => s.allRuns);
  const q = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  const run = q.data?.find((b) => b.id === view)?.run.id;
  return allRuns || !run ? "" : run;
}

/** Separate Start / Stop for Paper, Real and Test. Each runs independently. */
export function BotControls() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [live, setLive] = useState<BotResp | null>(null);
  const [typed, setTyped] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
    await qc.invalidateQueries();
  };
  const bots = (q.data ?? []).filter((b) => VIEWS.some((v) => v.value === b.id));
  return (
    <Card title="Bots">
      <div className="grid gap-3 md:grid-cols-3">
        {bots.map((b) => {
          const s = statusOf(b);
          return (
            <div key={b.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{L[b.id as View]}</span>
                <ModeBadge mode={b.config.mode} />
                <Badge tone={s.tone}>{s.label}</Badge>
                <span className="flex-1" />
                {b.running ? (
                  <Button size="sm" onClick={() => setStopping(b.id)}>Stop</Button>
                ) : (
                  <Button size="sm" variant={b.id === "real" ? "danger" : "primary"} onClick={() => (b.id === "real" ? (setTyped(""), setLive(b)) : void run(() => api(`/api/bots/${b.id}/start`, { method: "POST", json: {} })))}>Start</Button>
                )}
              </div>
              <div className="mt-1 text-xs text-muted">{b.id === "test" ? "Bot 2 research grid" : "Bot 1 Sniper"} {b.status_reason ? `· ${b.status_reason}` : ""}</div>
              {stopping === b.id && (
                <div className="mt-3 space-y-2 rounded-lg bg-elevated p-3 text-sm">
                  <p>Stop new entries for {VIEW_LABEL[b.id as View]}. What about open positions?</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => { setStopping(null); void run(() => api(`/api/bots/${b.id}/stop`, { method: "POST", json: { closePositions: false } })); }}>Keep managing them</Button>
                    <Button size="sm" variant="danger" onClick={() => { setStopping(null); void run(() => api(`/api/bots/${b.id}/stop`, { method: "POST", json: { closePositions: true } })); }}>Close all now</Button>
                    <Button size="sm" variant="ghost" onClick={() => setStopping(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {live && (
        <div className="mt-4 rounded-xl border border-live/50 bg-live/10 p-4 text-sm">
          <p className="font-semibold">Start REAL trading with real money?</p>
          <p className="mt-1 text-muted tabular">
            Exchanges: {live.config.exchanges === "ALL" ? "all connected" : live.config.exchanges.join(", ")} · max capital {usd(live.config.risk.maxCapital)} · leverage {live.config.leverages[0]}x · margin {live.config.sizing.mode === "fixed" ? usd(live.config.sizing.value) : `${live.config.sizing.value}% of capital`}
          </p>
          <p className="mt-1 text-xs text-muted">Requires connected, validated exchange keys (Exchanges page).</p>
          <div className="mt-3 flex gap-2">
            <Input className="max-w-40" placeholder="Type LIVE" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button variant="danger" disabled={typed !== "LIVE"} onClick={() => { setLive(null); void run(() => api(`/api/bots/real/start`, { method: "POST", json: { confirm: typed } })); }}>Start Real</Button>
            <Button variant="ghost" onClick={() => setLive(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {err && <div className="mt-3 rounded-xl bg-neg/10 px-3 py-2 text-sm text-neg">{err}</div>}
    </Card>
  );
}

export function HeaderModeToggle() {
  const { view, setView } = useView();
  return (
    <Segmented value={view === "test" ? ("" as View) : view} onChange={setView} options={VIEWS.filter((v) => v.value !== "test")} />
  );
}
