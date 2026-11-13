import type { App } from "./app";
import { log } from "./log";

/**
 * A crashed agent stops managing open positions (trailing, TP1, exits; only the exchange stop remains).
 * Library errors thrown from timers / sockets (e.g. ccxt's WebSocket keep-alive on a closing socket) must never take
 * the process down: log them, put them on the Health error log, raise an alert, keep running.
 */
export function installProcessGuard(getApp: () => App | null): void {
  let last = 0;
  const handle = (kind: string, e: unknown) => {
    const msg = String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 400);
    log.error({ kind, err: msg }, "uncaught error contained");
    const app = getApp();
    const now = Date.now();
    try {
      app?.store.records.addError(now, "process", kind, msg);
      if (now - last > 60_000) {
        last = now; // at most one alert a minute (a flapping socket would otherwise flood)
        app?.bus.emit("alert", { level: "error", kind: "AGENT_ERROR", message: `Contained ${kind}: ${msg.slice(0, 160)}`, ts: now });
      }
    } catch {
      /* store may be closed during shutdown */
    }
  };
  process.on("uncaughtException", (e) => handle("uncaughtException", e));
  process.on("unhandledRejection", (e) => handle("unhandledRejection", e));
}
