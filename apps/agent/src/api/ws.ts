import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app";
import { tokenEquals } from "./server";

const AuthMsg = z.object({ type: z.literal("auth"), token: z.string() });

/** Realtime push. Browsers cannot set headers on WS, so the first message must carry the token (never in the URL). */
export function registerWs(f: FastifyInstance, app: App): void {
  f.get("/ws", { websocket: true }, (socket) => {
    let authed = false;
    const timer = setTimeout(() => !authed && socket.close(4401, "auth timeout"), 3000);
    const unsubs: (() => void)[] = [];
    const send = (type: string, data: unknown) => authed && socket.readyState === 1 && socket.send(JSON.stringify({ type, data }));
    socket.on("message", (raw: Buffer) => {
      if (authed) return;
      const m = AuthMsg.safeParse((() => { try { return JSON.parse(raw.toString()); } catch { return null; } })());
      if (!m.success || !tokenEquals(m.data.token, app.token())) return socket.close(4401, "unauthorized");
      authed = true;
      clearTimeout(timer);
      send("hello", { ok: true });
      unsubs.push(
        app.bus.on("signal", (d) => send("signal", d)),
        app.bus.on("trade:opened", (d) => send("trade:opened", d)),
        app.bus.on("trade:updated", (d) => send("trade:updated", d)),
        app.bus.on("trade:closed", (d) => send("trade:closed", d)),
        app.bus.on("bot:status", (d) => send("bot:status", d)),
        app.bus.on("scraper:status", (d) => send("scraper:status", d)),
        app.bus.on("alert", (d) => send("alert", d)),
        app.bus.on("snapshot", (s) => send("snapshot", { id: s.id, ts: s.ts, rows: s.rows.length, status: s.health.status })),
      );
    });
    socket.on("close", () => {
      clearTimeout(timer);
      for (const u of unsubs) u();
    });
  });
}
