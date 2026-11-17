import { D } from "@oisniper/core";
import type { AccountStatus, SetupProbe } from "./liveAccounts";

export type CheckState = "ok" | "warn" | "fail";
export interface KeyCheck {
  id: "auth" | "balance" | "withdraw" | "trade" | "ip" | "fee" | "isolated" | "one_way" | "leverage" | "clock" | "testnet_key";
  label: string;
  state: CheckState;
  detail: string;
}
/** connected = every check ok; warning = key saved, something needs a look; failed = key not saved. */
export type KeyVerdict = "connected" | "warning" | "failed";
export interface KeyReport {
  exchange: string;
  masked: string;
  testnet: boolean;
  verdict: KeyVerdict;
  /** One-line summary for the card header. */
  summary: string;
  checks: KeyCheck[];
  /** Ask the user to confirm the key has no withdrawal permission, then test again. */
  needsConfirm: "no_withdraw" | null;
}

const CLOCK_MAX_MS = 500;

/**
 * Turn a key test (plus the margin / position-mode / leverage setup and the clock) into one plain report.
 * Pure: everything it needs is passed in.
 */
export function buildKeyReport(st: AccountStatus, probe: SetupProbe | null, clockOffsetMs: number | null, leverage: number): KeyReport {
  const checks: KeyCheck[] = [];
  const add = (id: KeyCheck["id"], label: string, state: CheckState, detail: string) => checks.push({ id, label, state, detail });

  add("auth", "Key accepted by the exchange", st.authOk ? "ok" : "fail", st.authOk ? (st.testnet ? "signed in (testnet / demo)" : "signed in") : st.reason ?? "not tested");
  if (st.authOk) {
    if (st.freeUsdt == null) add("balance", "USDT futures balance", "warn", "balance not readable");
    else add("balance", "USDT futures balance", D(st.freeUsdt).gt(0) ? "ok" : "warn", D(st.freeUsdt).gt(0) ? `${D(st.freeUsdt).toFixed(2)} USDT free` : "0 USDT free: move USDT to the futures wallet before trading");

    const w = st.permissions?.withdraw;
    if (w === true) add("withdraw", "No withdrawal permission", "fail", "Key can withdraw. Create a new key with read + futures trade only.");
    else if (w === false) add("withdraw", "No withdrawal permission", "ok", "read from the exchange");
    else if (st.needsNoWithdrawConfirm) add("withdraw", "No withdrawal permission", "warn", "This exchange does not show it. Confirm your key has no withdrawal permission.");
    else add("withdraw", "No withdrawal permission", "warn", "Exchange does not show it; you confirmed it is off");

    const accepted = st.status === "connected" || st.status === "unverified";
    if (st.permissions?.trade === false) add("trade", "Futures trading allowed", "fail", "Key lacks futures trade permission");
    else if (accepted) add("trade", "Futures trading allowed", st.tradeEnabled ? "ok" : "warn", st.tradeEnabled ? "order endpoints answer" : "order endpoints unavailable: data + paper only");

    if (st.permissions?.ipWhitelist === true) add("ip", "IP whitelist", "ok", "key is locked to your IP");
    else if (st.permissions?.ipWhitelist === false) add("ip", "IP whitelist", "warn", "No IP whitelist. Recommended: lock the key to your IP on the exchange.");

    if (accepted) add("fee", "Fee tier", st.takerPct ? "ok" : "warn", st.takerPct ? `taker ${st.takerPct}%` : "not readable, using the base tier");
  }

  if (probe) {
    const setupDetail = probe.details.join("; ");
    add("isolated", "Isolated margin", probe.isolated ? "ok" : "warn", probe.isolated ? `set on ${probe.symbol}` : setupDetail || "could not set");
    add("one_way", "One-way position mode", probe.oneWay ? "ok" : "warn", probe.oneWay ? "set" : setupDetail || "could not set");
    const levOk = probe.leverageSet && probe.leverage >= leverage;
    add("leverage", `Leverage ${leverage}x`, levOk ? "ok" : "warn", levOk ? `set on ${probe.symbol}` : setupDetail || "could not set");
  }

  if (st.authOk) {
    if (clockOffsetMs == null) add("clock", "Clock in sync", "warn", "offset unknown yet");
    else add("clock", "Clock in sync", Math.abs(clockOffsetMs) < CLOCK_MAX_MS ? "ok" : "warn", `${Math.round(clockOffsetMs)} ms${Math.abs(clockOffsetMs) < CLOCK_MAX_MS ? "" : ": sync your PC clock (Windows Settings > Time > Sync now)"}`);
    if (st.testnet) add("testnet_key", "Real account", "warn", "This is a testnet / demo key: Real trades go to the testnet, not your real balance.");
  }

  const verdict: KeyVerdict = checks.some((c) => c.state === "fail") || !(st.status === "connected" || st.status === "unverified") ? "failed" : checks.some((c) => c.state === "warn") ? "warning" : "connected";
  const firstProblem = checks.find((c) => c.state === "fail") ?? checks.find((c) => c.state === "warn");
  const summary =
    verdict === "connected" ? "Connected. Everything checked out."
    : verdict === "warning" ? `Connected with ${checks.filter((c) => c.state === "warn").length} warning(s): ${firstProblem?.detail ?? ""}`
    : st.needsNoWithdrawConfirm ? "Confirm the key has no withdrawal permission to finish."
    : `Not connected: ${firstProblem?.detail ?? st.reason ?? "unknown error"}`;
  return { exchange: st.exchange, masked: st.masked, testnet: st.testnet, verdict, summary, checks, needsConfirm: st.needsNoWithdrawConfirm ? "no_withdraw" : null };
}
