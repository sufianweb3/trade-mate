import { D } from "@oisniper/core";
import { beforeEach, describe, expect, it } from "vitest";
import { DemoHub } from "../src/demo/demoHub";
import { DEMO_EXCHANGES, DEMO_SYMBOLS } from "../src/demo/world";
import { SimAdapter, type SimAccount } from "../src/execution/SimAdapter";
import type { AdapterEvent } from "../src/execution/types";
import { VirtualClock } from "../src/util/clock";

const SOL = "SOL/USDT:USDT";

describe("SimAdapter (paper exchange)", () => {
  let clock: VirtualClock;
  let hub: DemoHub;
  let acct: SimAccount;
  let sim: SimAdapter;
  let events: AdapterEvent[];

  beforeEach(async () => {
    clock = new VirtualClock();
    hub = new DemoHub(DEMO_EXCHANGES.filter((e) => e.id === "binance"), DEMO_SYMBOLS.map((s) => ({ ...s })), clock);
    await hub.start();
    await hub.subscribe("binance", SOL, "test");
    acct = { cash: D(500), unlimited: false };
    sim = new SimAdapter({ botId: "t", hub, clock, account: acct, latencyOverrideMs: 50, takerOverridePct: {}, onAccountChange: () => undefined });
    events = [];
    sim.onEvent((e) => events.push(e));
  });

  const buy = async (qty: string, lev = 50, slip = 0.1) => {
    const ask = hub.book("binance", SOL)!.asks[0]![0];
    const p = sim.placeIoc({ clientOrderId: "c", tradeId: "T1", exchange: "binance", symbol: SOL, side: "buy", qty: D(qty), refPrice: ask, maxSlippagePct: slip, reduceOnly: false, leverage: lev });
    await clock.advance(100);
    return p;
  };

  it("fills VWAP on the book after latency, reserves margin + fee", async () => {
    const f = await buy("13.7");
    expect(f.status).toBe("filled");
    expect(f.latencyMs).toBe(50);
    const notional = f.avgPrice!.mul(f.filledQty);
    expect(f.fee.toString()).toBe(notional.mul("0.05").div(100).toString());
    expect(acct.cash.toString()).toBe(D(500).sub(notional.div(50)).sub(f.fee).toString());
  });

  it("partial fill when the IOC cap is reached", async () => {
    acct.cash = D(1_000_000);
    const f = await buy("4000", 10, 0.01);
    expect(f.status).toBe("partial");
    expect(f.filledQty.lt(4000)).toBe(true);
    expect(f.avgPrice!.lte(f.capPrice)).toBe(true);
  });

  it("rejects like an exchange: lot size, leverage, balance, reduce-only", async () => {
    expect((await buy("0.0001")).code).toBe("LOT_SIZE");
    expect((await buy("1", 150)).code).toBe("LEVERAGE_UNAVAILABLE");
    expect((await buy("2000", 2)).code).toBe("INSUFFICIENT_MARGIN");
    const r = await sim.placeIoc({ clientOrderId: "x", tradeId: "nope", exchange: "binance", symbol: SOL, side: "sell", qty: D(1), refPrice: D(180), maxSlippagePct: 0.1, reduceOnly: true, leverage: 50 });
    expect(r.code).toBe("REDUCE_ONLY_REJECTED");
  });

  it("stop triggers on mark, gap fills at the real book (below the stop)", async () => {
    const f = await buy("13.7");
    sim.registerPosition({ tradeId: "T1", botId: "t", exchange: "binance", symbol: SOL, leverage: 50, entryPrice: f.avgPrice!, qty: f.filledQty, margin: f.avgPrice!.mul(f.filledQty).div(50), liqPrice: f.avgPrice!.mul("0.984"), triggerPrice: "mark", openedAt: clock.now(), lastFundingTs: clock.now() });
    const stop = f.avgPrice!.mul("0.996");
    await sim.placeStop({ tradeId: "T1", exchange: "binance", symbol: SOL, qty: f.filledQty, triggerPrice: stop, clientOrderId: "sl" });
    hub.jump("SOL", 182.5 * 0.991);
    await clock.advance(1500);
    const e = events.find((x) => x.type === "stop_filled");
    expect(e).toBeDefined();
    if (e?.type === "stop_filled") expect(e.fill.avgPrice!.lt(stop)).toBe(true);
  });

  it("liquidation when mark crosses liq before the stop fills", async () => {
    const f = await buy("13.7");
    const liq = f.avgPrice!.mul("0.984");
    sim.registerPosition({ tradeId: "T1", botId: "t", exchange: "binance", symbol: SOL, leverage: 50, entryPrice: f.avgPrice!, qty: f.filledQty, margin: f.avgPrice!.mul(f.filledQty).div(50), liqPrice: liq, triggerPrice: "mark", openedAt: clock.now(), lastFundingTs: clock.now() });
    await sim.placeStop({ tradeId: "T1", exchange: "binance", symbol: SOL, qty: f.filledQty, triggerPrice: f.avgPrice!.mul("0.996"), clientOrderId: "sl" });
    const cashBefore = acct.cash;
    hub.jump("SOL", 182.5 * 0.97);
    await clock.advance(1500);
    expect(events.some((x) => x.type === "liquidated")).toBe(true);
    expect(acct.cash.toString()).toBe(cashBefore.toString()); // margin gone, nothing returned
  });

  it("charges funding at the funding timestamp (longs pay positive)", async () => {
    const f = await buy("13.7");
    sim.registerPosition({ tradeId: "T1", botId: "t", exchange: "binance", symbol: SOL, leverage: 50, entryPrice: f.avgPrice!, qty: f.filledQty, margin: f.avgPrice!.mul(f.filledQty).div(50), liqPrice: f.avgPrice!.mul("0.9"), triggerPrice: "mark", openedAt: clock.now(), lastFundingTs: clock.now() });
    hub.setTickMs(60_000);
    await clock.advance(8 * 3_600_000 + 61_000);
    const fe = events.filter((x) => x.type === "funding");
    expect(fe.length).toBe(1);
    if (fe[0]?.type === "funding") expect(fe[0].amount.gt(0)).toBe(true);
  });
});
