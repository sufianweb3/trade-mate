import { describe, expect, it } from "vitest";
import { buildKeyReport } from "../src/execution/keyReport";
import type { AccountStatus, SetupProbe } from "../src/execution/liveAccounts";

const good: AccountStatus = {
  exchange: "binance", masked: "abcd••••wxyz", testnet: false, status: "connected", tradeEnabled: true,
  permissions: { read: true, trade: true, withdraw: false, ipWhitelist: true, source: "test" }, takerPct: "0.05", reason: null, warnings: [],
  authOk: true, needsNoWithdrawConfirm: false, freeUsdt: "250.5",
};
const probe: SetupProbe = { ts: 1, symbol: "BTC/USDT:USDT", leverage: 10, isolated: true, oneWay: true, leverageSet: true, details: [] };
const state = (r: ReturnType<typeof buildKeyReport>, id: string) => r.checks.find((c) => c.id === id)?.state;

describe("API key test report", () => {
  it("everything fine: Connected", () => {
    const r = buildKeyReport(good, probe, 40, 10);
    expect(r.verdict).toBe("connected");
    expect(r.checks.every((c) => c.state === "ok")).toBe(true);
    expect(r.checks.find((c) => c.id === "balance")?.detail).toBe("250.50 USDT free");
  });

  it("bad key: Failed with the exchange reason, nothing else claimed", () => {
    const r = buildKeyReport({ ...good, status: "error", authOk: false, reason: "Auth failed: invalid signature", permissions: null }, null, 40, 10);
    expect(r.verdict).toBe("failed");
    expect(r.checks).toHaveLength(1);
    expect(r.summary).toContain("invalid signature");
  });

  it("withdrawal permission: Failed (never accepted)", () => {
    const r = buildKeyReport({ ...good, status: "rejected", permissions: { ...good.permissions!, withdraw: true } }, null, 40, 10);
    expect(r.verdict).toBe("failed");
    expect(state(r, "withdraw")).toBe("fail");
  });

  it("hidden permissions: asks for the no-withdraw confirmation", () => {
    const r = buildKeyReport({ ...good, status: "rejected", needsNoWithdrawConfirm: true, permissions: null }, null, 40, 10);
    expect(r.verdict).toBe("failed");
    expect(r.needsConfirm).toBe("no_withdraw");
    expect(r.summary).toMatch(/Confirm/);
  });

  it("confirmed hidden permissions: Warning, key kept", () => {
    const r = buildKeyReport({ ...good, status: "unverified", permissions: null }, probe, 40, 10);
    expect(r.verdict).toBe("warning");
    expect(state(r, "withdraw")).toBe("warn");
  });

  it("no trade permission: Failed", () => {
    const r = buildKeyReport({ ...good, status: "rejected", permissions: { ...good.permissions!, trade: false } }, null, 40, 10);
    expect(r.verdict).toBe("failed");
    expect(state(r, "trade")).toBe("fail");
  });

  it("warnings: no IP whitelist, empty wallet, clock drift, leverage not set, testnet key", () => {
    const r = buildKeyReport(
      { ...good, testnet: true, freeUsdt: "0", permissions: { ...good.permissions!, ipWhitelist: false } },
      { ...probe, leverageSet: false, details: ["leverage: max 5x"] },
      900,
      10,
    );
    expect(r.verdict).toBe("warning");
    for (const id of ["ip", "balance", "clock", "leverage", "testnet_key"]) expect(state(r, id)).toBe("warn");
    expect(r.checks.find((c) => c.id === "leverage")?.detail).toContain("max 5x");
  });

  it("order endpoints unavailable (MEXC style): Warning, data + paper only", () => {
    const r = buildKeyReport({ ...good, tradeEnabled: false }, null, 40, 10);
    expect(r.verdict).toBe("warning");
    expect(state(r, "trade")).toBe("warn");
  });

  it("never carries a secret: only the masked key", () => {
    const r = buildKeyReport(good, probe, 40, 10);
    expect(JSON.stringify(r)).not.toMatch(/secret|passphrase/i);
    expect(r.masked).toBe("abcd••••wxyz");
  });
});
