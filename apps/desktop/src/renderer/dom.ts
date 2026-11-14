/** Tiny DOM helpers. All text goes through textContent: release notes and engine messages are never parsed as HTML. */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Line icons (24x24, stroke). Paths are constants in this file, never data. */
export function icon(paths: string[]): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    s.append(p);
  }
  return s;
}

export const ICONS = {
  overview: ["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"],
  signals: ["M3 12h4l3-8 4 16 3-8h4"],
  history: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  analytics: ["M4 20V11", "M10 20V5", "M16 20v-6", "M21 20H3"],
  exchanges: ["M7 7h13", "M17 4l3 3-3 3", "M17 17H4", "M7 14l-3 3 3 3"],
  health: ["M3 12h4l2-5 4 10 2-5h6"],
  settings: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M2 14h4", "M10 8h4", "M18 16h4"],
  updates: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6", "M12 8v5l3 2"],
  support: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4", "M12 17h.01"],
  about: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 8h.01"],
};

/** Release notes are Markdown from GitHub; only headings and bullet lists are shaped, everything else is plain text. */
export function notesView(md: string): HTMLElement {
  const root = h("div", { class: "notes" });
  let list: HTMLElement | null = null;
  for (const raw of md.split(/\r?\n/).slice(0, 80)) {
    const line = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "").trim();
    if (!line) {
      list = null;
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[*-]\s+(.*)$/.exec(line);
    if (head) {
      list = null;
      root.append(h("h4", {}, head[1]!));
    } else if (item) {
      if (!list) root.append((list = h("ul")));
      list.append(h("li", {}, item[1]!));
    } else {
      list = null;
      root.append(h("p", {}, line));
    }
  }
  return root;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtUptime(startedAt: number | null): string {
  if (!startedAt) return "—";
  const m = Math.floor((Date.now() - startedAt) / 60000);
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `${hrs} h ${m % 60} min` : `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}
