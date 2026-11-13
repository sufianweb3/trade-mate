import { z } from "zod";
import { call, type ExchangeQuirks } from "./types";

const ApiInfo = z.object({
  result: z.object({
    readOnly: z.union([z.number(), z.string()]).optional(),
    ips: z.array(z.string()).optional(),
    permissions: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export const bybit: ExchangeQuirks = {
  ccxtId: "bybit",
  options: { defaultType: "swap", adjustForTimeDifference: true, recvWindow: 5000 },
  testnet: "sandbox",
  needsPassphrase: false,
  stopParams: (t) => ({ reduceOnly: true, triggerBy: t === "mark" ? "MarkPrice" : "LastPrice", slTriggerBy: t === "mark" ? "MarkPrice" : "LastPrice" }),
  iocParams: () => ({ timeInForce: "IOC" }),
  async probePermissions(c) {
    const r = ApiInfo.parse(await call(c, "privateGetV5UserQueryApi")).result;
    const perms = r.permissions ?? {};
    const all = Object.values(perms).flat().map((s) => s.toLowerCase());
    return {
      read: true,
      trade: String(r.readOnly ?? "0") === "0",
      withdraw: all.some((p) => p.includes("withdraw")) || (perms.Wallet ?? []).some((p) => /withdraw/i.test(p)),
      ipWhitelist: (r.ips ?? []).some((ip) => ip && ip !== "*"),
      source: "v5/user/query-api",
    };
  },
};
