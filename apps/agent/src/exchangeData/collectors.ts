import type { ExchangeId } from "@oisniper/core";
import { z } from "zod";

/** One venue's view of one coin. Prices are per PLAIN coin (1000PEPE prices are divided by 1000). */
export interface VenueItem {
  base: string;
  /** Exchange symbol id used by the venue's REST API (SOLUSDT, SOL-USDT-SWAP, SOL_USDT, SOLUSDTM). */
  id: string;
  mult: number;
  oiUsd: number | null;
  price: number | null;
  vol24hUsd: number | null;
  /** Funding in percent per interval (0.01 = 0.01%), CoinGlass convention. */
  fundingPct: number | null;
}

export type Caller = (ex: ExchangeId, method: string, params?: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const PREFIX = /^(1000000|1M|10000|1000)/;
/** "1000PEPE" -> { base: "PEPE", mult: 1000 }; KuCoin XBT -> BTC. */
export function splitBase(raw: string): { base: string; mult: number } {
  const up = raw.toUpperCase();
  const m = up.match(PREFIX);
  const mult = m ? (m[1] === "1M" ? 1_000_000 : Number(m[1])) : 1;
  const base = m ? up.slice(m[1]!.length) : up;
  return { base: base === "XBT" ? "BTC" : base, mult };
}
const perCoin = (p: number | null, mult: number) => (p == null ? null : p / mult);

const Rec = z.record(z.string(), z.unknown());
/**
 * Array of plain objects, else []. Not zod: z.record copied every field of ~600 tickers per poll and blocked the
 * event loop for seconds. Every field is still type-checked where it is read (num(), typeof).
 */
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)) : [];

async function bybit(c: Caller): Promise<VenueItem[]> {
  const r = Rec.parse(await c("bybit", "publicGetV5MarketTickers", { category: "linear" }));
  const list = arr(Rec.parse(r.result ?? {}).list);
  return list
    .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
    .map((x) => {
      const { base, mult } = splitBase(String(x.symbol).slice(0, -4));
      // Bybit's openInterest counts both sides; singleOpenInterestValue is one side like every other venue.
      return {
        base, id: String(x.symbol), mult,
        oiUsd: num(x.singleOpenInterestValue) ?? (num(x.openInterestValue) != null ? num(x.openInterestValue)! / 2 : null),
        price: perCoin(num(x.markPrice) ?? num(x.lastPrice), mult), vol24hUsd: num(x.turnover24h),
        fundingPct: num(x.fundingRate) != null ? num(x.fundingRate)! * 100 : null,
      };
    });
}

async function okx(c: Caller): Promise<VenueItem[]> {
  const [oiR, tkR] = await Promise.all([c("okx", "publicGetPublicOpenInterest", { instType: "SWAP" }), c("okx", "publicGetMarketTickers", { instType: "SWAP" })]);
  const tk = new Map(arr(Rec.parse(tkR).data).map((x) => [String(x.instId), x]));
  return arr(Rec.parse(oiR).data)
    .filter((x) => typeof x.instId === "string" && x.instId.endsWith("-USDT-SWAP"))
    .map((x) => {
      const { base, mult } = splitBase(String(x.instId).split("-")[0]!);
      const t = tk.get(String(x.instId));
      const last = num(t?.last);
      const volCcy = num(t?.volCcy24h);
      return { base, id: String(x.instId), mult, oiUsd: num(x.oiUsd), price: perCoin(last, mult), vol24hUsd: volCcy != null && last != null ? volCcy * last : null, fundingPct: null };
    });
}

async function gate(c: Caller, mults: Map<string, number>): Promise<VenueItem[]> {
  return arr(await c("gate", "publicFuturesGetSettleTickers", { settle: "usdt" }))
    .filter((x) => typeof x.contract === "string" && x.contract.endsWith("_USDT"))
    .map((x) => {
      const { base, mult } = splitBase(String(x.contract).split("_")[0]!);
      const mark = num(x.mark_price);
      const size = num(x.total_size);
      const cs = mults.get(String(x.contract)) ?? null; // contract size (quanto multiplier) from loaded markets
      return {
        base, id: String(x.contract), mult,
        oiUsd: size != null && mark != null && cs != null ? size * cs * mark : null,
        price: perCoin(mark ?? num(x.last), mult), vol24hUsd: num(x.volume_24h_quote) ?? num(x.volume_24h_settle),
        fundingPct: num(x.funding_rate) != null ? num(x.funding_rate)! * 100 : null,
      };
    });
}

async function kucoin(c: Caller): Promise<VenueItem[]> {
  return arr(Rec.parse(await c("kucoin", "futuresPublicGetContractsActive")).data)
    .filter((x) => x.quoteCurrency === "USDT" && x.expireDate == null)
    .map((x) => {
      const { base, mult } = splitBase(String(x.baseCurrency));
      const mark = num(x.markPrice);
      const lots = num(x.openInterest);
      const m = num(x.multiplier);
      return {
        base, id: String(x.symbol), mult,
        oiUsd: lots != null && m != null && mark != null ? lots * m * mark : null,
        price: perCoin(mark, mult), vol24hUsd: num(x.turnoverOf24h),
        fundingPct: num(x.fundingFeeRate) != null ? num(x.fundingFeeRate)! * 100 : null,
      };
    });
}

/** Binance has no bulk OI: prices/volume/funding in bulk, OI per symbol for the universe only (rate limited). */
async function binance(c: Caller, oiFor: Set<string>): Promise<VenueItem[]> {
  const [prem, t24] = await Promise.all([c("binance", "fapiPublicGetPremiumIndex"), c("binance", "fapiPublicGetTicker24hr")]);
  const vol = new Map(arr(t24).map((x) => [String(x.symbol), num(x.quoteVolume)]));
  const items = arr(prem)
    .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
    .map((x) => {
      const { base, mult } = splitBase(String(x.symbol).slice(0, -4));
      return {
        base, id: String(x.symbol), mult, oiUsd: null as number | null, price: perCoin(num(x.markPrice), mult),
        vol24hUsd: vol.get(String(x.symbol)) ?? null, fundingPct: num(x.lastFundingRate) != null ? num(x.lastFundingRate)! * 100 : null,
      };
    });
  const want = items.filter((i) => oiFor.has(i.base));
  // 25 parallel requests per batch; ccxt's rate limiter still spaces them within Binance's weight budget. The OI
  // calls share that queue with candles and backfill, so they get a 10s deadline: coins not reached stay null
  // this poll (never 0) instead of the whole venue (prices too) timing out.
  const deadline = Date.now() + 10_000;
  for (let i = 0; i < want.length && Date.now() < deadline; i += 25) {
    await Promise.all(
      want.slice(i, i + 25).map(async (it) => {
        if (Date.now() >= deadline) return;
        const r = Rec.safeParse(await c("binance", "fapiPublicGetOpenInterest", { symbol: it.id }).catch(() => null));
        const contracts = r.success ? num(r.data.openInterest) : null;
        it.oiUsd = contracts != null && it.price != null ? contracts * it.price * it.mult : null;
      }),
    );
  }
  return items;
}

export async function pollVenue(ex: ExchangeId, c: Caller, ctx: { gateMults: Map<string, number>; binanceOi: Set<string> }): Promise<VenueItem[]> {
  switch (ex) {
    case "bybit":
      return bybit(c);
    case "okx":
      return okx(c);
    case "gate":
      return gate(c, ctx.gateMults);
    case "kucoin":
      return kucoin(c);
    case "binance":
      return binance(c, ctx.binanceOi);
    default:
      return [];
  }
}
