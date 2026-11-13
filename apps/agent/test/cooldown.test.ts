import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../src/app";
import { buildWorld, pumpMetrics } from "../src/demo/world";
import { cooldownState } from "../src/engine/cooldown";
import { Store } from "../src/store/store";
import { VirtualClock } from "../src/util/clock";

const H = 3_600_000;

describe("cooldown rule (pure)", () => {
  const base = { hasOpen: false, lastEntry: null, lastClose: null, now: 100 * H, hours: 12 };
  it("open position blocks regardless of time", () => {
    expect(cooldownState({ ...base, hasOpen: true, lastEntry: 0 })).toEqual({ blocked: true, cause: "open_position", until: null });
  });
  it("blocks for 12h after entry", () => {
    expect(cooldownState({ ...base, lastEntry: 100 * H - 11 * H })).toMatchObject({ blocked: true, cause: "entry", until: 101 * H });
    expect(cooldownState({ ...base, lastEntry: 100 * H - 12 * H }).blocked).toBe(false);
  });
  it("blocks for 12h after close, even when the entry is older than 12h", () => {
    const r = cooldownState({ ...base, lastEntry: 100 * H - 20 * H, lastClose: 100 * H - 2 * H });
    expect(r).toMatchObject({ blocked: true, cause: "close", until: 110 * H });
  });
  it("free when both windows passed", () => {
    expect(cooldownState({ ...base, lastEntry: 0, lastClose: 100 * H - 12 * H - 1 }).blocked).toBe(false);
  });
});

describe("cooldown rule: Test grid re-entry while open (15 min from last entry)", () => {
  const M = 60_000;
  const t = { hasOpen: true, lastEntry: null, lastClose: null, now: 100 * H, hours: 0.25, reentry: "while_open" as const };
  it("open position does not block; 15 min from the last entry does", () => {
    expect(cooldownState({ ...t, lastEntry: 100 * H - 14 * M })).toEqual({ blocked: true, cause: "entry", until: 100 * H + M });
    expect(cooldownState({ ...t, lastEntry: 100 * H - 15 * M }).blocked).toBe(false);
  });
  it("a recent close does not extend the window", () => {
    expect(cooldownState({ ...t, hasOpen: false, lastEntry: 100 * H - 20 * M, lastClose: 100 * H - M }).blocked).toBe(false);
  });
});

describe("cooldown persistence", () => {
  it("entry and close times survive a restart (SQLite)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "oisn-cd-")), "c.db");
    const s1 = new Store(file);
    s1.setLastEntry("paper", "BTC", 1000);
    s1.setLastClose("paper", "BTC", 5000);
    s1.setLastClose("paper", "BTC", 3000); // an earlier grid variant closing later in processing never moves it back
    s1.close();
    const s2 = new Store(file);
    expect(s2.lastEntry("paper", "BTC")).toBe(1000);
    expect(s2.lastClose("paper", "BTC")).toBe(5000);
    expect(s2.lastEntry("paper", "ETH")).toBeNull();
    s2.close();
  });
});

describe("cooldown in the engine", () => {
  it("1000PEPE position blocks PEPE, other coins trade, 12h after close, restart keeps it", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "oisn-cd-")), "e.db");
    const clock = new VirtualClock();
    const w = buildWorld(db, clock);
    w.app.store.setSetting("warm_set_size", 0);
    await w.app.start();
    const paper = w.app.bots.get("paper");
    paper.saveConfig({ ...paper.config(), exchanges: ["binance"] }); // Binance lists PEPE as 1000PEPE
    await paper.start();
    const sig = (sym: string) => w.app.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === sym);

    w.src.set("PEPE", pumpMetrics(0.00001234));
    await clock.advance(31_000);
    const t = w.app.store.records.listTrades({ botId: "paper", symbol: "PEPE" })[0]!;
    expect(t.exchange_symbol).toBe("1000PEPE/USDT:USDT");
    expect(t.symbol).toBe("PEPE");

    // quiet one scrape, then PEPE matches again while ETH also matches
    w.src.quiet("PEPE", 0.00001234);
    await clock.advance(31_000);
    w.src.set("PEPE", pumpMetrics(0.00001234));
    w.src.set("ETH", pumpMetrics(3412.5));
    await clock.advance(31_000);
    expect(sig("PEPE")!.reject_reasons).toEqual(["COOLDOWN", "OPEN_POSITION"]);
    expect(sig("ETH")!.status).toBe("opened");
    w.src.quiet("PEPE", 0.00001234);
    w.src.quiet("ETH", 3412.5);

    // hold PEPE 13h, then stop out
    w.hub.setTickMs(60_000);
    await clock.advance(13 * H);
    w.hub.setTickMs(500);
    w.hub.jump("PEPE", 0.00001234 * 0.99);
    await clock.advance(10_000);
    const closed = w.app.store.records.getTrade(t.trade_id)!;
    expect(closed.status).toBe("closed");

    // 1h after close (entry was 13h ago): blocked by the close window
    w.hub.setTickMs(60_000);
    await clock.advance(H);
    w.src.set("PEPE", pumpMetrics(w.hub.refPrice("PEPE", clock.now())));
    await clock.advance(31_000);
    expect(sig("PEPE")!.reject_reasons).toEqual(["COOLDOWN"]);
    expect(sig("PEPE")!.cooldown?.cause).toBe("close");
    w.src.quiet("PEPE", w.hub.refPrice("PEPE", clock.now()));
    await clock.advance(31_000);

    // restart: still blocked, bots come back stopped
    await w.app.stop();
    const app2 = new App({ ...w.app.o, dbFile: db });
    let started = false;
    const p = app2.start().finally(() => (started = true));
    while (!started) await clock.advance(200);
    await p;
    expect(app2.bots.get("paper").row().status).toBe("stopped");
    await app2.bots.get("paper").start();
    w.src.set("PEPE", pumpMetrics(w.hub.refPrice("PEPE", clock.now())));
    await clock.advance(31_000);
    const after = app2.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === "PEPE")!;
    expect(after.reject_reasons).toEqual(["COOLDOWN"]);

    // 12h after the close: tradable again
    w.src.quiet("PEPE", w.hub.refPrice("PEPE", clock.now()));
    await clock.advance(11 * H);
    w.hub.setTickMs(500);
    w.src.set("PEPE", pumpMetrics(w.hub.refPrice("PEPE", clock.now())));
    await clock.advance(31_000);
    expect(app2.store.records.listSignals({ botId: "paper" }).find((s) => s.symbol === "PEPE")!.status).toBe("opened");
    await app2.stop();
  }, 300_000); // virtual-clock engine run; slow when the machine also runs the agent and the scenarios
});
