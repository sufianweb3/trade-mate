import type { ExchangeId } from "@oisniper/core";
import type { App } from "../app";
import { buildKeyReport, type KeyReport } from "../execution/keyReport";
import type { SetupProbe } from "../execution/liveAccounts";
import { log } from "../log";
import type { KeySecret } from "../vault/vault";

const PROBE_SYMBOL = "BTC/USDT:USDT";

function realLeverage(app: App): number {
  const cfg = app.bots.get("real").config();
  return cfg.liveSelection?.leverage ?? cfg.leverages[0] ?? 1;
}

/** Report for a key already in use (exchange cards, after a restart). */
export function currentKeyReport(app: App, ex: ExchangeId): KeyReport | null {
  const st = app.accounts.statusOf(ex);
  if (!st) return null;
  const probe = app.store.getSetting<SetupProbe | null>(`readiness:${ex}`, null);
  const off = app.o.hub.health().find((h) => h.exchange === ex)?.clockOffsetMs ?? null;
  return buildKeyReport(st, probe, off, realLeverage(app));
}

/**
 * Paste -> test -> connected or warning. Accepted keys are encrypted and stored, then the account is prepared for Real
 * (isolated margin, one-way mode, leverage on BTC/USDT, the settings the bot applies anyway before its first order).
 * A failed test leaves the key in use untouched.
 */
export async function testAndConnectKey(app: App, ex: ExchangeId, s: KeySecret, o: { testnet?: boolean; confirmNoWithdraw: boolean }): Promise<KeyReport> {
  const tested = await app.accounts.test(ex, s, o.testnet, o.confirmNoWithdraw);
  const st = tested.status;
  const accepted = st.status === "connected" || st.status === "unverified";
  const off = app.o.hub.health().find((h) => h.exchange === ex)?.clockOffsetMs ?? null;
  if (!accepted || !tested.client) return buildKeyReport(st, null, off, realLeverage(app));

  app.accounts.adopt(tested);
  app.store.records.upsertKey({ exchange: ex, enc: app.vault.encrypt(s), masked: st.masked, permissions: st.permissions, status: st.status, testnet: st.testnet, created_at: Date.now() });
  app.syncLimitLoaders();
  let probe: SetupProbe | null = null;
  if (st.tradeEnabled) {
    try {
      probe = await app.accounts.probeSetup(ex, PROBE_SYMBOL, realLeverage(app));
      app.store.setSetting(`readiness:${ex}`, probe);
    } catch (e) {
      log.warn({ ex, err: String((e as Error).message).slice(0, 160) }, "account setup probe failed");
    }
  }
  return buildKeyReport(st, probe, off, realLeverage(app));
}

/** Re-test the stored key (Test again button). */
export async function retestStoredKey(app: App, ex: ExchangeId): Promise<KeyReport | null> {
  const k = app.store.records.listKeys().find((r) => r.exchange === ex);
  if (!k) return null;
  return testAndConnectKey(app, ex, app.vault.decrypt(k.enc), { testnet: k.testnet, confirmNoWithdraw: k.status === "unverified" });
}
