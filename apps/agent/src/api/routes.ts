import {
  BotConfigSchema, EXCHANGES, ExchangeId, expandProfiles, exitPreview, validateBotConfig,
} from "@oisniper/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../app";
import { buildExport } from "../export/exportPack";
import { QUIRKS } from "../market/quirks";
import { KeySecretSchema } from "../vault/vault";
import { analytics, openRow, overview } from "./analytics";
import { VERSION } from "./server";
import { cooldownState } from "../engine/cooldown";
import { sourceComparison } from "./compare";
import { realReadiness } from "./readiness";
import { latencyStats } from "./latency";

const num = z.coerce.number().int().optional();
const TradeQuery = z.object({
  bot: z.string().optional(), run: z.string().optional(), status: z.enum(["open", "closed"]).optional(), exchange: z.string().optional(),
  symbol: z.string().optional(), leverage: num, variant: z.string().optional(), mode: z.string().optional(),
  result: z.enum(["win", "loss"]).optional(), from: num, to: num, limit: num,
});
const SignalQuery = z.object({ bot: z.string().optional(), run: z.string().optional(), status: z.string().optional(), reason: z.string().optional(), from: num, to: num, limit: num });
const StartBody = z.object({ confirm: z.string().optional() }).default({});
const KeyBody = KeySecretSchema.extend({ testnet: z.boolean().default(false), confirmNoWithdraw: z.boolean().default(false) });
const Settings = z.object({
  scrapeIntervalMs: z.number().int().min(15000).max(120000).optional(),
  coinglassUrl: z.string().url().optional(),
  warmSetSize: z.number().int().min(0).max(100).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
});

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.output<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw Object.assign(new Error("invalid request"), { code: "INVALID_CONFIG", statusCode: 400, issues: r.error.issues });
  return r.data;
};

export function registerRoutes(f: FastifyInstance, app: App): void {
  const now = () => app.o.clock.now();

  f.get("/api/state", async () => ({
    version: VERSION,
    now: now(),
    killSwitch: app.bots.killSwitchActive,
    liveRunning: app.bots.anyLiveRunning(),
    scraper: app.scraper.state,
    exchangeData: app.exchangeData?.state ?? null,
    bots: [...app.bots.bots.values()].map((b) => ({ id: b.id, name: b.row().name, mode: b.mode, status: b.row().status, reason: b.row().status_reason, open: b.pm.openCount() })),
  }));

  f.get("/api/overview", async (req) => {
    const q = parse(z.object({ bot: z.string().default("all"), from: num }), req.query);
    return overview(app, q.bot, q.from ?? 0);
  });
  f.get("/api/positions", async () => [...app.bots.bots.values()].flatMap((b) => b.pm.openTrades().map((t) => openRow(app, t))));

  // ---- bots ----
  f.get("/api/bots", async () =>
    [...app.bots.bots.values()].map((b) => ({ ...b.row(), config: b.config(), run: b.run(), runs: app.store.listRuns(b.id), validation: validateBotConfig(b.config()) })),
  );
  f.get("/api/bots/:id/versions", async (req) => app.store.listVersions((req.params as { id: string }).id));
  f.post("/api/bots/:id/validate", async (req) => {
    const cfg = parse(BotConfigSchema, req.body);
    return { ...validateBotConfig(cfg), previews: expandProfiles(cfg).slice(0, 40).map((p) => ({ variantId: p.variantId, ...stringify(exitPreview(p)) })) };
  });
  f.put("/api/bots/:id/config", async (req) => {
    const b = app.bots.get((req.params as { id: string }).id);
    const cfg = parse(BotConfigSchema, req.body);
    const versionId = b.saveConfig(cfg);
    return { versionId };
  });
  f.post("/api/bots/:id/start", async (req) => {
    const b = app.bots.get((req.params as { id: string }).id);
    const body = parse(StartBody, req.body ?? {});
    if (b.mode === "live" && body.confirm !== "LIVE") throw Object.assign(new Error("Type LIVE to confirm live trading."), { code: "INVALID_CONFIG" });
    if (b.mode === "live") {
      const r = realReadiness(app);
      if (!r.ready) {
        const missing = r.exchanges.flatMap((e) => e.items.filter((i) => !i.ok).map((i) => `${e.exchange}: ${i.label}`));
        throw Object.assign(new Error(`Real Mode Readiness not complete: ${missing.join("; ") || "no exchange key connected"}`), { code: "AUTH_FAILED" });
      }
    }
    if (app.bots.killSwitchActive) app.bots.releaseKill();
    await b.start();
    return { ok: true };
  });
  f.post("/api/bots/:id/stop", async (req) => {
    const body = parse(z.object({ closePositions: z.boolean().default(false) }).default({}), req.body ?? {});
    await app.bots.get((req.params as { id: string }).id).stop("USER", body.closePositions);
    return { ok: true };
  });
  f.get("/api/bots/:id/cooldowns", async (req) => {
    const b = app.bots.get((req.params as { id: string }).id);
    const now = app.o.clock.now();
    const { cooldownHours: hours, reentry } = b.config();
    const open = new Set(b.pm.openTrades().map((t) => t.symbol));
    const rows = app.store.cooldownRows(b.id).map((r) => ({ symbol: r.symbol, lastEntry: r.last_entry_at, lastClose: r.last_close_at }));
    for (const s of open) if (!rows.some((r) => r.symbol === s)) rows.push({ symbol: s, lastEntry: now, lastClose: null });
    return rows
      .map((r) => ({ ...r, ...cooldownState({ hasOpen: open.has(r.symbol), lastEntry: r.lastEntry, lastClose: r.lastClose, now, hours, reentry }) }))
      .filter((r) => r.blocked)
      .map((r) => ({ symbol: r.symbol, cause: r.cause, until: r.until, remainingMs: r.until ? r.until - now : null, lastEntry: r.lastEntry, lastClose: r.lastClose }))
      .sort((a, b) => (b.remainingMs ?? Infinity) - (a.remainingMs ?? Infinity));
  });
  f.post("/api/bots/:id/reset", async (req) => {
    const b = app.bots.get((req.params as { id: string }).id);
    const run = await b.resetRun();
    return { ok: true, runId: run.id };
  });
  f.get("/api/bots/:id/preset", async (req) => {
    const b = app.bots.get((req.params as { id: string }).id);
    return { format: "oisniper-preset@1", config: b.config() };
  });
  f.post("/api/bots/:id/preset", async (req) => {
    const body = parse(z.object({ format: z.literal("oisniper-preset@1"), config: BotConfigSchema }), req.body);
    const b = app.bots.get((req.params as { id: string }).id);
    return { versionId: b.saveConfig({ ...body.config, mode: b.mode }) };
  });
  f.put("/api/bots/:id/layout", async (req) => {
    const body = parse(z.object({ cards: z.array(z.object({ id: z.string(), visible: z.boolean() })).max(40) }), req.body);
    app.store.updateBot((req.params as { id: string }).id, { layout: JSON.stringify(body) });
    return { ok: true };
  });

  // ---- signals / trades ----
  f.get("/api/signals", async (req) => {
    const q = parse(SignalQuery, req.query);
    // Slim rows (no per-variant gates / router); the panel loads one full signal when a row is expanded.
    return app.store.records.listSignalsSlim({ botId: q.bot, runId: q.run, status: q.status, reason: q.reason, from: q.from, to: q.to, limit: Math.min(q.limit ?? 300, 1000) });
  });
  f.get("/api/signals/:id", async (req) => {
    const s = app.store.records.getSignalFull((req.params as { id: string }).id);
    if (!s) throw Object.assign(new Error("signal not found"), { code: "NOT_FOUND" });
    return s;
  });
  f.get("/api/trades", async (req) => {
    const q = parse(TradeQuery, req.query);
    return app.store.records.listTrades({ botId: q.bot, runId: q.run, status: q.status, exchange: q.exchange, symbol: q.symbol, leverage: q.leverage, variantId: q.variant, mode: q.mode, result: q.result, from: q.from, to: q.to, limit: q.limit ?? 500 }).map(({ state: _s, ...t }) => t);
  });
  f.get("/api/trades/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const t = app.store.records.getTrade(id);
    if (!t) throw Object.assign(new Error("trade not found"), { code: "NOT_FOUND" });
    return { trade: t, events: app.store.records.events(id) };
  });
  f.post("/api/trades/:id/close", async (req) => {
    const id = (req.params as { id: string }).id;
    for (const b of app.bots.bots.values()) if (b.pm.has(id)) return { ok: await b.pm.closeTrade(id, "MANUAL") };
    throw Object.assign(new Error("open trade not found"), { code: "NOT_FOUND" });
  });
  f.get("/api/analytics/sources", async (req) => {
    const q = parse(z.object({ bot: z.string() }), req.query);
    return sourceComparison(app, q.bot);
  });
  f.get("/api/latency", async () => latencyStats(app));
  f.get("/api/analytics", async (req) => {
    const q = parse(z.object({ bot: z.string().optional(), run: z.string().optional() }), req.query);
    return analytics(app, q.bot, q.run);
  });
  f.post("/api/export", async (req, reply) => {
    const q = parse(z.object({ botId: z.string().optional(), runId: z.string().optional(), mode: z.string().optional(), exchange: z.string().optional(), from: z.number().optional(), to: z.number().optional() }), req.body ?? {});
    const r = await buildExport(app.store, q, now());
    reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${r.fileName}"`);
    return reply.send(Buffer.from(r.bytes));
  });

  // ---- exchanges / keys ----
  f.get("/api/exchanges", async () => {
    const health = app.o.hub.health();
    const stored = app.store.records.listKeys();
    return EXCHANGES.map((ex) => {
      const st = app.accounts.statusOf(ex);
      const k = stored.find((s) => s.exchange === ex);
      return {
        exchange: ex, needsPassphrase: QUIRKS[ex].needsPassphrase, testnetAvailable: QUIRKS[ex].testnet != null,
        health: health.find((h) => h.exchange === ex) ?? null, markets: app.o.hub.markets(ex).length,
        key: k ? { masked: k.masked, testnet: k.testnet, status: st?.status ?? k.status, permissions: st?.permissions ?? k.permissions, tradeEnabled: st?.tradeEnabled ?? false, takerPct: st?.takerPct ?? null, reason: st?.reason ?? null, warnings: st?.warnings ?? [] } : null,
      };
    });
  });
  f.post("/api/exchanges/:ex/keys", async (req) => {
    const ex = parse(ExchangeId, (req.params as { ex: string }).ex);
    const body = parse(KeyBody, req.body);
    if (!app.vault.unlocked) throw Object.assign(new Error(`Key vault is locked: ${app.vault.lockReason ?? "OS keychain unavailable and no OISNIPER_PASSPHRASE set."}`), { code: "AUTH_FAILED" });
    const st = await app.accounts.connect(ex, { apiKey: body.apiKey, secret: body.secret, passphrase: body.passphrase }, body.testnet, body.confirmNoWithdraw);
    if (st.status === "connected" || st.status === "unverified")
      app.store.records.upsertKey({ exchange: ex, enc: app.vault.encrypt({ apiKey: body.apiKey, secret: body.secret, passphrase: body.passphrase }), masked: st.masked, permissions: st.permissions, status: st.status, testnet: body.testnet, created_at: now() });
    app.syncLimitLoaders();
    return st; // masked only
  });
  f.get("/api/real/readiness", async () => realReadiness(app));
  // User-triggered: sets isolated margin, one-way mode and leverage on a symbol, then reads them back.
  f.post("/api/exchanges/:ex/prepare", async (req) => {
    const ex = parse(ExchangeId, (req.params as { ex: string }).ex);
    const cfg = app.bots.get("real").config();
    const b = parse(z.object({ symbol: z.string().default("BTC/USDT:USDT") }), req.body ?? {});
    const r = await app.accounts.probeSetup(ex, b.symbol, cfg.liveSelection?.leverage ?? cfg.leverages[0] ?? 1);
    app.store.setSetting(`readiness:${ex}`, r);
    return r;
  });
  f.post("/api/exchanges/:ex/readonly-check", async (req) => {
    const ex = parse(ExchangeId, (req.params as { ex: string }).ex);
    return app.accounts.readOnlyCheck(ex, "BTC/USDT:USDT");
  });
  f.delete("/api/exchanges/:ex/keys", async (req) => {
    const ex = parse(ExchangeId, (req.params as { ex: string }).ex);
    app.store.records.deleteKey(ex);
    app.accounts.remove(ex);
    app.syncLimitLoaders();
    return { ok: true };
  });

  // ---- health / settings / kill ----
  f.get("/api/health", async () => ({
    version: VERSION, uptimeMs: now() - app.startedAt, scraper: app.scraper.state, exchangeData: app.exchangeData?.state ?? null, exchanges: app.o.hub.health(),
    snapshots: app.store.records.latestSnapshots(10), errors: app.store.records.errors(100), sleepGuard: app.sleep.active, vault: app.vault.kind, vaultReason: app.vault.lockReason,
  }));
  f.post("/api/scraper/show-browser", async (req) => {
    const b = parse(z.object({ show: z.boolean() }), req.body);
    await app.scraper.showBrowser(b.show);
    return { ok: true };
  });
  f.get("/api/settings", async () => ({
    scrapeIntervalMs: app.scraper.state.intervalMs,
    coinglassUrl: app.store.getSetting("coinglass_url", "https://www.coinglass.com/"),
    warmSetSize: app.store.getSetting("warm_set_size", 30),
    theme: app.store.getSetting("theme", "system"),
    dataDir: app.o.dataDir ?? null,
    symbolOverrides: app.store.records.symbolOverrides(),
  }));
  f.put("/api/settings", async (req) => {
    const s = parse(Settings, req.body);
    if (s.scrapeIntervalMs) {
      app.store.setSetting("scrape_interval_ms", s.scrapeIntervalMs);
      app.scraper.setInterval(s.scrapeIntervalMs);
    }
    if (s.coinglassUrl) app.store.setSetting("coinglass_url", s.coinglassUrl);
    if (s.warmSetSize != null) app.store.setSetting("warm_set_size", s.warmSetSize);
    if (s.theme) app.store.setSetting("theme", s.theme);
    return { ok: true };
  });
  f.put("/api/settings/symbol-override", async (req) => {
    const b = parse(z.object({ coinglass: z.string().min(1).max(20), exchange: ExchangeId, unified: z.string().max(40).nullable() }), req.body);
    app.store.records.setSymbolOverride(b.coinglass, b.exchange, b.unified);
    app.mapper.setOverrides(app.store.records.symbolOverrides());
    return { ok: true };
  });
  f.post("/api/settings/rotate-token", async () => ({ pairToken: app.rotateToken() }));
  f.post("/api/kill-switch", async (req) => {
    parse(z.object({ confirm: z.literal(true) }), req.body);
    return app.bots.killAll();
  });
}

function stringify(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "object" && v && "toFixed" in v ? (v as { toString(): string }).toString() : v]));
}
