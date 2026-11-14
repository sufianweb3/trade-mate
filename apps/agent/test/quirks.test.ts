import { describe, expect, it } from "vitest";
import { binance } from "../src/market/quirks/binance";
import { applyTestnet, type CcxtLike } from "../src/market/quirks/types";

/** Fake ccxt client recording which test-environment switch was used. */
function fakeClient(opts: { demoTrading: boolean }) {
  const calls: string[] = [];
  const c: CcxtLike = {
    id: "binanceusdm",
    has: {},
    options: {},
    // Newer ccxt accepts sandbox mode for Binance futures and only fails on the first request.
    setSandboxMode: () => calls.push("setSandboxMode"),
  };
  if (opts.demoTrading) c.enableDemoTrading = () => calls.push("enableDemoTrading");
  return { c, calls };
}

describe("applyTestnet", () => {
  it("Binance futures goes straight to Demo Trading (its testnet was retired)", async () => {
    const { c, calls } = fakeClient({ demoTrading: true });
    await applyTestnet(c, binance);
    expect(calls).toEqual(["enableDemoTrading"]);
  });

  it("refuses rather than silently falling back to the retired testnet", async () => {
    const { c, calls } = fakeClient({ demoTrading: false });
    await expect(applyTestnet(c, binance)).rejects.toThrow(/demo trading/i);
    expect(calls).toEqual([]);
  });
});
