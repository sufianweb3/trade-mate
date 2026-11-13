// Scripts evaluated inside the CoinGlass page. Strings (not functions) so the agent needs no DOM types.
// Every result is zod-parsed by the caller; nothing here is trusted.

/** Read the largest table: Ant Design sticky-header tables first (header and body are separate <table>s). */
export const EXTRACT_SCRIPT = `(() => {
  const txt = (el) => (el.textContent || "").trim();
  let best = { headers: [], rows: [] };
  for (const w of Array.from(document.querySelectorAll(".ant-table"))) {
    const ths = Array.from(w.querySelectorAll(".ant-table-header th, thead th")).map(txt);
    const rows = Array.from(w.querySelectorAll("tr.ant-table-row")).map((tr) => Array.from(tr.querySelectorAll("td")).map(txt));
    if (rows.length > best.rows.length && ths.length) best = { headers: ths, rows };
  }
  if (best.rows.length) return best;
  for (const t of Array.from(document.querySelectorAll("table"))) {
    const ths = Array.from(t.querySelectorAll("thead th")).map(txt);
    const rows = Array.from(t.querySelectorAll("tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).map(txt));
    if (rows.length > best.rows.length) best = { headers: ths, rows };
  }
  return best;
})()`;

/**
 * Watch the table for changes (CoinGlass pushes updates). window.__oisV counts changes, window.__oisT is the time of
 * the last one (source_data_ts). Idempotent: re-attaches if the table element was replaced.
 */
export const OBSERVE_SCRIPT = `(() => {
  const body = document.querySelector(".ant-table-body tbody, .ant-table-tbody, table tbody");
  if (!body) return false;
  if (window.__oisBody === body) return true;
  window.__oisBody = body;
  window.__oisV = (window.__oisV || 0) + 1;
  window.__oisT = Date.now();
  new MutationObserver(() => { window.__oisV++; window.__oisT = Date.now(); }).observe(body, { subtree: true, characterData: true, childList: true });
  return true;
})()`;

export const CHANGE_STATE_SCRIPT = `({ v: window.__oisV || 0, t: window.__oisT || 0 })`;

/** Logged in when no "Login" / "Log in" / "Sign in" button is shown in the header. */
export const LOGIN_STATE_SCRIPT = `(() => !Array.from(document.querySelectorAll("button, a")).some((b) => /^(log ?in|sign ?in)$/i.test((b.textContent || "").trim())))()`;

/** Columns the PRD collects (PRD 5.1). CoinGlass hides most of them by default. */
export const WANTED_COLUMNS = [
  "Price Change (5m)", "Price Change (15m)", "Price Change (1h)", "Price Change (4h)", "Price Change (24h)",
  "Funding Rate", "OI",
  "OI Change (5m)", "OI Change (15m)", "OI Change (30m)", "OI Change (1h)", "OI Change (4h)", "OI Change (24h)",
  "Volume (5m)", "Volume (1h)", "Volume (4h)", "Volume (24h)", "Volume (1h%)", "Volume (4h%)", "Volume (24h%)",
  "Long/Short",
];

/**
 * Open "Customize", select every wanted column chip that is not selected yet, Save.
 * CoinGlass stores the choice in the browser profile, so this normally runs once.
 * Returns how many chips were toggled, or -1 when the dialog was not found.
 */
export const ensureColumnsScript = (labels: string[]) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Customize");
  if (!btn) return -1;
  btn.click();
  await wait(1200);
  const labels = ${JSON.stringify(labels)};
  let toggled = 0;
  for (const l of labels) {
    const leaf = Array.from(document.querySelectorAll(".MuiChip-label div, .MuiChip-label")).find((e) => e.textContent.trim() === l);
    const chip = leaf && leaf.closest(".MuiChip-root");
    if (chip && !/colorPrimary/.test(chip.className)) { chip.click(); toggled++; await wait(60); }
  }
  const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Save");
  if (!save) return -1;
  save.click();
  await wait(1500);
  return toggled;
})()`;

/** Sort the table by OI change 5m, descending (strongest OI movers first). Returns true when sorted. */
export const SORT_OI5M_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) {
    const th = Array.from(document.querySelectorAll(".ant-table-header th")).find((t) => /^OI.*5m/i.test(t.textContent.trim()) && !/\\$/.test(t.textContent));
    if (!th) return false;
    if (th.getAttribute("aria-sort") === "descending") return true;
    (th.querySelector(".ant-table-column-sorters") || th).click();
    await wait(1200);
  }
  return false;
})()`;

/** Click page n of the table pagination. Returns true when a page link was clicked. */
export const gotoPageScript = (n: number) => `(async () => {
  const roots = Array.from(document.querySelectorAll("[class*=pagination], [class*=Pagination]"));
  for (const r of roots) {
    const el = Array.from(r.querySelectorAll("li, button, a")).find((e) => e.textContent.trim() === "${n}");
    if (el) { el.click(); await new Promise((res) => setTimeout(res, 1500)); return true; }
  }
  return false;
})()`;
