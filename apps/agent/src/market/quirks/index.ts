import type { ExchangeId } from "@oisniper/core";
import { binance } from "./binance";
import { bybit } from "./bybit";
import { okx } from "./okx";
import { gate, kucoin, mexc } from "./others";
import type { ExchangeQuirks } from "./types";

export const QUIRKS: Record<ExchangeId, ExchangeQuirks> = { binance, bybit, okx, gate, kucoin, mexc };
export type { ExchangeQuirks, KeyPermissions, CcxtLike } from "./types";
