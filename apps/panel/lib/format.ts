/** UI edge: decimal strings become numbers only here, for display. */
export const n = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

export function usd(v: string | number | null | undefined, signed = false, dp = 2): string {
  const x = n(v);
  if (x == null) return "—";
  const s = Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sign = x > 0 ? "+" : x < 0 ? "−" : "";
  return signed ? `${sign}$${s}` : `${x < 0 ? "−" : ""}$${s}`;
}

export function pct(v: string | number | null | undefined, dp = 2, signed = true): string {
  const x = n(v);
  if (x == null) return "—";
  const sign = signed ? (x > 0 ? "+" : x < 0 ? "−" : "") : x < 0 ? "−" : "";
  return `${sign}${Math.abs(x).toFixed(dp)}%`;
}

export function price(v: string | number | null | undefined): string {
  const x = n(v);
  if (x == null) return "—";
  const a = Math.abs(x);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 10;
  return x.toFixed(dp).replace(/(\.\d*?[1-9])0+$/, "$1");
}

export const tone = (v: string | number | null | undefined) => {
  const x = n(v);
  return x == null || x === 0 ? "text-muted" : x > 0 ? "text-pos" : "text-neg";
};

export const time = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

export function dur(sec: number | null | undefined): string {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}
