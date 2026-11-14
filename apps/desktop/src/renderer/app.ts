import type { AgentState, ShellApi, ShellState, ViewName } from "../shared/types";
import { fmtUptime, h, icon, ICONS } from "./dom";
import { aboutPage, supportPage, updatesPage, type VersionsCache } from "./pages";

declare global {
  interface Window {
    tradeMate: ShellApi;
  }
}

const api = window.tradeMate;
const $ = (id: string) => document.getElementById(id)!;
let state: ShellState | null = null;
const versions: VersionsCache = { items: null, error: null, loading: false };

const NAV: { view: ViewName; label: string; title: string; subtitle: string }[] = [
  { view: "panel", label: "Dashboard", title: "Dashboard", subtitle: "Bots, signals, positions and history" },
  { view: "updates", label: "Updates", title: "Updates", subtitle: "Versions, channel and rollback" },
  { view: "support", label: "Support", title: "Support", subtitle: "Engine status, logs and startup" },
  { view: "about", label: "About", title: "About", subtitle: "Versions and project" },
];

const TONE: Record<AgentState["status"], "ok" | "warn" | "bad" | ""> = {
  running: "ok",
  starting: "warn",
  restarting: "warn",
  stopping: "warn",
  stopped: "",
  error: "bad",
  conflict: "bad",
};
const LABEL: Record<AgentState["status"], string> = {
  running: "Engine running",
  starting: "Starting engine",
  restarting: "Restarting engine",
  stopping: "Stopping engine",
  stopped: "Engine stopped",
  error: "Engine error",
  conflict: "Engine blocked",
};

function render(s: ShellState): void {
  const prevView = state?.view;
  state = s;
  const meta = NAV.find((n) => n.view === s.view)!;
  $("title").textContent = meta.title;
  $("subtitle").textContent = meta.subtitle;

  const updateBadge = s.update.status === "available" || s.update.status === "downloaded";
  $("nav").replaceChildren(
    ...NAV.map((n) =>
      h(
        "button",
        { "aria-current": n.view === s.view ? "page" : undefined, onclick: () => void api.navigate(n.view) },
        icon(ICONS[n.view]),
        n.label,
        n.view === "updates" && updateBadge ? h("span", { class: "badge" }, "1") : null,
      ),
    ),
  );

  const tone = TONE[s.agent.status];
  $("engine-card").replaceChildren(
    h("div", { class: "row" }, h("span", { class: `dot ${tone}` }), LABEL[s.agent.status]),
    h("div", { class: "sub" }, s.agent.status === "running" ? `Up ${fmtUptime(s.agent.startedAt)} · 127.0.0.1:${s.agent.port}` : "Bots run only while the engine runs"),
  );
  $("version").textContent = `v${s.app.version} · ${s.settings.channel === "beta" ? "Beta" : "Stable"}${s.app.packaged ? "" : " · dev"}`;

  $("topbar-right").replaceChildren(
    updateBadge
      ? h("span", { class: "pill accent", role: "button", onclick: () => void api.navigate("updates") }, `Update ${s.update.availableVersion ?? ""} available`)
      : "",
    h("span", { class: `pill ${tone}` }, h("span", { class: `dot ${tone}` }), LABEL[s.agent.status]),
  );

  const onPanel = s.view === "panel";
  $("panel-host").hidden = !onPanel;
  const page = $("page");
  page.hidden = onPanel;
  if (onPanel) {
    $("panel-host").replaceChildren(s.agent.status === "running" ? "" : engineScreen(s.agent));
    reportBounds();
  } else {
    if (s.view === "updates" && prevView !== "updates" && !versions.loading) void loadVersions();
    page.replaceChildren(
      s.view === "updates" ? updatesPage(s, api, versions, () => void loadVersions()) : s.view === "support" ? supportPage(s, api) : aboutPage(s, api),
    );
  }
}

function engineScreen(a: AgentState): HTMLElement {
  if (a.status === "error" || a.status === "conflict")
    return h(
      "div",
      { class: "state" },
      h("div", { class: "icon-bad" }, "!"),
      h("h2", {}, a.status === "conflict" ? "The engine can't start yet" : "The engine stopped"),
      h("p", {}, a.message ?? "Something went wrong."),
      h(
        "div",
        { class: "actions", style: undefined },
        h("button", { class: "btn primary", onclick: () => void api.restartAgent() }, "Retry"),
        h("button", { class: "btn", onclick: () => void api.openLogsFolder() }, "Open logs"),
      ),
    );
  return h(
    "div",
    { class: "state" },
    h("div", { class: "spinner" }),
    h("h2", {}, a.status === "restarting" ? "Restarting the trading engine" : a.status === "stopping" ? "Stopping the trading engine" : "Starting the trading engine"),
    h("p", {}, a.message ?? "Loading markets and your bots. The first start can take a minute."),
  );
}

/** Tells the main process where the panel goes: the whole content area under the top bar. */
function reportBounds(): void {
  const r = $("content").getBoundingClientRect();
  api.setPanelBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}

async function loadVersions(): Promise<void> {
  versions.loading = true;
  if (state) render(state);
  const r = await api.listVersions();
  versions.items = r.items;
  versions.error = r.error;
  versions.loading = false;
  if (state) render(state);
}

new ResizeObserver(() => reportBounds()).observe($("content"));
api.onState((s) => {
  const channelChanged = state && state.settings.channel !== s.settings.channel;
  if (channelChanged) versions.items = null;
  render(s);
  if (channelChanged && s.view === "updates") void loadVersions();
});
setInterval(() => state && state.agent.status === "running" && state.view === "panel" && render(state), 60_000);
void api.getState().then(render);
