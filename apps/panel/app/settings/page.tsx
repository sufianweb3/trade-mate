"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, ErrorBox, Field, Input, Loading, Segmented, Stepper } from "@/components/ui";
import { api, useAgent } from "@/lib/agent";
import { TradeSettings } from "@/components/trade-settings";

interface SettingsResp { scrapeIntervalMs: number; coinglassUrl: string; warmSetSize: number; theme: string; dataDir: string | null; symbolOverrides: { coinglass: string; exchange: string; unified: string }[] }

type Tab = "general" | "paper" | "real" | "test";

export default function Settings() {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div className="space-y-4">
      <Segmented value={tab} onChange={setTab} options={[
        { value: "general", label: "General" },
        { value: "paper", label: "Paper Trade Settings" },
        { value: "real", label: "Real Trade Settings" },
        { value: "test", label: "Test (Grid) Settings" },
      ]} />
      {tab === "general" ? <General /> : <TradeSettings key={tab} botId={tab} />}
    </div>
  );
}

function General() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResp>("/api/settings"), refetchInterval: false });
  const agent = useAgent();
  const [ov, setOv] = useState({ coinglass: "", exchange: "binance", unified: "" });
  const [saved, setSaved] = useState("");
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("oisniper.theme") ?? "system"; } catch { return "system"; } });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const put = async (p: Partial<SettingsResp>) => {
    await api("/api/settings", { method: "PUT", json: p });
    setSaved("Saved");
    void qc.invalidateQueries({ queryKey: ["settings"] });
  };
  const applyTheme = (t: string) => {
    setTheme(t);
    try { localStorage.setItem("oisniper.theme", t); } catch { /* ignore */ }
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    void put({ theme: t });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Agent connection">
        <div className="space-y-3">
          <Field label="Agent URL"><Input value={agent.agentUrl} onChange={(e) => agent.setUrl(e.target.value)} /></Field>
          <Field label="Token" hint="Stored in this browser only."><Input value={agent.token ? `${agent.token.slice(0, 4)}••••${agent.token.slice(-4)}` : "—"} readOnly /></Field>
          <Button onClick={async () => { const r = await api<{ pairToken: string }>("/api/settings/rotate-token", { method: "POST" }); agent.setToken(r.pairToken); setSaved("Token rotated. Other browsers must re-pair."); }}>Rotate token</Button>
        </div>
      </Card>
      <Card title="Appearance">
        <Segmented value={theme} onChange={applyTheme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </Card>
      <Card title="Scraper">
        <div className="space-y-3">
          <Field label="Scrape interval (15 to 120 s)"><Stepper value={s.scrapeIntervalMs / 1000} step={5} suffix="s" onChange={(v) => v != null && void put({ scrapeIntervalMs: v * 1000 })} /></Field>
          <Field label="CoinGlass URL"><Input defaultValue={s.coinglassUrl} onBlur={(e) => e.target.value !== s.coinglassUrl && void put({ coinglassUrl: e.target.value })} /></Field>
          <Field label="Warm book set (top N by OI 5m)"><Stepper value={s.warmSetSize} step={5} onChange={(v) => v != null && void put({ warmSetSize: v })} /></Field>
          <p className="text-xs text-muted">Data folder: {s.dataDir ?? "—"}</p>
        </div>
      </Card>
      <Card title="Symbol mapping overrides">
        <div className="flex flex-wrap gap-2">
          <Input className="!w-28" placeholder="CoinGlass" value={ov.coinglass} onChange={(e) => setOv({ ...ov, coinglass: e.target.value.toUpperCase() })} />
          <select className="h-9 rounded-xl border border-line bg-elevated px-2 text-sm" value={ov.exchange} onChange={(e) => setOv({ ...ov, exchange: e.target.value })}>
            {["binance", "bybit", "okx", "gate", "kucoin", "mexc"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <Input className="!w-48" placeholder="1000PEPE/USDT:USDT" value={ov.unified} onChange={(e) => setOv({ ...ov, unified: e.target.value })} />
          <Button onClick={async () => { await api("/api/settings/symbol-override", { method: "PUT", json: { ...ov, unified: ov.unified || null } }); void qc.invalidateQueries({ queryKey: ["settings"] }); }}>Save</Button>
        </div>
        <ul className="mt-3 space-y-1 text-sm tabular">{s.symbolOverrides.map((o) => <li key={o.coinglass + o.exchange}>{o.coinglass} → {o.exchange}: {o.unified}</li>)}</ul>
      </Card>
      {saved && <p className="text-sm text-pos">{saved}</p>}
    </div>
  );
}
