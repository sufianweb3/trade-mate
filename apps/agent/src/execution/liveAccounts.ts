import { D, Decimal, type ExchangeId } from "@oisniper/core";
import { z } from "zod";
import { log } from "../log";
import { QUIRKS, type CcxtLike, type KeyPermissions } from "../market/quirks";
import { applyTestnet, call } from "../market/quirks/types";
import type { Store } from "../store/store";
import { maskKey, type KeySecret, type Vault } from "../vault/vault";

export interface AccountStatus {
  exchange: ExchangeId;
  masked: string;
  testnet: boolean;
  status: "connected" | "rejected" | "error" | "unverified";
  tradeEnabled: boolean;
  permissions: KeyPermissions | null;
  takerPct: string | null;
  reason: string | null;
  warnings: string[];
}

export interface SetupProbe {
  ts: number;
  symbol: string;
  leverage: number;
  isolated: boolean;
  oneWay: boolean;
  leverageSet: boolean;
  details: string[];
}

const Balance = z.object({ USDT: z.object({ free: z.number().nullable().optional(), total: z.number().nullable().optional() }).partial().optional() }).passthrough();
const Fee = z.object({ taker: z.number().nullable().optional() }).passthrough();

/** Private ccxt clients built from vault keys. Secrets are never returned or logged. */
export class LiveAccounts {
  private clients = new Map<ExchangeId, CcxtLike>();
  private status = new Map<ExchangeId, AccountStatus>();

  constructor(private d: { store: Store; vault: Vault }) {}

  get(ex: ExchangeId): CcxtLike | null {
    return this.clients.get(ex) ?? null;
  }
  statusOf(ex: ExchangeId): AccountStatus | null {
    return this.status.get(ex) ?? null;
  }
  list(): AccountStatus[] {
    return [...this.status.values()];
  }
  canTrade(ex: ExchangeId): boolean {
    const s = this.status.get(ex);
    return !!s && s.tradeEnabled && (s.status === "connected" || s.status === "unverified");
  }

  private async build(ex: ExchangeId, s: KeySecret, testnet: boolean): Promise<CcxtLike> {
    const q = QUIRKS[ex];
    const ccxt = (await import("ccxt")) as unknown as { pro: Record<string, new (o: Record<string, unknown>) => CcxtLike> };
    const Ctor = ccxt.pro[q.ccxtId];
    if (!Ctor) throw new Error(`ccxt ${q.ccxtId} missing`);
    const c = new Ctor({ apiKey: s.apiKey, secret: s.secret, password: s.passphrase, enableRateLimit: true, options: { ...q.options } });
    if (testnet) await applyTestnet(c, q);
    return c;
  }

  /** Validate a key: auth works, read perms, refuse withdrawal, probe trade endpoints. */
  async connect(ex: ExchangeId, s: KeySecret, testnet: boolean, userConfirmedNoWithdraw: boolean): Promise<AccountStatus> {
    const q = QUIRKS[ex];
    const st: AccountStatus = { exchange: ex, masked: maskKey(s.apiKey), testnet, status: "error", tradeEnabled: false, permissions: null, takerPct: null, reason: null, warnings: [] };
    if (q.needsPassphrase && !s.passphrase) return this.save(ex, { ...st, status: "rejected", reason: "This exchange needs an API passphrase." }, null);
    let c: CcxtLike;
    try {
      c = await this.build(ex, s, testnet);
      Balance.parse(await call(c, "fetchBalance", { type: "swap" }));
    } catch (e) {
      return this.save(ex, { ...st, status: "error", reason: `Auth failed: ${mapMsg(e)}` }, null);
    }
    let perms: KeyPermissions | null = null;
    try {
      perms = await q.probePermissions(c);
    } catch (e) {
      st.warnings.push(`Could not read permissions: ${mapMsg(e)}`);
    }
    st.permissions = perms;
    if (perms?.withdraw === true) return this.save(ex, { ...st, status: "rejected", reason: "Key has withdrawal permission. Create a key with read + futures trade only." }, null);
    if (perms?.withdraw == null && !userConfirmedNoWithdraw)
      return this.save(ex, { ...st, status: "rejected", reason: "Permissions cannot be verified on this exchange. Confirm the key has no withdrawal permission to continue." }, null);
    if (perms?.ipWhitelist === false) st.warnings.push("No IP whitelist on this key.");
    if (perms?.trade === false) return this.save(ex, { ...st, status: "rejected", reason: "Key lacks futures trade permission." }, null);
    st.tradeEnabled = await this.probeTrading(ex, c);
    if (!st.tradeEnabled) st.warnings.push("Order endpoints unavailable: data + paper only.");
    try {
      const f = Fee.parse(await call(c, "fetchTradingFee", "BTC/USDT:USDT"));
      if (f.taker != null) st.takerPct = D(f.taker).mul(100).toString();
    } catch {
      st.warnings.push("Fee tier not readable, using market base tier.");
    }
    st.status = perms?.withdraw === false ? "connected" : "unverified";
    return this.save(ex, st, c);
  }

  /** MEXC-style suspended endpoints: cancel a non-existent order and inspect the error. Places nothing. */
  private async probeTrading(ex: ExchangeId, c: CcxtLike): Promise<boolean> {
    try {
      await call(c, "cancelOrder", "0", "BTC/USDT:USDT");
      return true;
    } catch (e) {
      const m = String((e as Error).message).toLowerCase();
      const ok = /not ?found|does not exist|unknown order|order_not_exist|invalid order|-2011|110001|51603/.test(m);
      if (!ok) log.warn({ ex, err: m.slice(0, 200) }, "trade probe failed");
      return ok;
    }
  }

  private save(ex: ExchangeId, st: AccountStatus, c: CcxtLike | null): AccountStatus {
    this.status.set(ex, st);
    if (c) this.clients.set(ex, c);
    else this.clients.delete(ex);
    return st;
  }

  /** Re-open stored keys at startup. */
  async loadStored(): Promise<void> {
    if (!this.d.vault.unlocked) return;
    for (const k of this.d.store.records.listKeys()) {
      try {
        const s = this.d.vault.decrypt(k.enc);
        const st = await this.connect(k.exchange as ExchangeId, s, k.testnet, k.status === "unverified");
        this.d.store.records.upsertKey({ ...k, status: st.status, permissions: st.permissions, created_at: Date.now() });
      } catch (e) {
        log.warn({ ex: k.exchange, err: mapMsg(e) }, "stored key failed");
      }
    }
  }

  async freeUsdt(ex: ExchangeId): Promise<Decimal | null> {
    const c = this.clients.get(ex);
    if (!c) return null;
    const b = Balance.parse(await call(c, "fetchBalance", { type: "swap" }));
    return b.USDT?.free != null ? D(b.USDT.free) : null;
  }

  /**
   * Readiness probe (user-triggered from the Exchanges page): set isolated margin, one-way mode and leverage on a
   * symbol, then read them back where the exchange allows. These are account settings the bot would set anyway
   * before its first order on that symbol.
   */
  async probeSetup(ex: ExchangeId, symbol: string, leverage: number): Promise<SetupProbe> {
    const c = this.clients.get(ex);
    const r: SetupProbe = { ts: Date.now(), symbol, leverage, isolated: false, oneWay: false, leverageSet: false, details: [] };
    if (!c) return { ...r, details: ["not connected"] };
    const ok = (e: unknown) => /no need|not modified|already|same|unchanged|110026|110025|59107|-4046|-4059/i.test(String((e as Error).message));
    try {
      await call(c, "setMarginMode", "isolated", symbol);
      r.isolated = true;
    } catch (e) {
      r.isolated = ok(e);
      if (!r.isolated) r.details.push(`margin mode: ${mapMsg(e)}`);
    }
    try {
      await call(c, "setPositionMode", false, symbol);
      r.oneWay = true;
    } catch (e) {
      r.oneWay = ok(e);
      if (!r.oneWay) r.details.push(`position mode: ${mapMsg(e)}`);
    }
    try {
      await call(c, "setLeverage", leverage, symbol);
      r.leverageSet = true;
    } catch (e) {
      r.leverageSet = ok(e);
      if (!r.leverageSet) r.details.push(`leverage: ${mapMsg(e)}`);
    }
    // read back where supported (a "set" that silently did nothing must not pass)
    if (c.has.fetchMarginMode)
      await call(c, "fetchMarginMode", symbol)
        .then((m) => {
          const mode = String((m as { marginMode?: string }).marginMode ?? "");
          if (mode && mode !== "isolated") {
            r.isolated = false;
            r.details.push(`margin mode reads back as ${mode}`);
          }
        })
        .catch(() => undefined);
    if (c.has.fetchPositionMode)
      await call(c, "fetchPositionMode", symbol)
        .then((m) => {
          if ((m as { hedged?: boolean }).hedged === true) {
            r.oneWay = false;
            r.details.push("position mode reads back as hedge");
          }
        })
        .catch(() => undefined);
    return r;
  }

  /** Read-only adapter check (Gate / KuCoin / MEXC with read-only keys): balance, positions, leverage, margin mode. */
  async readOnlyCheck(ex: ExchangeId, symbol: string): Promise<Record<string, string>> {
    const c = this.clients.get(ex);
    if (!c) return { error: "not connected" };
    const out: Record<string, string> = {};
    const run = async (k: string, m: string, ...a: unknown[]) => {
      if (!c.has[m]) return void (out[k] = "not supported by ccxt");
      try {
        const v = await call(c, m, ...a);
        out[k] = `ok ${JSON.stringify(v).slice(0, 80)}`;
      } catch (e) {
        out[k] = `error ${mapMsg(e)}`;
      }
    };
    await run("balance", "fetchBalance", { type: "swap" });
    await run("positions", "fetchPositions");
    await run("leverage", "fetchLeverage", symbol);
    await run("marginMode", "fetchMarginMode", symbol);
    return out;
  }

  remove(ex: ExchangeId): void {
    this.clients.delete(ex);
    this.status.delete(ex);
  }
}

export const mapMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);
