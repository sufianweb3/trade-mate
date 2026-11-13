import type { ExchangeId } from "@oisniper/core";
import { z } from "zod";
import type { Caller } from "./collectors";
import type { Candle, SeriesStore } from "./series";

const Rec = z.record(z.string(), z.unknown());
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** 5m + 1h candles for price and volume: Binance if listed there, else Bybit. Prices per plain coin. */
export async function loadCandles(c: Caller, s: SeriesStore, base: string, ids: { binance?: string; bybit?: string }, mult: number, full: boolean): Promise<boolean> {
  const fetch = async (tf: "5m" | "1h", limit: number): Promise<Candle[] | null> => {
    if (ids.binance) {
      const r = z.array(z.array(z.unknown())).safeParse(await c("binance", "fapiPublicGetKlines", { symbol: ids.binance, interval: tf, limit }).catch(() => null));
      if (r.success) return r.data.map((k) => ({ ts: num(k[0])!, close: num(k[4])! / mult, quoteVol: num(k[7]) ?? 0 })).filter((x) => x.ts && x.close);
    }
    if (ids.bybit) {
      const r = Rec.safeParse(await c("bybit", "publicGetV5MarketKline", { category: "linear", symbol: ids.bybit, interval: tf === "5m" ? "5" : "60", limit }).catch(() => null));
      const list = r.success ? z.array(z.array(z.unknown())).catch([]).parse(Rec.parse(r.data.result ?? {}).list) : [];
      if (list.length) return list.map((k) => ({ ts: num(k[0])!, close: num(k[4])! / mult, quoteVol: num(k[6]) ?? 0 })).filter((x) => x.ts && x.close).reverse();
    }
    return null;
  };
  const k5 = await fetch("5m", full ? 100 : 3);
  if (k5) s.setCandles(base, "5m", k5);
  if (full) {
    const k1 = await fetch("1h", 50);
    if (k1) s.setCandles(base, "1h", k1);
  }
  return !!k5;
}

/** Closest 5m close for a timestamp (Bybit OI history is in coins and needs a USD price). */
const closeAt = (s: SeriesStore, base: string, ts: number) => {
  const k = s.k5.get(base);
  const x = k?.find((c) => c.ts <= ts && ts < c.ts + 300_000) ?? k?.find((c) => Math.abs(c.ts - ts) <= 300_000);
  return x?.close ?? null;
};

/** 4h of 5m OI history per venue so % changes are valid from the first minute. KuCoin has no history (warms up). */
export async function backfillOi(c: Caller, s: SeriesStore, base: string, ids: Partial<Record<ExchangeId, string>>, mults: Partial<Record<ExchangeId, number>>): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (ids.binance)
    jobs.push(
      (async () => {
        const r = z.array(Rec).safeParse(await c("binance", "fapiDataGetOpenInterestHist", { symbol: ids.binance, period: "5m", limit: 49 }).catch(() => null));
        if (r.success) for (const x of r.data) s.addOi(base, "binance", num(x.timestamp)!, num(x.sumOpenInterestValue));
      })(),
    );
  if (ids.bybit)
    jobs.push(
      (async () => {
        const r = Rec.safeParse(await c("bybit", "publicGetV5MarketOpenInterest", { category: "linear", symbol: ids.bybit, intervalTime: "5min", limit: 49 }).catch(() => null));
        const list = r.success ? z.array(Rec).catch([]).parse(Rec.parse(r.data.result ?? {}).list) : [];
        const m = mults.bybit ?? 1;
        for (const x of list) {
          const ts = num(x.timestamp)!;
          const coins = num(x.singleOpenInterest) ?? (num(x.openInterest) != null ? num(x.openInterest)! / 2 : null);
          const px = closeAt(s, base, ts);
          s.addOi(base, "bybit", ts, coins != null && px != null ? coins * px * m : null);
        }
      })(),
    );
  if (ids.okx)
    jobs.push(
      (async () => {
        const r = Rec.safeParse(await c("okx", "publicGetRubikStatContractsOpenInterestHistory", { instId: ids.okx, period: "5m", limit: "49" }).catch(() => null));
        const list = r.success ? z.array(z.array(z.unknown())).catch([]).parse(r.data.data) : [];
        for (const x of list) s.addOi(base, "okx", num(x[0])!, num(x[3]));
      })(),
    );
  if (ids.gate)
    jobs.push(
      (async () => {
        const r = z.array(Rec).safeParse(await c("gate", "publicFuturesGetSettleContractStats", { settle: "usdt", contract: ids.gate, interval: "5m", limit: 49 }).catch(() => null));
        if (r.success) for (const x of r.data) s.addOi(base, "gate", num(x.time)! * 1000, num(x.open_interest_usd));
      })(),
    );
  await Promise.all(jobs);
}
