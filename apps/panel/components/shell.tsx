"use client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, connect, useAgent } from "@/lib/agent";
import type { BotResp, StateResp } from "@/lib/types";
import { HeaderModeToggle } from "./bot-controls";
import { useView } from "@/lib/view";
import { Button, Card, cx, Input, StatusBadge } from "./ui";

const NAV = [
  ["/", "Overview"], ["/signals/", "Signals"], ["/history/", "History"],
  ["/analytics/", "Analytics"], ["/exchanges/", "Exchanges"], ["/health/", "Health"], ["/settings/", "Settings"],
] as const;

/** Header status of the signal sources the bots actually use (an unused source's state would only confuse). */
function SourceBadges({ s }: { s: StateResp }) {
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  // Real counts only while it runs (it is on hold by default); Paper and Test always count.
  const used = (bots.data ?? []).filter((b) => b.config.mode !== "live" || b.running);
  const kinds = new Set(used.map((b) => b.config.dataSource?.kind ?? "coinglass"));
  if (!bots.data) kinds.add("coinglass");
  return (
    <span className="hidden md:inline-flex items-center gap-3 text-xs text-muted">
      {kinds.has("coinglass") && <span className="inline-flex items-center gap-1.5">CoinGlass <StatusBadge s={s.scraper.status} /></span>}
      {kinds.has("exchange") && <span className="inline-flex items-center gap-1.5">Exchange data <StatusBadge s={s.exchangeData?.status ?? "DOWN"} /></span>}
    </span>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchInterval: 10_000, retry: 1, staleTime: 3000 } } }));
  return <QueryClientProvider client={qc}><Gate>{children}</Gate></QueryClientProvider>;
}

/**
 * Which queries an agent push event makes stale. Heavy views (analytics, source comparison, latency) are NOT here:
 * they refresh on their own slow interval. Refetching everything on every event kept the agent's CPU pinned.
 */
const EVENT_KEYS: Record<string, string[]> = {
  signal: ["signals", "cooldowns", "overview"],
  "trade:opened": ["overview", "trades", "cooldowns", "state"],
  "trade:updated": ["overview"],
  "trade:closed": ["overview", "trades", "cooldowns", "state"],
  "bot:status": ["bots", "state", "overview"],
  "scraper:status": ["state"],
  snapshot: ["state"],
  alert: ["state"],
};

/** Coalesces push events: each affected query refetches at most once per 2 s. */
function eventInvalidator(qc: QueryClient): (type: string) => void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (type) => {
    for (const k of EVENT_KEYS[type] ?? []) pending.add(k);
    if (timer || !pending.size) return;
    timer = setTimeout(() => {
      timer = null;
      const keys = [...pending];
      pending.clear();
      for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
    }, 2000);
  };
}

function Gate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const state = useAgent((s) => s.state);
  const hydrate = useView((s) => s.hydrate);
  useEffect(() => {
    hydrate();
    const theme = (() => { try { return localStorage.getItem("oisniper.theme"); } catch { return null; } })();
    if (theme && theme !== "system") document.documentElement.dataset.theme = theme;
    void connect(eventInvalidator(qc));
  }, [qc, hydrate]);
  if (state === "connected") return <Shell>{children}</Shell>;
  return <Onboarding />;
}

function Onboarding() {
  const { state, error, agentUrl, setUrl, setToken } = useAgent();
  const qc = useQueryClient();
  const [tok, setTok] = useState("");
  const retry = () => void connect(eventInvalidator(qc));
  return (
    <main className="mx-auto max-w-xl px-4 py-16 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">OI Sniper</h1>
        <p className="mt-1 text-muted">Local-first futures bot. The panel only talks to the agent on your device.</p>
      </div>
      {state === "init" || state === "connecting" ? (
        <Card><p className="text-sm text-muted">Looking for the local agent at {agentUrl}…</p></Card>
      ) : state === "unpaired" ? (
        <Card title="Pair with your agent">
          <p className="mb-3 text-sm text-muted">The agent printed a pairing link when it started. Open it, or paste the token here.</p>
          <div className="flex gap-2">
            <Input placeholder="pairing token" value={tok} onChange={(e) => setTok(e.target.value)} />
            <Button variant="primary" onClick={() => { setToken(tok.trim()); retry(); }}>Pair</Button>
          </div>
        </Card>
      ) : (
        <>
          {state === "blocked" && (
            <Card title="Allow local network access">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                <li>Your browser asked whether this site may reach devices on your local network. Choose <b>Allow</b>.</li>
                <li>If you dismissed it: click the site settings icon in the address bar, set <b>Local network access</b> to Allow, reload.</li>
                <li>Safari, or still blocked: use the panel served by the agent itself.</li>
              </ol>
            </Card>
          )}
          <Card title="OI Sniper is not running">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Open the <b>OI Sniper</b> folder on this computer.</li>
              <li>Double-click <b>Start OI Sniper</b> (on Mac: <b>Start OI Sniper.command</b>).</li>
              <li>Keep the window that opens running, then press <b>Retry</b>.</li>
            </ol>
            <p className="mt-2 text-xs text-muted">Your data, keys and scraping stay on this computer.</p>
            <p className="mt-3 text-xs text-muted">Last error: {error ?? "none"}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={retry}>Retry</Button>
              <a href="http://localhost:7777"><Button>Open panel locally</Button></a>
            </div>
            <div className="mt-4"><Input value={agentUrl} onChange={(e) => setUrl(e.target.value)} aria-label="Agent URL" /></div>
          </Card>
        </>
      )}
    </main>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const st = useQuery({ queryKey: ["state"], queryFn: () => api<StateResp>("/api/state") });
  const [confirmKill, setConfirmKill] = useState(false);
  const qc = useQueryClient();
  const s = st.data;
  return (
    <div className="min-h-screen">
      {s?.liveRunning && <div className="bg-live px-4 py-1.5 text-center text-xs font-semibold uppercase tracking-wider text-white">Live trading active: real orders with real money</div>}
      <header className="sticky top-0 z-30 border-b border-line/60 bg-bg/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2.5">
          <span className="font-semibold tracking-tight">OI Sniper</span>
          <HeaderModeToggle />
          <nav className="flex flex-1 gap-0.5 overflow-x-auto text-sm">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className={cx("whitespace-nowrap rounded-lg px-2.5 py-1", (href === "/" ? path === "/" : path?.startsWith(href.slice(0, -1))) ? "bg-line/60 font-medium" : "text-muted hover:text-fg")}>{label}</Link>
            ))}
          </nav>
          {s && <SourceBadges s={s} />}
          {confirmKill ? (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="danger" onClick={async () => { await api("/api/kill-switch", { method: "POST", json: { confirm: true } }); setConfirmKill(false); void qc.invalidateQueries(); }}>Close all + stop</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmKill(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmKill(true)} title="Stop all bots, cancel orders, market-close all positions">Kill switch</Button>
          )}
        </div>
      </header>
      {s?.killSwitch && <div className="bg-neg/15 px-4 py-1.5 text-center text-xs text-neg">Kill switch engaged. Start a bot to release it.</div>}
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
