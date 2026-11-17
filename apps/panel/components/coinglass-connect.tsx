"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "@/lib/agent";
import type { ConnectStatus } from "@/lib/types";
import { Badge, Button } from "./ui";

const ACTIVE: ConnectStatus["phase"][] = ["opening", "waiting_login", "configuring", "finishing"];
const STEPS: { phase: ConnectStatus["phase"]; label: string }[] = [
  { phase: "opening", label: "Open window" },
  { phase: "waiting_login", label: "You log in" },
  { phase: "configuring", label: "Set up columns" },
  { phase: "finishing", label: "Run in background" },
];

/**
 * One-click CoinGlass connect: click, log in in the window that opens, done. The agent detects the login, turns on the
 * columns, closes the window and keeps scraping hidden. This shows each step while it runs and the outcome after.
 */
export function CoinGlassConnect({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["coinglass-connect"],
    queryFn: () => api<ConnectStatus | null>("/api/scraper/connect"),
    refetchInterval: (query) => (query.state.data && ACTIVE.includes(query.state.data.phase) ? 1500 : 15_000),
  });
  const s = q.data;
  const active = !!s && ACTIVE.includes(s.phase);

  const start = async () => {
    setErr(null);
    try {
      qc.setQueryData(["coinglass-connect"], await api<ConnectStatus>("/api/scraper/connect", { method: "POST", json: {} }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  const cancel = async () => {
    await api("/api/scraper/connect/cancel", { method: "POST", json: {} }).catch(() => undefined);
    void q.refetch();
  };

  const stepIdx = s ? STEPS.findIndex((x) => x.phase === s.phase) : -1;
  const outcome = s && !active && s.phase !== "idle" ? s.phase : null;
  const tone = outcome === "connected" ? "pos" : outcome === "warning" || outcome === "cancelled" ? "warn" : outcome === "failed" ? "neg" : "neutral";
  const outcomeLabel = outcome === "connected" ? "Connected" : outcome === "warning" ? "Connected, with a warning" : outcome === "cancelled" ? "Cancelled" : outcome === "failed" ? "Not connected" : null;

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <Button size="sm" variant="primary" disabled>Connecting…</Button>
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>Cancel</Button>
          </>
        ) : (
          <Button size={compact ? "sm" : "md"} variant="primary" onClick={() => void start()}>
            {outcome === "connected" || outcome === "warning" ? "Reconnect CoinGlass" : "Connect CoinGlass"}
          </Button>
        )}
        {outcomeLabel && <Badge tone={tone}>{outcomeLabel}</Badge>}
      </div>
      {active && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {STEPS.map((x, i) => (
            <li key={x.phase} className={i < stepIdx ? "text-pos" : i === stepIdx ? "font-semibold text-foreground" : "text-muted"}>
              {i < stepIdx ? "✓ " : `${i + 1}. `}{x.label}
            </li>
          ))}
        </ol>
      )}
      {s && s.phase !== "idle" && <p className="text-sm">{s.message}</p>}
      {!s || s.phase === "idle" ? !compact && <p className="text-xs text-muted">A browser window opens on CoinGlass. Log in there; it closes by itself and the bot keeps CoinGlass running in the background.</p> : null}
      {err && <p className="text-sm text-neg">{err}</p>}
    </div>
  );
}
