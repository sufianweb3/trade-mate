import { D } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import type { LiveAccounts } from "../src/execution/liveAccounts";
import { LiveAdapter } from "../src/execution/LiveAdapter";
import type { PositionCtx } from "../src/execution/types";
import type { MarketHub } from "../src/market/types";
import type { Clock } from "../src/util/clock";

const SYM = "BTC/USDT:USDT";
const clock = { now: () => 1_000, setInterval: () => () => undefined } as unknown as Clock;
const hub = {
  market: () => ({ tickSize: D("0.1"), qtyStep: D("0.001"), contractSize: D(1) }),
  health: () => [{ exchange: "binance", clockOffsetMs: 0 }],
} as unknown as MarketHub;

/**
 * Fake Binance: stop orders live in their own (algo / trigger) book. Cancelling one without the trigger flag fails
 * with "Unknown order", like the real exchange.
 */
function binance() {
  const triggerBook = new Set<string>();
  let n = 0;
  const client = {
    id: "binanceusdm",
    has: { createOrderWs: false },
    options: {},
    createOrder: async () => {
      const id = `stop-${++n}`;
      triggerBook.add(id);
      return { id, status: "open" };
    },
    cancelOrder: async (id: string, _s: string, params: { trigger?: boolean }) => {
      if (!params?.trigger || !triggerBook.has(id)) throw Object.assign(new Error("binanceusdm {\"code\":-2011,\"msg\":\"Unknown order sent.\"}"), { name: "OrderNotFound" });
      triggerBook.delete(id);
      return { id, status: "canceled" };
    },
  };
  const accounts = { get: () => client, canTrade: () => true, statusOf: () => null } as unknown as LiveAccounts;
  const a = new LiveAdapter({ botId: "real", hub, clock, accounts, maxCapital: () => D(300), takerOverridePct: {} });
  return { a, triggerBook };
}

const ctx = {
  tradeId: "trd_1", botId: "real", exchange: "binance", symbol: SYM, leverage: 5, entryPrice: D(66700), qty: D("0.0029"),
  margin: D(40), liqPrice: D(54000), triggerPrice: "mark", openedAt: 0,
} as unknown as PositionCtx;
const stop = (price: number) => ({ tradeId: "trd_1", exchange: "binance" as const, symbol: SYM, qty: D("0.0029"), triggerPrice: D(price), clientOrderId: `sl-${price}` });

describe("LiveAdapter stops", () => {
  it("moving a stop cancels the old stop order: only one stop stays on the exchange", async () => {
    const { a, triggerBook } = binance();
    a.registerPosition(ctx);
    const first = await a.placeStop(stop(65000));
    const second = await a.replaceStop(first, stop(65500));
    expect(second).not.toBe(first);
    expect([...triggerBook]).toEqual([second]);
    await a.close();
  });

  it("closing cancels the current stop", async () => {
    const { a, triggerBook } = binance();
    a.registerPosition(ctx);
    const id = await a.placeStop(stop(65000));
    await a.cancel("trd_1", id);
    expect(triggerBook.size).toBe(0);
    await a.close();
  });
});
