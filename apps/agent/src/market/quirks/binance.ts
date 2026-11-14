import { z } from "zod";
import { call, type ExchangeQuirks } from "./types";

const Restrictions = z.object({
  enableReading: z.boolean().optional(),
  enableFutures: z.boolean().optional(),
  enableWithdrawals: z.boolean().optional(),
  ipRestrict: z.boolean().optional(),
});

export const binance: ExchangeQuirks = {
  ccxtId: "binanceusdm",
  options: { defaultType: "future", adjustForTimeDifference: true, recvWindow: 5000 },
  testnet: "demo-trading",
  needsPassphrase: false,
  stopParams: (t) => ({ reduceOnly: true, workingType: t === "mark" ? "MARK_PRICE" : "CONTRACT_PRICE" }),
  // RESULT: the order response already carries the fill, saving a REST round trip on entry.
  iocParams: () => ({ timeInForce: "IOC", newOrderRespType: "RESULT" }),
  async probePermissions(c) {
    const r = Restrictions.parse(await call(c, "sapiGetAccountApiRestrictions"));
    return { read: r.enableReading ?? null, trade: r.enableFutures ?? null, withdraw: r.enableWithdrawals ?? null, ipWhitelist: r.ipRestrict ?? null, source: "sapi/account/apiRestrictions" };
  },
};
