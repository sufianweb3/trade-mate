import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { App } from "../src/app";
import { buildWorld, pumpMetrics } from "../src/demo/world";
import { SIGNAL_DICTIONARY, TRADE_DICTIONARY } from "../src/export/dictionary";
import { buildExport, signalExportRow, tradeExportRow } from "../src/export/exportPack";
import { createLogger, redact, registerSecret } from "../src/log";
import { VirtualClock } from "../src/util/clock";

const tmp = () => join(mkdtempSync(join(tmpdir(), "oisniper-")), "t.db");

async function world() {
  const db = tmp();
  const clock = new VirtualClock();
  const w = buildWorld(db, clock);
  w.app.store.setSetting("warm_set_size", 0);
  await w.app.start();
  await w.app.bots.get("paper").start();
  return { ...w, clock, db };
}

describe("engine end to end (paper)", () => {
  it("cooldown: open position blocks, 12h window, persisted across restart", async () => {
    const { app, src, clock, hub, db } = await world();
    src.set("SOL", pumpMetrics(182.5));
    await clock.advance(31_000);
    const b1 = app.bots.get("paper");
    expect(b1.pm.openCount()).toBe(1);
    src.quiet("SOL", 182.5);
    await clock.advance(31_000);
    src.set("SOL", pumpMetrics(182.5));
    await clock.advance(31_000);
    expect(app.store.records.listSignals({ botId: "paper" })[0]!.reject_reasons).toEqual(["COOLDOWN", "OPEN_POSITION"]);
    const entry = app.store.lastEntry("paper", "SOL");
    expect(entry).not.toBeNull();
    // restart
    await app.stop();
    const app2 = new App({ ...app.o, dbFile: db });
    let started = false;
    const p = app2.start().finally(() => (started = true));
    while (!started) await clock.advance(200);
    await p;
    expect(app2.store.lastEntry("paper", "SOL")).toBe(entry);
    expect(app2.bots.get("paper").pm.openCount()).toBe(1);
    expect(app2.bots.get("paper").row().status).toBe("stopped"); // never auto-start
    await app2.bots.get("paper").start();
    // close it, then a non-consecutive re-match inside 12h is cooldown
    hub.jump("SOL", 180);
    await clock.advance(5_000);
    src.quiet("SOL", 180);
    await clock.advance(31_000);
    src.set("SOL", pumpMetrics(180));
    await clock.advance(31_000);
    expect(app2.store.records.listSignals({ botId: "paper" })[0]!.reject_reasons).toEqual(["COOLDOWN"]);
    await app2.stop();
  });

  it("export columns are exactly the data dictionary, every trade field documented", async () => {
    const { app, src, clock } = await world();
    src.set("SOL", pumpMetrics(182.5));
    await clock.advance(31_000);
    const t = app.store.records.listTrades({ botId: "paper" })[0]!;
    const keys = Object.keys(tradeExportRow(t));
    const dict = new Set(TRADE_DICTIONARY.map((d) => d.field));
    expect(keys.filter((k) => !dict.has(k))).toEqual([]);
    const sig = app.store.records.listSignals({ botId: "paper" })[0]!;
    const sdict = new Set(SIGNAL_DICTIONARY.map((d) => d.field));
    expect(Object.keys(signalExportRow(sig)).filter((k) => !sdict.has(k) && !k.startsWith("counterfactual"))).toEqual([]);
    const zip = unzipSync((await buildExport(app.store, { botId: "paper" }, clock.now())).bytes);
    expect(strFromU8(zip["trades.csv"]!).split("\n")[0]).toBe(TRADE_DICTIONARY.map((d) => d.field).join(","));
    // full signals (with every variant's gates) ship as JSONL; the slim list view drops them
    const full = strFromU8(zip["signals.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l) as { signal_id: string; gate_results: unknown[] });
    expect(full.find((s) => s.signal_id === sig.signal_id)?.gate_results.length).toBe(sig.gate_results.length);
    const slim = app.store.records.listSignalsSlim({ botId: "paper" }).find((s) => s.signal_id === sig.signal_id)!;
    expect(slim.gate_results).toEqual([]);
    expect(slim.metrics).toEqual(sig.metrics);
    expect(app.store.records.getSignalFull(sig.signal_id)?.gate_results).toEqual(sig.gate_results);
    await app.stop();
  });
});

describe("Test grid: re-entry every 15 min while positions are open", () => {
  it("opens a second grid on the same coin 15 min after the first entry, not before", async () => {
    const w = await world();
    await w.app.bots.get("paper").stop();
    const test = w.app.bots.get("test");
    expect(test.config().leverages).toEqual([5, 10, 15, 20, 30, 50]);
    await test.start();
    const sigs = () => w.app.store.records.listSignals({ botId: "test" }).filter((s) => s.symbol === "SOL");
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    expect(sigs()[0]!.status).toBe("opened");
    const first = test.pm.openTrades().filter((t) => t.symbol === "SOL").length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(30);
    // quiet one scrape, then a fresh match 1 min after entry: inside the 15 min entry window
    w.src.quiet("SOL", 182.5);
    await w.clock.advance(31_000);
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    expect(sigs()[0]!.status).toBe("cooldown");
    expect(sigs()[0]!.reject_reasons).toEqual(["COOLDOWN"]); // never OPEN_POSITION for this bot
    expect(sigs()[0]!.cooldown?.cause).toBe("entry");
    w.src.quiet("SOL", 182.5);
    w.hub.setTickMs(5_000);
    await w.clock.advance(14 * 60_000);
    w.hub.setTickMs(500);
    const openBefore = test.pm.openTrades().filter((t) => t.symbol === "SOL").length;
    w.src.set("SOL", pumpMetrics(w.hub.refPrice("SOL", w.clock.now())));
    await w.clock.advance(31_000);
    expect(sigs()[0]!.status).toBe("opened");
    expect(sigs().filter((s) => s.status === "opened")).toHaveLength(2);
    expect(test.pm.openTrades().filter((t) => t.symbol === "SOL").length).toBeGreaterThan(openBefore);
    // $100 per position, rounded down to the lot step (never up)
    expect(w.app.store.records.listTrades({ botId: "test" }).every((t) => Number(t.config.margin) <= 100 && Number(t.config.margin) > 99)).toBe(true);
    await w.app.stop();
  }, 120_000);
});

describe("adaptive entry (leverage fit)", () => {
  const SOL = "SOL/USDT:USDT";
  async function lowLeverageWorld(adaptive: boolean) {
    const w = await world();
    for (const ex of w.hub.exchanges) {
      const m = w.hub.market(ex, SOL);
      if (m) m.maxLeverage = 20; // coin offers 20x, Paper is configured for 50x
    }
    const paper = w.app.bots.get("paper");
    expect(paper.config().leverages).toEqual([50]);
    if (adaptive) paper.saveConfig({ ...paper.config(), adaptive: { leverage: "fit", minLeverage: 5, size: "off", minSizePct: 25 } });
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    return { ...w, paper, sig: w.app.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === "SOL")! };
  }

  it("off (default): 50x on a 20x coin is rejected with LEVERAGE_UNAVAILABLE, never clamped", async () => {
    const { app, paper, sig } = await lowLeverageWorld(false);
    expect(paper.pm.openCount()).toBe(0);
    expect(sig.reject_reasons).toContain("LEVERAGE_UNAVAILABLE");
    expect(sig.fit?.leverage_mode).toBe("off");
    await app.stop();
  });

  it("fit: trades the coin's 20x, logs the fit on signal, trade and timeline, and restores 20x after restart", async () => {
    const { app, paper, sig } = await lowLeverageWorld(true);
    expect(paper.pm.openCount()).toBe(1);
    expect(sig.status).toBe("opened");
    expect(sig.fit).toMatchObject({ leverage_mode: "fit", requested_leverage: 50, leverage: 20, size_pct: 100, fitted: true });
    expect(sig.fit?.requested_fail_codes).toContain("LEVERAGE_UNAVAILABLE");
    expect(sig.gate_results.some((g) => g.variant_id === "50x->20x@100%" && g.pass)).toBe(true);
    const t = app.store.records.listTrades({ botId: "paper" })[0]!;
    expect(t.config).toMatchObject({ leverage: 20, requested_leverage: 50, size_pct: 100, fitted: true });
    expect(app.store.records.events(t.trade_id).some((e) => e.type === "ADAPTIVE_FIT")).toBe(true);
    // margin unchanged, notional = margin x 20 (lower exposure than 50x, same ROE-based $ risk)
    expect(Number(t.config.notional) / Number(t.config.margin)).toBeCloseTo(20, 6);
    // restart path: the exit profile must carry the traded leverage, not the configured 50x
    expect(paper.profileOf(t).leverage).toBe(20);
    expect(Object.keys(tradeExportRow(t)).filter((k) => !new Set(TRADE_DICTIONARY.map((d) => d.field)).has(k))).toEqual([]);
    const sdict = new Set(SIGNAL_DICTIONARY.map((d) => d.field));
    expect(Object.keys(signalExportRow(sig)).filter((k) => !sdict.has(k) && !k.startsWith("counterfactual"))).toEqual([]);
    await app.stop();
  });
});

describe("venue fallback", () => {
  const SOL = "SOL/USDT:USDT";
  it("gates the next-ranked venue when the best one fails, logs every venue, trades the one that passes", async () => {
    const w = await world();
    const paper = w.app.bots.get("paper");
    paper.saveConfig({ ...paper.config(), exchanges: ["binance", "bybit"] });
    const setMax = (ex: string, lev: number) => { const m = w.hub.market(ex as "binance", SOL); if (m) m.maxLeverage = lev; };
    // 1st signal: both venues cap at 20x (config 50x, adaptive off) -> rejected, ranking recorded
    setMax("binance", 20);
    setMax("bybit", 20);
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    const s1 = w.app.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === "SOL")!;
    expect(s1.status).toBe("rejected");
    expect(s1.venue_tries?.map((v) => v.exchange).sort()).toEqual(["binance", "bybit"]);
    expect(new Set(s1.gate_results.map((g) => g.exchange))).toEqual(new Set(["binance", "bybit"]));
    const [best, second] = s1.venue_tries!.map((v) => v.exchange);
    // 2nd signal: only the best-ranked venue still caps leverage
    setMax(second!, 50);
    w.src.quiet("SOL", 182.5);
    await w.clock.advance(31_000);
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    const s2 = w.app.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === "SOL")!;
    expect(s2.status).toBe("opened");
    expect(s2.exchange).toBe(second);
    expect(s2.venue_tries).toMatchObject([{ exchange: best, pass: false }, { exchange: second, pass: true, codes: [] }]);
    expect(s2.venue_tries![0]!.codes).toContain("LEVERAGE_UNAVAILABLE");
    expect(w.app.store.records.listTrades({ botId: "paper" })[0]!.exchange).toBe(second);
    const sdict = new Set(SIGNAL_DICTIONARY.map((d) => d.field));
    expect(Object.keys(signalExportRow(s2)).filter((k) => !sdict.has(k) && !k.startsWith("counterfactual"))).toEqual([]);
    await w.app.stop();
  });
});

describe("crossed book", () => {
  it("a crossed book (bid >= ask) is excluded by the router and never wins as the cheapest venue", async () => {
    const w = await world();
    const paper = w.app.bots.get("paper");
    paper.saveConfig({ ...paper.config(), exchanges: ["binance", "bybit"] });
    w.hub.crossBook("binance", "SOL", true);
    w.src.set("SOL", pumpMetrics(182.5));
    await w.clock.advance(31_000);
    const s = w.app.store.records.listSignals({ botId: "paper" }).find((x) => x.symbol === "SOL")!;
    expect(s.router.find((r) => r.exchange === "binance")?.excluded).toBe("BOOK_CROSSED");
    expect(s.status).toBe("opened");
    expect(s.exchange).toBe("bybit");
    expect(s.venue_tries?.map((v) => v.exchange)).toEqual(["bybit"]);
    await w.app.stop();
  });
});

describe("redaction", () => {
  it("secrets never appear in logs", () => {
    const lines: string[] = [];
    const l = createLogger({ level: "info", sink: { write: (s) => lines.push(s) } });
    registerSecret("S3CR3T-VALUE-xyz");
    l.info({ secret: "a", apiKey: "b", passphrase: "c", nested: { token: "d", text: "has S3CR3T-VALUE-xyz inside" } }, "msg S3CR3T-VALUE-xyz");
    const out = lines.join("");
    expect(out).not.toContain("S3CR3T-VALUE-xyz");
    expect(out).not.toMatch(/"secret":"a"|"apiKey":"b"|"passphrase":"c"|"token":"d"/);
  });
  it("API responses pass through redact()", () => {
    registerSecret("ANOTHER-SECRET-123");
    expect(JSON.stringify(redact({ ok: 1, secret: "x", m: "ANOTHER-SECRET-123" }))).not.toMatch(/ANOTHER-SECRET-123|"x"/);
  });
});

describe("architecture: one engine, two adapters", () => {
  const root = join(__dirname, "..", "src");
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));
  it("no paper/live branching outside execution/ (and demo tooling)", () => {
    const bad = files(root)
      .filter((f) => !/[\\/](execution|demo)[\\/]/.test(f))
      .filter((f) => /mode\s*===?\s*"(paper|live)"|kind\s*===?\s*"(sim|live)"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"))
      .sort();
    // Allowed, not trading logic: the typed-LIVE start confirmation and the LIVE banner flag.
    expect(bad).toEqual(["api/routes.ts", "engine/botManager.ts"]);
  });
  it("both adapters implement the same interface", async () => {
    const sim = await import("../src/execution/SimAdapter");
    const live = await import("../src/execution/LiveAdapter");
    const methods = ["accountId", "prepare", "takerPct", "available", "walletBalance", "canTrade", "placeIoc", "registerPosition", "unregisterPosition", "placeStop", "replaceStop", "placeTakeProfit", "cancel", "onEvent", "reconcile", "catchUp", "close"];
    for (const m of methods) {
      expect(typeof (sim.SimAdapter.prototype as unknown as Record<string, unknown>)[m]).toBe("function");
      expect(typeof (live.LiveAdapter.prototype as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });
});
