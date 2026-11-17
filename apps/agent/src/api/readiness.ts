import { EXCHANGES, type ExchangeId } from "@oisniper/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { App } from "../app";
import type { SetupProbe } from "../execution/liveAccounts";
import { defaultDataDir } from "../paths";

export interface ReadyItem {
  id: "key" | "withdraw" | "isolated" | "one_way" | "leverage" | "clock" | "testnet";
  label: string;
  ok: boolean;
  detail: string;
  /** false = recommended only: shown as a warning, does not block Real. */
  required: boolean;
}

const PassFile = z.record(z.string(), z.object({ passedAt: z.number(), checks: z.array(z.string()) }));

/** Written by `pnpm test:testnet` when an exchange passes the full live-order suite. */
export function testnetPasses(dataDir = process.env.OISNIPER_DATA_DIR ?? defaultDataDir()): z.infer<typeof PassFile> {
  const f = join(dataDir, "testnet-pass.json");
  if (!existsSync(f)) return {};
  const p = PassFile.safeParse(JSON.parse(readFileSync(f, "utf8")));
  return p.success ? p.data : {};
}

/**
 * Real Mode Readiness: every required item must be green (testnet pass is recommended only, see docs/decisions.md) for every exchange the Real bot may trade on.
 * Exchanges in the Real config without a key are listed as not ready (Real cannot route to them).
 */
export function realReadiness(app: App) {
  const cfg = app.bots.get("real").config();
  const wanted = (cfg.exchanges === "ALL" ? EXCHANGES.filter((e) => app.accounts.statusOf(e)) : cfg.exchanges) as ExchangeId[];
  const passes = testnetPasses(app.o.dataDir);
  const health = new Map(app.o.hub.health().map((h) => [h.exchange, h]));
  const exchanges = wanted.map((ex) => {
    const st = app.accounts.statusOf(ex);
    const probe = app.store.getSetting<SetupProbe | null>(`readiness:${ex}`, null);
    const off = health.get(ex)?.clockOffsetMs;
    const items: ReadyItem[] = [
      { id: "key", required: true, label: "Key validated", ok: !!st && (st.status === "connected" || st.status === "unverified") && st.tradeEnabled, detail: st ? `${st.status}${st.tradeEnabled ? "" : ", trading not enabled"}${st.reason ? `: ${st.reason}` : ""}` : "no key" },
      { id: "withdraw", required: true, label: "No withdrawal permission", ok: !!st && (st.permissions?.withdraw === false || st.status === "unverified"), detail: st?.permissions?.withdraw === false ? "read from exchange" : st?.status === "unverified" ? "confirmed by you (exchange does not expose permissions)" : "unknown" },
      { id: "isolated", required: true, label: "Isolated margin", ok: !!probe?.isolated, detail: probe ? `${probe.symbol} ${new Date(probe.ts).toISOString().slice(0, 16)}` : "Test the key again" },
      { id: "one_way", required: true, label: "One-way position mode", ok: !!probe?.oneWay, detail: probe ? probe.details.join("; ") || "ok" : "Test the key again" },
      { id: "leverage", required: true, label: `Leverage ${cfg.leverages[0]}x settable`, ok: !!probe?.leverageSet && probe.leverage >= (cfg.liveSelection?.leverage ?? cfg.leverages[0] ?? 1), detail: probe ? `${probe.leverage}x on ${probe.symbol}` : "Test the key again" },
      { id: "clock", required: true, label: "Clock synced (< 500 ms)", ok: off != null && Math.abs(off) < 500, detail: off == null ? "unknown" : `${Math.round(off)} ms` },
      { id: "testnet", required: false, label: "Testnet pass recorded (recommended)", ok: !!passes[ex], detail: passes[ex] ? `${new Date(passes[ex]!.passedAt).toISOString().slice(0, 16)} (${passes[ex]!.checks.length} checks)` : "not recorded: optional, needs pnpm test:testnet from the source code" },
    ];
    return { exchange: ex, ready: items.every((i) => i.ok || !i.required), items };
  });
  return { ready: exchanges.length > 0 && exchanges.every((e) => e.ready), exchanges };
}
