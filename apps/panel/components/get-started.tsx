"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/agent";
import type { BotResp, StateResp } from "@/lib/types";
import { Button, Card } from "./ui";

/**
 * First-run helper: shown while a Paper / Test bot uses CoinGlass and CoinGlass is not delivering data yet.
 * Two plain choices: log in to CoinGlass once, or switch those bots to free exchange data (a new settings version).
 */
export function GetStarted() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["state"], queryFn: () => api<StateResp>("/api/state") });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!st.data || !bots.data) return null;
  const cgBots = bots.data.filter((b) => b.config.mode !== "live" && (b.config.dataSource?.kind ?? "coinglass") === "coinglass");
  if (!cgBots.length || st.data.scraper.status === "OK") return null;

  const login = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/scraper/show-browser", { method: "POST", json: { show: true } });
      setMsg("A browser window opened on CoinGlass. Log in, then click Customize and turn on OI Change 5m/15m/30m/1h/4h, Volume (1h%)/(4h%)/(24h%) and Price Change 5m/1h/4h, then Save. This card disappears once CoinGlass is OK.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const useExchange = async () => {
    setBusy(true);
    setMsg(null);
    try {
      for (const b of cgBots) await api(`/api/bots/${b.id}/config`, { method: "PUT", json: { ...b.config, dataSource: { kind: "exchange", oiScope: "aggregated" } } });
      await qc.invalidateQueries();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Get started: connect signal data">
      <p className="text-sm text-muted">
        {cgBots.map((b) => b.name).join(" and ")} {cgBots.length > 1 ? "use" : "uses"} CoinGlass, which is not connected yet. Choose one:
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void login()}>Log in to CoinGlass</Button>
        <Button disabled={busy} onClick={() => void useExchange()} title="Free public data from Binance, Bybit, OKX, Gate and KuCoin. Needs about 5 minutes to warm up.">Use exchange data instead (no account)</Button>
      </div>
      <p className="mt-2 text-xs text-muted">You can change this later in Settings → Signal Data Source. Each bot then needs Start on this page.</p>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </Card>
  );
}
