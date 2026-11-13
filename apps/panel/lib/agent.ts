"use client";
import { create } from "zustand";

/** Connection to the local agent. Only agentUrl + token live in localStorage; no data leaves the device. */
export type ConnState = "init" | "connecting" | "connected" | "unpaired" | "disconnected" | "blocked";

interface AgentStore {
  agentUrl: string;
  token: string | null;
  state: ConnState;
  error: string | null;
  lastEvent: number;
  setToken(t: string | null): void;
  setUrl(u: string): void;
  set(p: Partial<AgentStore>): void;
}

const DEFAULT_URL = "http://127.0.0.1:7777";
const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

export const useAgent = create<AgentStore>((set) => ({
  agentUrl: DEFAULT_URL,
  token: null,
  state: "init",
  error: null,
  lastEvent: 0,
  setToken: (t) => {
    ls.set("oisniper.token", t);
    set({ token: t });
  },
  setUrl: (u) => {
    ls.set("oisniper.agentUrl", u);
    set({ agentUrl: u });
  },
  set: (p) => set(p),
}));

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: unknown) {
    super(message);
  }
}

/** Chrome 142+/Brave gate public-site -> localhost behind a permission prompt; this option triggers it. */
const loopback = { targetAddressSpace: "loopback" } as RequestInit;

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { agentUrl, token } = useAgent.getState();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(agentUrl + path, { ...loopback, ...init, headers, body });
  if (res.status === 401) {
    useAgent.getState().set({ state: "unpaired" });
    throw new ApiError(401, "UNAUTHORIZED", "Not paired with the agent");
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const j = ct.includes("json") ? ((await res.json()) as { error?: string; message?: string; issues?: unknown }) : {};
    throw new ApiError(res.status, j.error ?? "ERROR", j.message ?? res.statusText, j.issues);
  }
  if (ct.includes("application/zip")) return (await res.blob()) as T;
  return (await res.json()) as T;
}

let ws: WebSocket | null = null;

/**
 * Startup: read pairing from #pair= (fragment: never sent to the server, so the token cannot reach Vercel's logs;
 * ?pair= still accepted for the localhost-served panel), detect same-origin agent, probe /health, open the WS.
 */
export async function connect(onEvent: (type: string) => void): Promise<void> {
  const st = useAgent.getState();
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const pair = hash.get("pair") ?? url.searchParams.get("pair");
  if (pair) {
    st.setToken(pair);
    url.searchParams.delete("pair");
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
  } else if (!st.token) st.set({ token: ls.get("oisniper.token") });
  const savedUrl = ls.get("oisniper.agentUrl");
  // Served by the agent itself (any port, e.g. OISNIPER_PORT): talk to that origin. Port 3000 is the Next dev server.
  const sameOrigin = /^(localhost|127\.0\.0\.1)$/.test(url.hostname) && url.port !== "3000";
  useAgent.getState().set({ agentUrl: sameOrigin ? url.origin : savedUrl ?? DEFAULT_URL, state: "connecting" });
  try {
    const r = await fetch(useAgent.getState().agentUrl + "/health", { ...loopback, cache: "no-store" });
    if (!r.ok) throw new Error(`health ${r.status}`);
  } catch (e) {
    const blocked = !sameOrigin && window.location.protocol === "https:";
    useAgent.getState().set({ state: blocked ? "blocked" : "disconnected", error: String((e as Error).message) });
    return;
  }
  if (!useAgent.getState().token) return useAgent.getState().set({ state: "unpaired" });
  try {
    await api("/api/state");
  } catch {
    return;
  }
  useAgent.getState().set({ state: "connected", error: null });
  openWs(onEvent);
}

function openWs(onEvent: (type: string) => void) {
  const { agentUrl, token } = useAgent.getState();
  if (!token) return;
  ws?.close();
  ws = new WebSocket(agentUrl.replace(/^http/, "ws") + "/ws");
  ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token })); // token in first message, never in the URL
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(String(m.data)) as { type: string };
      useAgent.getState().set({ lastEvent: Date.now() });
      onEvent(msg.type);
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    ws = null;
    setTimeout(async () => {
      try {
        await fetch(useAgent.getState().agentUrl + "/health", loopback);
        if (useAgent.getState().state === "connected") openWs(onEvent);
      } catch {
        useAgent.getState().set({ state: "disconnected" });
      }
    }, 2000);
  };
}
