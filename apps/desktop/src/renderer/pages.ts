import type { ShellApi, ShellState, VersionItem } from "../shared/types";
import { fmtAgo, fmtDate, fmtUptime, h, notesView } from "./dom";

export interface VersionsCache {
  items: VersionItem[] | null;
  error: string | null;
  loading: boolean;
}

const UPDATE_TEXT: Record<ShellState["update"]["status"], string> = {
  idle: "Not checked yet.",
  dev: "Development build: updates are checked only in the installed app.",
  checking: "Checking for updates…",
  "up-to-date": "You have the latest version for this channel.",
  available: "A new version is available.",
  downloading: "Downloading…",
  downloaded: "Downloaded and verified. Ready to install.",
  installing: "Installing…",
  error: "Update check failed.",
};

export function updatesPage(s: ShellState, api: ShellApi, versions: VersionsCache, reloadVersions: () => void): HTMLElement {
  const u = s.update;
  const busy = u.status === "checking" || u.status === "downloading" || u.status === "installing";
  const main: HTMLElement[] = [];
  if (u.status === "available" && u.availableVersion)
    main.push(h("button", { class: "btn primary", onclick: () => void api.downloadUpdate() }, u.inPlaceInstall ? `Download ${u.availableVersion}` : `Download ${u.availableVersion} (.dmg)`));
  if (u.status === "downloaded" && u.inPlaceInstall)
    main.push(h("button", { class: "btn primary", onclick: () => void api.installUpdate() }, `Restart and install ${u.availableVersion ?? ""}`));
  main.push(h("button", { class: "btn", disabled: busy || u.status === "dev", onclick: () => void api.checkForUpdates() }, "Check now"));

  const current = h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("div", {}, h("h2", {}, `Trade Mate ${s.app.version}`), h("p", { class: "muted" }, UPDATE_TEXT[u.status])),
      channelSwitch(s, api),
    ),
    u.progress != null && u.status === "downloading" ? progressBar(u.progress) : null,
    u.error ? h("p", { class: "error-text" }, u.error) : null,
    h("div", { class: "actions" }, ...main),
    h(
      "p",
      { class: "note" },
      `Last checked ${fmtAgo(u.lastCheckedAt)}. Updates never install by themselves. ` +
        (s.settings.channel === "stable" ? "Stable gets versions after they are approved." : "Beta gets new versions first, before they are approved for everyone."),
    ),
  );

  const history = h("div", { class: "card" }, h("div", { class: "card-head" }, h("div", {}, h("h2", {}, "Version history"), h("p", { class: "muted" }, "Install any listed version to roll back if an update causes a problem. Bots, settings and trade history are kept.")), h("button", { class: "btn", disabled: versions.loading, onclick: reloadVersions }, "Refresh")));
  if (versions.loading && !versions.items) history.append(h("p", { class: "note" }, "Loading versions…"));
  else if (versions.error) history.append(h("p", { class: "error-text" }, versions.error));
  else if (versions.items && versions.items.length === 0) history.append(h("p", { class: "note" }, "No published versions yet."));
  else if (versions.items) history.append(h("div", { class: "versions" }, ...versions.items.map((v) => versionRow(v, api))));

  return h("div", { class: "page-inner" }, current, history);
}

/** Width set through CSSOM: the page CSP has no 'unsafe-inline', so style="" attributes would be blocked. */
function progressBar(pct: number): HTMLElement {
  const fill = h("div");
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return h("div", { class: "progress" }, fill);
}

function channelSwitch(s: ShellState, api: ShellApi): HTMLElement {
  const b = (c: "stable" | "beta", label: string) =>
    h("button", { "aria-pressed": String(s.settings.channel === c), onclick: () => void api.setChannel(c) }, label);
  return h("div", { class: "seg", role: "group", "aria-label": "Update channel" }, b("stable", "Stable"), b("beta", "Beta"));
}

function versionRow(v: VersionItem, api: ShellApi): HTMLElement {
  return h(
    "div",
    { class: "ver" },
    h(
      "div",
      { class: "ver-head" },
      h("span", { class: "name" }, v.title),
      v.isCurrent ? h("span", { class: "tag current" }, "Installed") : null,
      v.isNewer ? h("span", { class: "tag newer" }, "Newer") : null,
      v.channel === "beta" ? h("span", { class: "tag beta" }, "Beta") : null,
      h("span", { class: "muted" }, fmtDate(v.publishedAt)),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => void api.openExternal(v.url) }, "Details"),
      v.installable ? h("button", { class: "btn", onclick: () => void api.installVersion(v.version) }, v.isNewer ? "Install" : "Roll back to this") : null,
    ),
    v.notes ? notesView(v.notes) : null,
  );
}

export function supportPage(s: ShellState, api: ShellApi): HTMLElement {
  const a = s.agent;
  const stat = (k: string, v: string) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  const engine = h(
    "div",
    { class: "card" },
    h("h2", {}, "Trading engine"),
    h("p", { class: "muted" }, "The engine runs on this computer only. Keys, balances and trades never leave it."),
    h(
      "div",
      { class: "grid" },
      stat("Status", a.status),
      stat("Uptime", a.status === "running" ? fmtUptime(a.startedAt) : "—"),
      stat("Engine version", a.engineVersion ?? "—"),
      stat("Local address", `127.0.0.1:${a.port}`),
      stat("Process", a.pid ? String(a.pid) : "—"),
      stat("Automatic restarts", String(a.restarts)),
    ),
    a.message ? h("p", { class: a.status === "error" || a.status === "conflict" ? "error-text" : "note" }, a.message) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", onclick: () => void api.restartAgent() }, "Restart engine"),
      h("button", { class: "btn", onclick: () => void api.openDataFolder() }, "Open data folder"),
      h("button", { class: "btn", onclick: () => void api.openLogsFolder() }, "Open logs"),
      h("button", { class: "btn", onclick: (e) => copy(e, api) }, "Copy diagnostics"),
    ),
    h("p", { class: "note" }, "Diagnostics hold versions and status only, no keys or tokens. Paste them when you report a problem."),
  );
  const startup = h(
    "div",
    { class: "card" },
    h(
      "label",
      { class: "toggle" },
      h("div", {}, h("h3", {}, "Open Trade Mate when I sign in"), h("p", { class: "note" }, "Starts in the background so the engine is running after a restart of the computer.")),
      h("input", { type: "checkbox", checked: s.settings.launchAtLogin, onchange: (e) => void api.setLaunchAtLogin((e.target as HTMLInputElement).checked) }),
    ),
  );
  return h("div", { class: "page-inner" }, engine, startup);
}

function copy(e: Event, api: ShellApi): void {
  const btn = e.currentTarget as HTMLButtonElement;
  void api.copyDiagnostics().then(() => {
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy diagnostics"), 1500);
  });
}

export function aboutPage(s: ShellState, api: ShellApi): HTMLElement {
  const row = (k: string, v: string) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  return h(
    "div",
    { class: "page-inner" },
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Trade Mate"),
      h("p", { class: "muted" }, "Desktop app for the OI Sniper crypto futures bot. Everything runs locally on this computer."),
      h(
        "div",
        { class: "grid" },
        row("App version", s.app.version),
        row("Engine version", s.agent.engineVersion ?? "—"),
        row("Update channel", s.settings.channel),
        row("System", `${s.app.platform} ${s.app.arch}`),
        row("Electron", s.app.electron),
        row("Chromium", s.app.chrome),
      ),
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => void api.openExternal("https://github.com/sufianweb3/trade-mate") }, "Project on GitHub")),
    ),
  );
}
