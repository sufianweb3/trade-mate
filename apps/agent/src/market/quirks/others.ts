import { unknownPermissions, type ExchangeQuirks } from "./types";

// Gate, KuCoin and MEXC do not expose key permissions through a stable public endpoint.
// The agent marks those keys "unverified" and requires the user to confirm no-withdrawal (docs/decisions.md).

export const gate: ExchangeQuirks = {
  ccxtId: "gate",
  options: { defaultType: "swap" },
  testnet: "sandbox",
  needsPassphrase: false,
  stopParams: (t) => ({ reduceOnly: true, price_type: t === "mark" ? 1 : 0 }),
  iocParams: () => ({ timeInForce: "IOC" }),
  probePermissions: async () => unknownPermissions("not exposed"),
};

export const kucoin: ExchangeQuirks = {
  // KuCoin futures uses a separate API host; ccxt "kucoinfutures" targets it.
  ccxtId: "kucoinfutures",
  options: { defaultType: "swap" },
  bookLimit: 100, // KuCoin futures accepts only 20 or 100
  testnet: "sandbox",
  needsPassphrase: true,
  stopParams: (t) => ({ reduceOnly: true, stopPriceType: t === "mark" ? "MP" : "TP", marginMode: "ISOLATED" }),
  iocParams: () => ({ timeInForce: "IOC", marginMode: "ISOLATED" }),
  probePermissions: async () => unknownPermissions("not exposed"),
};

export const mexc: ExchangeQuirks = {
  ccxtId: "mexc",
  options: { defaultType: "swap" },
  testnet: null,
  needsPassphrase: false,
  stopParams: (t) => ({ reduceOnly: true, triggerType: t === "mark" ? 2 : 1, openType: 1 }),
  iocParams: () => ({ timeInForce: "IOC", openType: 1 }),
  probePermissions: async () => unknownPermissions("not exposed"),
};
