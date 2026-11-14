import { D } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import type { LiveAccounts } from "../src/execution/liveAccounts";
import { LiveAdapter } from "../src/execution/LiveAdapter";
import type { IocRequest } from "../src/execution/types";
import type { MarketHub } from "../src/market/types";
import type { Clock } from "../src/util/clock";

const SYM = "BTC/USDT:USDT";
const clock = { now: () => 1_000, setInterval: () => () => undefined } as unknown as Clock;
const hub = {
  market: () => ({ tickSize: D("0.1"), qtyStep: D("0.001"), contractSize: D(1) }),
  rttMs: () => 0,
  book: () => null,
  bookAt: () => null,
  health: () => [{ exchange: "binance", clockOffsetMs: 0 }],
  recordOrderLatency: () => undefined,
} as unknown as MarketHub;

/**
 * Fake Binance client. `create` is the order response; `fetch` the later order lookup (or an error).
 * Binance answers an IOC with "FILLED" and the filled amount, but without the average price.
 */
function adapterWith(create: Record<string, unknown>, fetch: Record<string, unknown> | Error) {
  let fetches = 0;
  const client = {
    id: "binanceusdm",
    has: { createOrderWs: false },
    options: {},
    createOrder: async () => create,
    fetchOrder: async () => {
      fetches++;
      if (fetch instanceof Error) throw fetch;
      return fetch;
    },
  };
  const accounts = { get: () => client, canTrade: () => true, statusOf: () => ({ takerPct: 0.05 }) } as unknown as LiveAccounts;
  const a = new LiveAdapter({ botId: "real", hub, clock, accounts, maxCapital: () => D(300), takerOverridePct: {} });
  return { a, fetches: () => fetches };
}

const req: IocRequest = {
  clientOrderId: "real-x-e-0", tradeId: "trd_1", exchange: "binance", symbol: SYM, side: "buy",
  qty: D("0.0029"), refPrice: D(66700), maxSlippagePct: 0.2, reduceOnly: false, leverage: 5,
};
const filledNoPrice = { id: "1", status: "closed", filled: 0.0029, amount: 0.0029 };

describe("LiveAdapter: a filled entry is never dropped", () => {
  it("reads the price from the order lookup when the response has none", async () => {
    const { a, fetches } = adapterWith(filledNoPrice, { ...filledNoPrice, average: 66721.4 });
    const r = await a.placeIoc(req);
    expect(r.status).toBe("filled");
    expect(r.filledQty.toString()).toBe("0.0029");
    expect(r.avgPrice?.toString()).toBe("66721.4");
    expect(fetches()).toBeGreaterThan(0);
  });

  it("works the price out from the cost when the lookup fails", async () => {
    const { a } = adapterWith({ ...filledNoPrice, cost: 193.49206 }, new Error("network"));
    const r = await a.placeIoc(req);
    expect(r.status).toBe("filled");
    expect(r.avgPrice?.toString()).toBe("66721.4");
  });

  it("falls back to the limit price (worst case for a buy) rather than dropping the fill", async () => {
    const { a } = adapterWith(filledNoPrice, new Error("network"));
    const r = await a.placeIoc(req);
    expect(r.status).toBe("filled");
    expect(r.filledQty.toString()).toBe("0.0029");
    expect(r.avgPrice?.eq(r.capPrice)).toBe(true); // 66700 + 0.2% = 66833.4, at or above the real fill
  });

  it("an IOC that filled nothing is still reported as not filled", async () => {
    const { a } = adapterWith({ id: "2", status: "canceled", filled: 0, amount: 0.0029 }, new Error("unused"));
    const r = await a.placeIoc(req);
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("ORDER_NOT_FILLED");
  });
});
