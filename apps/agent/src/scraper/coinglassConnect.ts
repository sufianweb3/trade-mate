import { log } from "../log";

export type ConnectPhase = "idle" | "opening" | "waiting_login" | "configuring" | "finishing" | "connected" | "warning" | "failed" | "cancelled";

export interface ConnectStatus {
  phase: ConnectPhase;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** Required CoinGlass columns still missing after the automatic Customize step. */
  missingColumns: string[];
}

/** What the flow needs from the browser. Injected so the flow is testable without a real browser. */
export interface ConnectDeps {
  /** Relaunch the CoinGlass profile as a visible window on the CoinGlass page. */
  openVisible(): Promise<void>;
  /** Relaunch the profile hidden (normal scraping). */
  toBackground(): Promise<void>;
  /** False once the user closed the visible window. */
  windowOpen(): boolean;
  /** true = logged in, false = logged out, null = page not ready yet. */
  loginState(): Promise<boolean | null>;
  /** Turn on the needed columns while logged in (account-saved); returns required columns still missing. */
  configureColumns(): Promise<string[]>;
  /** Login state seen by the hidden browser after the switch. */
  verifyBackground(): Promise<boolean | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const POLL_MS = 2000;
const ACTIVE: ConnectPhase[] = ["opening", "waiting_login", "configuring", "finishing"];

/**
 * One-click CoinGlass connect: open a window, wait for the user's login (two readings in a row, so a half-loaded page
 * never counts), enable the columns, move back to the hidden browser and confirm the login survived the switch.
 * Every exit path returns CoinGlass to the hidden browser.
 */
export class ConnectFlow {
  status: ConnectStatus = { phase: "idle", message: "", startedAt: null, finishedAt: null, missingColumns: [] };
  private cancelled = false;
  private running: Promise<void> | null = null;

  constructor(private d: ConnectDeps) {}

  get active(): boolean {
    return ACTIVE.includes(this.status.phase);
  }

  /** Starts the flow in the background; a second click while it runs returns the current status. */
  start(): ConnectStatus {
    if (this.active) return this.status;
    this.cancelled = false;
    this.status = { phase: "opening", message: "Opening a browser window on CoinGlass…", startedAt: this.d.now(), finishedAt: null, missingColumns: [] };
    this.running = this.run().finally(() => (this.running = null));
    return this.status;
  }

  cancel(): void {
    if (this.active) this.cancelled = true;
  }

  /** For tests: resolves when the current run is over. */
  async settled(): Promise<void> {
    await this.running;
  }

  private set(phase: ConnectPhase, message: string, missing: string[] = this.status.missingColumns) {
    const done = !ACTIVE.includes(phase);
    this.status = { ...this.status, phase, message, missingColumns: missing, finishedAt: done ? this.d.now() : null };
    log.info({ phase }, "coinglass connect");
  }

  private async back(phase: ConnectPhase, message: string) {
    try {
      await this.d.toBackground();
    } catch (e) {
      message += ` Could not restart the background browser: ${String((e as Error).message).split("\n")[0]}`;
      phase = "failed";
    }
    this.set(phase, message);
  }

  private async run(): Promise<void> {
    try {
      await this.d.openVisible();
    } catch (e) {
      return this.back("failed", `Could not open a browser window: ${String((e as Error).message).split("\n")[0]}. Install Google Chrome or Brave, or start the app from your desktop.`);
    }
    this.set("waiting_login", "Log in to CoinGlass in the window that opened. It closes by itself once you are logged in.");
    const deadline = this.d.now() + LOGIN_TIMEOUT_MS;
    let hits = 0;
    for (;;) {
      if (this.cancelled) return this.back("cancelled", "Cancelled. CoinGlass keeps running in the background.");
      if (!this.d.windowOpen()) return this.back("cancelled", "The window was closed before the login finished. Click Connect to try again.");
      if (this.d.now() > deadline) return this.back("failed", "No login seen within 10 minutes. Click Connect to try again.");
      const s = await this.d.loginState().catch(() => null);
      hits = s === true ? hits + 1 : 0;
      if (hits >= 2) break;
      await this.d.sleep(POLL_MS);
    }
    this.set("configuring", "Logged in. Turning on the columns the bots need…");
    let missing: string[] = [];
    try {
      missing = await this.d.configureColumns();
    } catch (e) {
      log.warn({ err: String((e as Error).message).split("\n")[0] }, "coinglass column setup failed");
    }
    this.set("finishing", "Moving CoinGlass to the background…", missing);
    try {
      await this.d.toBackground();
    } catch (e) {
      return this.set("failed", `Logged in, but the background browser did not start: ${String((e as Error).message).split("\n")[0]}`);
    }
    const ok = await this.d.verifyBackground().catch(() => null);
    if (ok === false) return this.set("failed", "Logged in, but the background browser does not see the login. Click Connect and log in again.");
    if (missing.length) return this.set("warning", `Connected, but CoinGlass did not show these columns: ${missing.join(", ")}. Signals that need them stay off.`);
    this.set("connected", "Connected. CoinGlass runs in the background.");
  }
}
