import { isAgentUrl } from "./urlGuard";

/** The OI Sniper panel pages shown in the Trade Mate sidebar, and the panel route each one opens. */
export type PanelView = "overview" | "signals" | "history" | "analytics" | "exchanges" | "health" | "settings";

export const PANEL_ROUTES: Record<PanelView, string> = {
  overview: "/",
  signals: "/signals/",
  history: "/history/",
  analytics: "/analytics/",
  exchanges: "/exchanges/",
  health: "/health/",
  settings: "/settings/",
};

export const PANEL_VIEWS = Object.keys(PANEL_ROUTES) as PanelView[];

export function routeFor(view: PanelView): string {
  return PANEL_ROUTES[view];
}

/** Which sidebar item a panel URL belongs to (null for anything that is not the local agent's panel page). */
export function viewForUrl(url: string, port: number): PanelView | null {
  if (!isAgentUrl(url, port)) return null;
  const path = new URL(url).pathname;
  if (path === "/" || path === "") return "overview";
  return PANEL_VIEWS.find((v) => v !== "overview" && path.startsWith(PANEL_ROUTES[v])) ?? null;
}

/** After the panel (re)loads: the item clicked while it was not ready wins, else where it is, else Overview. */
export function nextRoute(pending: PanelView | null, loaded: PanelView | null): PanelView {
  return pending ?? loaded ?? "overview";
}
