import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../src/app";
import { sourceComparison } from "../src/api/compare";
import { latencyStats } from "../src/api/latency";
import { DemoHub } from "../src/demo/demoHub";
import { DemoSource } from "../src/demo/demoSource";
import { DEMO_EXCHANGES, DEMO_SYMBOLS, pumpMetrics } from "../src/demo/world";
import { VirtualClock } from "../src/util/clock";

describe("comparison mode: both sources always collected", () => {
  it("trades on CoinGlass, logs Exchange shadow signals, stores both snapshots, latency stages", async () => {
    const clock = new VirtualClock();
    const hub = new DemoHub(DEMO_EXCHANGES, DEMO_SYMBOLS.map((s) => ({ ...s })), clock);
    const cg = new DemoSource();
    const ex = new DemoSource("exchange");
    for (const s of DEMO_SYMBOLS) {
      cg.quiet(s.base, s.price);
      ex.quiet(s.base, s.price);
    }
    const app = new App({ dbFile: join(mkdtempSync(join(tmpdir(), "oisn-cmp-")), "c.db"), clock, hub, source: cg, exchangeSource: ex, sleepGuard: false, useKeychain: false, passphrase: "x" });
    app.store.setSetting("warm_set_size", 0);
    await app.start();
    await app.bots.get("paper").start();

    // exchange data fires on SOL ~20s before CoinGlass shows it
    ex.set("SOL", pumpMetrics(182.5));
    await clock.advance(21_000);
    cg.set("SOL", pumpMetrics(182.5));
    await clock.advance(31_000);

    const sigs = app.store.records.listSignals({ botId: "paper" });
    const traded = sigs.find((s) => s.data_source === "demo-coinglass");
    const shadow = sigs.find((s) => s.data_source === "exchange");
    expect(traded?.status).toBe("opened");
    expect(shadow?.status).toBe("shadow");
    expect(traded!.metrics_alt?.oi_chg_5m).toBe(3.2); // the exchange row stored alongside
    expect(traded!.latency.gates_done_ts).toBeGreaterThanOrEqual(traded!.latency.detected_ts);
    const t = app.store.records.listTrades({ botId: "paper" })[0]!;
    expect(t.data_source).toBe("demo-coinglass");
    expect(t.signal_alt?.symbol).toBe("SOL");
    expect(t.timing.sl_placed_ts).not.toBeNull();
    expect(t.timing.order_ack_ts).toBeGreaterThanOrEqual(t.timing.order_sent_time);

    const cmp = sourceComparison(app, "paper");
    expect(cmp.coinglass.traded).toBe(1);
    expect(cmp.exchange.shadow).toBe(1);
    expect(cmp.overlap.pairs).toBe(1);
    expect(cmp.lead.exchangeFirst).toBe(1); // exchange fired first
    expect(cmp.lead.avgSec!).toBeGreaterThan(0);

    const lat = latencyStats(app);
    const stage = (n: string) => lat.paper!.find((x) => x.stage === n)!;
    expect(stage("detected → order sent").n).toBe(1);
    expect(stage("fill → SL placed").p50).not.toBeNull();

    // switching the source creates a new version and swaps the roles
    const v0 = app.bots.get("paper").versionId();
    const v1 = app.bots.get("paper").saveConfig({ ...app.bots.get("paper").config(), dataSource: { kind: "exchange", oiScope: "aggregated" } });
    expect(v1).not.toBe(v0);
    await app.stop();
  });
});
