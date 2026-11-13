import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { App } from "../app";
import { redact } from "../log";
import { registerRoutes } from "./routes";
import { registerWs } from "./ws";

export const VERSION = "2.0.0";

export interface ServerOptions {
  port: number;
  panelDir: string | null;
  allowedOrigins: string[];
}

export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Binds 127.0.0.1 only. Bearer token on every /api route; GET /health is open. */
export async function buildServer(app: App, o: ServerOptions): Promise<FastifyInstance> {
  const f = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const allowed = new Set([...o.allowedOrigins, `http://localhost:${o.port}`, `http://127.0.0.1:${o.port}`]);

  f.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "authorization, content-type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      reply.header("Access-Control-Allow-Private-Network", "true");
      reply.header("Access-Control-Max-Age", "600");
    }
    // Static export quirk: when a client-side navigation fails (agent busy, new build), Next.js hard-navigates to the
    // RSC payload URL (/x/index.txt) and the browser shows raw "1:"$Sreact.fragment"..." text. A top-level page load
    // of a .txt payload is never wanted: send it to the page itself. Next's own RSC fetches carry the RSC header.
    if (req.method === "GET" && !req.headers.rsc && req.headers["sec-fetch-dest"] === "document") {
      const path = req.url.split("?")[0]!;
      const page = path.endsWith("/index.txt") ? path.slice(0, -"index.txt".length) : path.endsWith(".txt") ? `${path.slice(0, -4)}/` : null;
      if (page != null && !path.startsWith("/api") && !path.startsWith("/_next")) return reply.redirect(page, 302);
    }
    if (req.method === "OPTIONS") {
      return reply.code(origin && allowed.has(origin) ? 204 : 403).send();
    }
    if (origin && !allowed.has(origin) && req.url.startsWith("/api")) return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
    if (req.url.startsWith("/api")) {
      const h = req.headers.authorization ?? "";
      const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
      if (!tok || !tokenEquals(tok, app.token())) return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  });

  // Last line of defence: nothing secret-shaped ever leaves in a JSON response.
  f.addHook("preSerialization", async (_req, _reply, payload) => redact(payload));

  f.setErrorHandler((e, _req, reply) => {
    const err = e as Error;
    const code = (err as { code?: string }).code;
    const status = (err as { statusCode?: number }).statusCode ?? (code === "NOT_FOUND" ? 404 : code ? 400 : 500);
    reply.code(status).send({ error: code ?? "INTERNAL", message: String(err.message).slice(0, 300), issues: (err as { issues?: unknown }).issues });
  });

  f.get("/health", async () => ({ ok: true, name: "oisniper-agent", version: VERSION, uptimeMs: app.o.clock.now() - app.startedAt }));

  await f.register(fastifyWebsocket);
  registerWs(f, app);
  registerRoutes(f, app);

  if (o.panelDir && existsSync(o.panelDir)) {
    await f.register(fastifyStatic, { root: o.panelDir, prefix: "/", extensions: ["html"], index: ["index.html"] });
  } else {
    f.get("/", async (_r, reply) => reply.type("text/html").send("<h1>OI Sniper agent</h1><p>Panel not built. Run <code>pnpm build</code>.</p>"));
  }
  return f;
}
