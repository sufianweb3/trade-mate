import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import { z } from "zod";
import type { AgentState } from "../shared/types";
import { agentLog, log } from "./logger";
import { agentLaunch } from "./paths";
import { parsePairUrl, redactLine, tokenFromPairUrl } from "./pure/agentOutput";
import { RestartPolicy } from "./pure/restartPolicy";

const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 10_000;

const healthSchema = z.object({ ok: z.boolean(), name: z.string(), version: z.string().optional(), uptimeMs: z.number().optional() });
type Health = z.infer<typeof healthSchema>;
const pidSchema = z.object({ pid: z.number().int().positive(), startedAt: z.number() });

/**
 * Runs the unchanged OI Sniper agent as a child process and keeps it alive.
 * The agent prints its pairing link on start; the panel view opens that link, so the user never pairs by hand.
 */
export class AgentSupervisor extends EventEmitter<{ state: [AgentState]; ready: [string] }> {
  readonly port = Number(process.env.OISNIPER_PORT ?? 7777);
  private child: ChildProcess | null = null;
  private adoptedPid: number | null = null;
  private stopping = false;
  private policy = new RestartPolicy();
  private restartTimer: NodeJS.Timeout | null = null;
  private token: string | null = null;
  pairUrl: string | null = null;
  state: AgentState = { status: "stopped", message: null, port: this.port, pid: null, startedAt: null, restarts: 0, engineVersion: null, adopted: false };

  get baseUrl(): string {
    return `http://localhost:${this.port}/`;
  }

  async start(): Promise<void> {
    if (this.child || this.adoptedPid) return;
    this.stopping = false;
    this.set({ status: this.state.restarts > 0 ? "restarting" : "starting", message: "Starting the trading engine…" });
    const existing = await this.health();
    if (existing) return this.handleExisting(existing);

    const l = agentLaunch();
    if (app.isPackaged && !existsSync(l.node)) return this.fail("error", "The bundled engine runtime is missing. Reinstall Trade Mate.");
    if (!existsSync(l.script)) return this.fail("error", `Engine not found at ${l.script}. Run "pnpm build" first.`);

    log.info("starting agent", { node: l.node, script: l.script });
    const child = spawn(l.node, [l.script], {
      cwd: l.cwd,
      env: { ...process.env, OISNIPER_NO_OPEN: "1", OISNIPER_PORT: String(this.port), OISNIPER_PANEL_DIR: l.panelDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const startedAt = Date.now();
    if (child.pid) this.writePid(child.pid, startedAt);
    this.set({ pid: child.pid ?? null, startedAt, adopted: false });

    const onLine = (stream: "out" | "err") => (line: string) => {
      const pair = parsePairUrl(line, this.port);
      if (pair) {
        this.pairUrl = pair;
        this.token = tokenFromPairUrl(pair);
        void this.waitHealthy(startedAt);
        agentLog.info("[agent] pairing link received (not logged)");
        return;
      }
      if (line.trim()) (stream === "err" ? agentLog.warn : agentLog.info)(redactLine(line));
    };
    createInterface({ input: child.stdout! }).on("line", onLine("out"));
    createInterface({ input: child.stderr! }).on("line", onLine("err"));
    child.on("error", (e) => {
      log.error("agent spawn error", e.message);
      this.onExit(null, e.message);
    });
    child.on("exit", (code, signal) => this.onExit(code, signal));
    setTimeout(() => {
      if (this.child === child && this.state.status !== "running") {
        log.error("agent did not become ready in time");
        child.kill();
      }
    }, READY_TIMEOUT_MS).unref();
  }

  /** Graceful where the OS allows it (SIGTERM on macOS). Windows has no signal for a console-less child: it is ended. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (child && child.exitCode === null) {
      this.set({ status: "stopping", message: "Stopping the trading engine…" });
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    } else if (this.adoptedPid) {
      try {
        process.kill(this.adoptedPid, "SIGTERM");
      } catch {
        /* already gone */
      }
      this.adoptedPid = null;
    }
    this.child = null;
    this.clearPid();
    this.set({ status: "stopped", message: null, pid: null, startedAt: null });
  }

  async restart(): Promise<void> {
    this.policy.reset();
    await this.stop();
    this.set({ restarts: 0 });
    await this.start();
  }

  /** Open positions across all bots, or null when it cannot be known (engine down or token not available). */
  async openPositions(): Promise<number | null> {
    if (this.state.status !== "running" || !this.token) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/api/positions`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (!r.ok) return null;
      const body: unknown = await r.json();
      return Array.isArray(body) ? body.length : null;
    } catch {
      return null;
    }
  }

  private async handleExisting(h: Health): Promise<void> {
    const mine = this.readPid();
    if (h.name === "oisniper-agent" && mine && this.isAlive(mine.pid) && h.uptimeMs != null && Math.abs(Date.now() - h.uptimeMs - mine.startedAt) < 60_000) {
      // Our own engine from before the window was reopened: keep it (the panel still holds its token).
      this.adoptedPid = mine.pid;
      this.pairUrl = null;
      this.set({ status: "running", message: null, pid: mine.pid, startedAt: mine.startedAt, engineVersion: h.version ?? null, adopted: true });
      this.emit("ready", this.baseUrl);
      this.watchAdopted(mine.pid);
      return;
    }
    const msg =
      h.name === "oisniper-agent"
        ? "Another copy of OI Sniper is already running on this computer (for example the \"Start OI Sniper\" window). Close it, then press Retry."
        : `Port ${this.port} is used by another program. Close it, then press Retry.`;
    this.fail("conflict", msg);
  }

  /** An adopted engine is not our child, so its exit is noticed by polling; then a fresh one is started. */
  private watchAdopted(pid: number): void {
    const t = setInterval(() => {
      if (this.adoptedPid !== pid) return clearInterval(t);
      if (this.isAlive(pid)) return;
      clearInterval(t);
      this.adoptedPid = null;
      this.clearPid();
      if (this.stopping) return;
      log.warn("adopted agent exited; starting a new one");
      this.set({ status: "restarting", message: "The trading engine stopped. Restarting…", pid: null, restarts: this.state.restarts + 1, adopted: false });
      void this.start();
    }, 5_000);
  }

  private async waitHealthy(startedAt: number): Promise<void> {
    while (this.child && Date.now() - startedAt < READY_TIMEOUT_MS) {
      const h = await this.health();
      if (h?.name === "oisniper-agent") {
        this.set({ status: "running", message: null, engineVersion: h.version ?? null });
        this.emit("ready", this.pairUrl ?? this.baseUrl);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private onExit(code: number | null, reason: string | null): void {
    if (!this.child) return;
    this.child = null;
    this.clearPid();
    if (this.stopping) return;
    log.warn("agent exited unexpectedly", { code, reason });
    const d = this.policy.recordCrash(Date.now());
    if (d.kind === "give_up") {
      this.fail("error", `The trading engine stopped ${d.crashes} times in 5 minutes. Open the logs from Support, then press Retry.`);
      return;
    }
    this.set({ status: "restarting", message: `The trading engine stopped (code ${code ?? reason ?? "?"}). Restarting…`, pid: null, restarts: this.state.restarts + 1 });
    this.restartTimer = setTimeout(() => void this.start(), d.delayMs);
  }

  private fail(status: "error" | "conflict", message: string): void {
    log.error("agent", status, message);
    this.set({ status, message, pid: null });
  }

  private async health(): Promise<Health | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1_500) });
      if (!r.ok) return { ok: false, name: "unknown" };
      const p = healthSchema.safeParse(await r.json());
      return p.success ? p.data : { ok: false, name: "unknown" };
    } catch (e) {
      // Nothing listening -> null. Something listening that does not answer like the agent -> "unknown" occupant.
      if ((e as Error).name === "TimeoutError") return { ok: false, name: "unknown" };
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return cause === "ECONNREFUSED" || cause === undefined ? null : { ok: false, name: "unknown" };
    }
  }

  private set(p: Partial<AgentState>): void {
    this.state = { ...this.state, ...p };
    this.emit("state", this.state);
  }

  private pidFile = () => join(app.getPath("userData"), "agent.pid.json");
  private writePid(pid: number, startedAt: number) {
    writeFileSync(this.pidFile(), JSON.stringify({ pid, startedAt }));
  }
  private readPid() {
    try {
      return pidSchema.parse(JSON.parse(readFileSync(this.pidFile(), "utf8")));
    } catch {
      return null;
    }
  }
  private clearPid() {
    rmSync(this.pidFile(), { force: true });
  }
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
