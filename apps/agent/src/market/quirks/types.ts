export interface KeyPermissions {
  read: boolean | null;
  trade: boolean | null;
  withdraw: boolean | null;
  ipWhitelist: boolean | null;
  source: string;
}

/** Loose structural view of a ccxt client; values coming back are zod-parsed where decisions depend on them. */
export interface CcxtLike {
  id: string;
  has: Record<string, unknown>;
  options: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ExchangeQuirks {
  ccxtId: string;
  options: Record<string, unknown>;
  /** "sandbox" = ccxt setSandboxMode, "demo-trading" = ccxt enableDemoTrading (Binance), "demo" = OKX demo header, null = none */
  testnet: "sandbox" | "demo-trading" | "demo" | null;
  needsPassphrase: boolean;
  /** Reduce-only stop-market trigger params. */
  stopParams(trigger: "mark" | "last"): Record<string, unknown>;
  iocParams(): Record<string, unknown>;
  /** L2 depth to request (some venues only accept fixed values). Default 50. */
  bookLimit?: number;
  /** Read API key permissions where the exchange exposes them. */
  probePermissions(c: CcxtLike): Promise<KeyPermissions>;
}

export const unknownPermissions = (source: string): KeyPermissions => ({ read: null, trade: null, withdraw: null, ipWhitelist: null, source });

/** Point a ccxt client at the exchange's testnet / demo environment. Throws when there is none. */
export async function applyTestnet(c: CcxtLike, q: ExchangeQuirks): Promise<void> {
  if (q.testnet === "sandbox") await call(c, "setSandboxMode", true);
  else if (q.testnet === "demo-trading") {
    // Binance retired its futures testnet. ccxt still accepts setSandboxMode but every request then fails,
    // so Demo Trading is selected directly.
    if (typeof c.enableDemoTrading !== "function") throw new Error(`${c.id}: this ccxt version has no Demo Trading support`);
    await call(c, "enableDemoTrading", true);
  } else if (q.testnet === "demo") (c as { headers?: Record<string, string> }).headers = { "x-simulated-trading": "1" };
  else throw new Error(`${c.id} has no testnet`);
}

export async function call(c: CcxtLike, method: string, ...args: unknown[]): Promise<unknown> {
  const fn = c[method];
  if (typeof fn !== "function") throw new Error(`${c.id} has no ${method}`);
  return (fn as (...a: unknown[]) => Promise<unknown>).apply(c, args);
}
