import { z } from "zod";
import { call, type ExchangeQuirks } from "./types";

const Cfg = z.object({ data: z.array(z.object({ perm: z.string().optional(), ip: z.string().optional() })) });

export const okx: ExchangeQuirks = {
  ccxtId: "okx",
  options: { defaultType: "swap" },
  testnet: "demo",
  needsPassphrase: true,
  stopParams: (t) => ({ reduceOnly: true, slTriggerPxType: t === "mark" ? "mark" : "last", tdMode: "isolated" }),
  iocParams: () => ({ timeInForce: "IOC", tdMode: "isolated" }),
  async probePermissions(c) {
    const d = Cfg.parse(await call(c, "privateGetAccountConfig")).data[0] ?? {};
    const perm = (d.perm ?? "").toLowerCase();
    return { read: perm.includes("read"), trade: perm.includes("trade"), withdraw: perm.includes("withdraw"), ipWhitelist: d.ip ? d.ip.length > 0 : null, source: "account/config" };
  },
};
