"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/agent";
import type { BotResp, StateResp } from "@/lib/types";
import { HeaderModeToggle } from "./bot-controls";
import { Button, ConfirmDialog, StatusBadge } from "./ui";

/** Status of the signal sources the bots actually use (an unused source's state would only confuse). */
function SourceBadges({ s }: { s: StateResp }) {
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  // Real counts only while it runs (it is on hold by default); Paper and Test always count.
  const used = (bots.data ?? []).filter((b) => b.config.mode !== "live" || b.running);
  const kinds = new Set(used.map((b) => b.config.dataSource?.kind ?? "coinglass"));
  if (!bots.data) kinds.add("coinglass");
  return (
    <span className="hidden items-center gap-3 text-xs text-muted md:inline-flex">
      {kinds.has("coinglass") && <span className="inline-flex items-center gap-1.5">CoinGlass <StatusBadge s={s.scraper.status} /></span>}
      {kinds.has("exchange") && <span className="inline-flex items-center gap-1.5">Exchange data <StatusBadge s={s.exchangeData?.status ?? "DOWN"} /></span>}
    </span>
  );
}

/** One header for every page, in the desktop app and the browser: title, account view, sources, kill switch. */
export function PageHeader({ title }: { title: string }) {
  const st = useQuery({ queryKey: ["state"], queryFn: () => api<StateResp>("/api/state") });
  const qc = useQueryClient();
  return (
    <div className="flex flex-wrap items-center gap-3 pb-4">
      <h1 className="mr-auto text-[26px] font-bold tracking-tight">{title}</h1>
      <HeaderModeToggle />
      {st.data && <SourceBadges s={st.data} />}
      <ConfirmDialog
        title="Engage the kill switch?"
        body="All bots stop, open orders are cancelled and every open position is market-closed."
        confirmLabel="Close all + stop"
        tone="danger"
        onConfirm={async () => {
          await api("/api/kill-switch", { method: "POST", json: { confirm: true } });
          void qc.invalidateQueries();
        }}
        trigger={<Button size="sm" variant="danger" title="Stop all bots, cancel orders, market-close all positions">Kill switch</Button>}
      />
    </div>
  );
}
