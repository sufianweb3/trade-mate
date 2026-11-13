import { BOT1_PRESET, D } from "@oisniper/core";
import { strFromU8, unzipSync } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "../app";
import { buildServer } from "../api/server";
import { TRADE_DICTIONARY } from "../export/dictionary";
import { buildExport } from "../export/exportPack";
import { createLogger, setLogger, log } from "../log";
import type { Harness } from "./harness";

/** Agent crash with positions open: persistence, reconcile, downtime replay. */
export async function restart(h: Harness, dbFile: string): Promise<Harness> {
  h.begin("S16 Agent killed with positions open, price hits SL while down, restart");
  const btc = h.trades("paper", "BTC", { status: "open" })[0];
  const openBefore = h.bot("paper").pm.openCount();
  const cooldownBefore = h.app.store.lastEntry("paper", "SOL");
  await h.app.stop();
  // Agent is down for 10 minutes; BTC trades through its stop meanwhile.
  h.hub.path("BTC", [[120_000, h.price("BTC") * 0.993], [600_000, h.price("BTC") * 0.995]]);
  await h.clock.advance(600_000);
  const app = new App({ ...h.app.o, dbFile });
  // Startup resolves downtime fills, which wait on (virtual) latency: keep the clock moving meanwhile.
  let started = false;
  const p = app.start({ scraper: true }).finally(() => (started = true));
  while (!started) await h.clock.advance(200);
  await p;
  h.app = app;
  await h.wait(5_000);
  const btcAfter = btc ? app.store.records.getTrade(btc.trade_id) : null;
  h.check("cooldown table persisted across restart", app.store.lastEntry("paper", "SOL") === cooldownBefore && cooldownBefore != null);
  h.check("downtime replay closed BTC by its stop", btcAfter?.exit.reason === "SL", { reason: btcAfter?.exit.reason, status: btcAfter?.status });
  const still = h.bot("paper").pm.openTrades();
  h.check("other positions resumed and re-protected", still.length === openBefore - 1 && still.every((t) => h.events(t.trade_id).some((e) => e.type === "RECONCILE") && h.events(t.trade_id).filter((e) => e.type === "SL_PLACED").length >= 2), still.map((t) => t.symbol));
  h.check("paper balance persisted", D(h.bot("paper").run().cash!).gt(0), { cash: h.bot("paper").run().cash });
  h.check("all bots come back Stopped after restart (never auto-start)", [...app.bots.bots.values()].every((b) => b.row().status === "stopped" && b.row().running === 0), [...app.bots.bots.values()].map((b) => `${b.id}:${b.row().status}`));
  h.check("open positions still managed while stopped", h.bot("paper").pm.openCount() > 0 && h.bot("test").pm.openCount() > 0);
  await h.bot("paper").start();
  await h.bot("test").start();
  return h;
}

export async function evening(h: Harness, outDir: string): Promise<void> {
  h.begin("S17 Scraper resilience: reordered columns, missing column, challenge");
  h.src.reverseColumns = true;
  await h.nextScrape();
  const snap = h.app.scraper.latestSnapshot();
  const sol = snap?.rows.find((r) => r.symbol === "SOL");
  h.check("reordered columns still map by header text", h.app.scraper.state.status === "OK" && sol?.price != null && Math.abs(sol.price - h.price("SOL")) / h.price("SOL") < 0.01 && sol.vol_chg_1h != null, { status: h.app.scraper.state.status, price: sol?.price, vol_chg_1h: sol?.vol_chg_1h });
  h.src.reverseColumns = false;
  h.src.dropColumns.add("oi_chg_4h"); // required: an enabled Test rule metric, not used by Paper
  h.pump("ETH");
  h.pump("AVAX");
  await h.nextScrape();
  h.check("missing required column -> DEGRADED", h.app.scraper.state.status === "DEGRADED" && (h.app.scraper.state.lastHealth?.missingColumns ?? []).includes("oi_chg_4h"), h.app.scraper.state.reason);
  h.check("missing metric stored as null, never 0", h.app.scraper.latestSnapshot()?.rows.every((r) => r.oi_chg_4h === null) === true);
  const deg = h.lastSignal("paper", "AVAX");
  h.check("entries paused while degraded (logged SCRAPER_DEGRADED)", deg?.reject_reasons.includes("SCRAPER_DEGRADED") === true, deg?.reject_reasons);
  h.src.dropColumns.clear();
  h.quiet("ETH");
  h.quiet("AVAX");
  h.src.challenge = true;
  await h.nextScrape();
  h.check("Cloudflare challenge reported", h.app.scraper.state.status === "CHALLENGE", h.app.scraper.state.reason);
  h.src.challenge = false;
  await h.nextScrape();
  h.check("recovers to OK", h.app.scraper.state.status === "OK");

  h.begin("S18 Kill switch");
  const openNow = h.app.bots.openCount();
  const r = await h.during(h.app.bots.killAll());
  await h.wait(3_000);
  const killed = h.app.store.records.listTrades({ status: "closed" }).filter((t) => t.exit.reason === "KILL_SWITCH");
  h.check("all positions market-closed", h.app.bots.openCount() === 0 && r.closed === openNow && killed.length === openNow, { before: openNow, closed: r.closed });
  h.check("all bots stopped", [...h.app.bots.bots.values()].every((b) => b.row().status === "stopped"), [...h.app.bots.bots.values()].map((b) => `${b.id}:${b.row().status}/${b.row().status_reason}`));
  await h.wait(61 * 60_000);
  h.check("still stopped after the loss-streak pause window (kill losses never revive a bot)", [...h.app.bots.bots.values()].every((b) => b.row().status === "stopped" && b.row().running === 0));
  h.pump("ETH");
  await h.nextScrape();
  h.quiet("ETH");
  h.check("no new entries after kill", h.app.bots.openCount() === 0);

  h.begin("S19 Paper reset archives the run");
  const b1 = h.bot("paper");
  const oldRun = b1.run().id;
  const nOld = h.trades("paper").length;
  const newRun = await h.during(b1.resetRun());
  h.check("new run with fresh $500", newRun.id !== oldRun && newRun.cash === "500" && h.app.store.getRun(oldRun)?.archived === 1);
  h.check("history kept", h.trades("paper").length === nOld, { trades: nOld });

  h.begin("S20 AI Analysis Pack export");
  mkdirSync(outDir, { recursive: true });
  for (const bot of ["paper", "test"]) {
    const ex = await buildExport(h.app.store, { botId: bot }, h.clock.now());
    writeFileSync(join(outDir, ex.fileName), ex.bytes);
    const files = unzipSync(ex.bytes);
    const names = Object.keys(files).sort();
    h.check(`${bot}: zip has the 8 files`, names.join(",") === ["ANALYSIS_PROMPT.md", "DATA_DICTIONARY.md", "signals.csv", "signals.jsonl", "strategy_versions.json", "summary.json", "trades.csv", "trades.jsonl"].join(","), names);
    const csv = strFromU8(files["trades.csv"]!).trim().split("\n");
    h.check(`${bot}: trades.csv columns = data dictionary`, csv[0] === TRADE_DICTIONARY.map((d) => d.field).join(","), `${csv[0]!.split(",").length} columns, ${csv.length - 1} rows`);
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    h.check(`${bot}: no secrets in export`, !all.includes("demo-passphrase-not-secret") && !all.includes("SECRETSECRET"));
    const sum = JSON.parse(strFromU8(files["summary.json"]!)) as { kpis: { trades: number } };
    h.check(`${bot}: summary KPIs present`, sum.kpis.trades > 0, sum.kpis);
    h.note(`  wrote ${join(outDir, ex.fileName)}`);
  }

  h.begin("S21 Local API: auth, CORS + private network, validation, key redaction");
  const lines: string[] = [];
  const prevLog = log;
  setLogger(createLogger({ level: "debug", sink: { write: (s) => lines.push(s) } }));
  const srv = await buildServer(h.app, { port: 0, panelDir: null, allowedOrigins: ["https://oisniper.vercel.app"] });
  await srv.listen({ host: "127.0.0.1", port: 0 });
  const addr = srv.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const tok = h.app.token();
  const auth = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  try {
    h.check("GET /health open", (await fetch(`${base}/health`)).status === 200);
    h.check("API without token -> 401", (await fetch(`${base}/api/state`)).status === 401);
    h.check("API with wrong token -> 401", (await fetch(`${base}/api/state`, { headers: { authorization: "Bearer nope" } })).status === 401);
    h.check("API with token -> 200", (await fetch(`${base}/api/state`, { headers: auth })).status === 200);
    const pre = await fetch(`${base}/api/state`, { method: "OPTIONS", headers: { origin: "https://oisniper.vercel.app", "access-control-request-method": "GET", "access-control-request-private-network": "true" } });
    h.check("preflight answers Access-Control-Allow-Private-Network", pre.status === 204 && pre.headers.get("access-control-allow-private-network") === "true");
    const bad = await fetch(`${base}/api/state`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    h.check("unknown origin refused", bad.status === 403 && !bad.headers.get("access-control-allow-origin"));
    const cfg = { ...BOT1_PRESET, exits: { ...BOT1_PRESET.exits, basis: "price" } };
    const v = await fetch(`${base}/api/bots/paper/config`, { method: "PUT", headers: auth, body: JSON.stringify(cfg) });
    const vb = (await v.json()) as { error?: string; message?: string };
    h.check("config with SL beyond liquidation cannot be saved", v.status === 400 && /liquidation/i.test(vb.message ?? ""), vb.message);
    const secret = "SECRETSECRET-abcdef-123456";
    const k = await fetch(`${base}/api/exchanges/okx/keys`, { method: "POST", headers: auth, body: JSON.stringify({ apiKey: "OKXKEY-1234567890", secret, testnet: true }) });
    const kt = await k.text();
    h.check("key response is masked and never echoes the secret", !kt.includes(secret) && kt.includes("OKXK••••7890"), kt.slice(0, 160));
    const blob = h.app.vault.encrypt({ apiKey: "BINKEY-0987654321", secret });
    h.app.vault.decrypt(blob); // registers the secret with the log scrubber, as on real use
    log.info({ apiSecret: secret, note: `leak attempt ${secret}` }, `message with ${secret}`);
    h.check("secret never appears in logs", lines.length > 0 && !lines.join("\n").includes(secret), lines.at(-1)?.slice(0, 200));
    const views: Record<string, { botId: string; mode: string; kpis: { trades: number } }[]> = {};
    for (const v of ["paper", "real", "test"]) views[v] = (await (await fetch(`${base}/api/overview?bot=${v}`, { headers: auth })).json()) as never;
    h.check("Paper / Real / Test views each return only their own account", ["paper", "real", "test"].every((v) => views[v]!.length === 1 && views[v]![0]!.botId === v) && views.real![0]!.mode === "live" && views.paper![0]!.mode === "paper", Object.fromEntries(Object.entries(views).map(([k, x]) => [k, `${x[0]?.botId}/${x[0]?.mode}/${x[0]?.kpis.trades} trades`])));
    const tp = (await (await fetch(`${base}/api/trades?bot=paper`, { headers: auth })).json()) as { bot_id: string }[];
    const tr = (await (await fetch(`${base}/api/trades?bot=real`, { headers: auth })).json()) as { bot_id: string }[];
    h.check("History is separated per account (no Paper trades in Real)", tp.length > 0 && tp.every((t) => t.bot_id === "paper") && tr.every((t) => t.bot_id === "real"), { paper: tp.length, real: tr.length });
    const cds = (await (await fetch(`${base}/api/bots/paper/cooldowns`, { headers: auth })).json()) as { symbol: string; remainingMs: number | null }[];
    h.check("cooldown endpoint lists remaining time per symbol", Array.isArray(cds), cds.slice(0, 3));
    const an = (await (await fetch(`${base}/api/analytics?bot=test`, { headers: auth })).json()) as { variantMatrix: unknown[] };
    h.check("Bot 2 variant matrix served", an.variantMatrix.length >= 15, `${an.variantMatrix.length} cells`);
    const zip = await fetch(`${base}/api/export`, { method: "POST", headers: auth, body: JSON.stringify({ botId: "test" }) });
    h.check("export download over API", zip.status === 200 && zip.headers.get("content-type") === "application/zip");
  } finally {
    await srv.close();
    setLogger(prevLog);
  }
}
