import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../log";
import {
  CHANGE_STATE_SCRIPT, ensureColumnsScript, EXTRACT_SCRIPT, gotoPageScript, LOGIN_STATE_SCRIPT, OBSERVE_SCRIPT, SORT_OI5M_SCRIPT, WANTED_COLUMNS,
} from "./coinglassScripts";
import { classifyHeader, RawTableSchema, type RawTable } from "./parser";
import type { SnapshotSource, SourceResult } from "./source";

interface PwPage {
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(expr: string): Promise<T>;
  title(): Promise<string>;
  close(): Promise<void>;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
type LaunchOpts = { headless: boolean; viewport: { width: number; height: number }; channel?: string; executablePath?: string };

const BRAVE: Record<string, string[]> = {
  win32: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  darwin: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  linux: ["/usr/bin/brave-browser", "/usr/bin/brave"],
};

/**
 * Browser for the CoinGlass profile: Brave, else Google Chrome, else Microsoft Edge, else Playwright's bundled Chromium.
 * A system browser avoids broken bundled builds and passes site checks like a normal visitor.
 * Override with OISNIPER_BROWSER=brave | chrome | msedge | bundled.
 */
export function browserLaunch(): { channel?: string; executablePath?: string } {
  const forced = process.env.OISNIPER_BROWSER;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const find = (rel: string) => (rel.startsWith("/") ? (existsSync(rel) ? rel : null) : roots.map((r) => join(r, rel)).find((p) => existsSync(p)) ?? null);
  const brave = () => (BRAVE[process.platform] ?? []).map(find).find(Boolean) ?? null;
  if (forced === "bundled") return {};
  if (forced === "brave") return brave() ? { executablePath: brave()! } : {};
  if (forced) return { channel: forced };
  const b = brave();
  if (b) return { executablePath: b };
  if (process.platform === "win32") {
    if (find("Google\\Chrome\\Application\\chrome.exe")) return { channel: "chrome" };
    if (find("Microsoft\\Edge\\Application\\msedge.exe")) return { channel: "msedge" };
    return {};
  }
  if (process.platform === "darwin") return existsSync("/Applications/Google Chrome.app") ? { channel: "chrome" } : {};
  return existsSync("/usr/bin/google-chrome") ? { channel: "chrome" } : {};
}

const REQUIRED_HEADERS = ["oi_chg_5m", "oi_chg_15m", "oi_chg_30m", "oi_chg_1h", "oi_chg_4h", "price_chg_5m", "vol_chg_1h"];
const BLOCKED = /just a moment|attention required|verify you are human|cloudflare|404 not found|access denied|forbidden|too many requests/;
const BACKOFF_MIN = [5, 10, 20, 40, 60];
const CLOSED = /has been closed|target closed|browser has disconnected|scraper not started/i;

/**
 * One CoinGlass page kept open in a persistent profile (login survives restarts).
 * - Push: a MutationObserver marks table changes; the service reads right away (quick read = current page only,
 *   merged with the last full 3-page read). A full read runs on the interval.
 * - Columns: all PRD timeframes are switched on via "Customize" whenever CoinGlass resets them.
 * - Blocks (403/404/429/challenge): report CHALLENGE, back off 5 -> 60 min, never work around them.
 * - Login: done once by the user via Health -> Show browser; expiry is detected and reported.
 */
export class CoinGlassSource implements SnapshotSource {
  readonly name = "coinglass";
  private ctx: PwContext | null = null;
  private page: PwPage | null = null;
  private headless = true;
  private lastLoad = 0;
  private lastConfigure = 0;
  private lastFull = 0;
  private fullRows: string[][] = [];
  private fullHeaders: string[] = [];
  private blockedUntil = 0;
  private blockCount = 0;
  private loggedIn: boolean | null = null;
  private wasLoggedIn = false;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private lastV = 0;
  private everStarted = false;
  private lastRelaunch = 0;

  constructor(private o: { url: () => string; profileDir: string; pages?: () => number; fullEveryMs?: () => number }) {}

  async start(): Promise<void> {
    let pw: { chromium: { launchPersistentContext(dir: string, o: LaunchOpts): Promise<PwContext> } };
    const NO_BROWSER = "CoinGlass needs Google Chrome or Brave on this computer. Install Google Chrome (free), or set Signal Data Source = Exchange in Settings.";
    try {
      pw = (await import("playwright")) as unknown as typeof pw;
    } catch {
      throw new Error(NO_BROWSER);
    }
    const which = browserLaunch();
    // Desktop viewport: CoinGlass serves a layout without the full table to small viewports.
    try {
      this.ctx = await pw.chromium.launchPersistentContext(this.o.profileDir, { headless: this.headless, viewport: { width: 1440, height: 900 }, ...which });
    } catch (e) {
      // No system browser and no bundled Chromium: say what to do in plain words instead of a Playwright stack.
      if (!which.channel && !which.executablePath) throw new Error(NO_BROWSER);
      throw e;
    }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.everStarted = true;
    await this.load();
    this.watch(); // re-attach after Show/Hide browser relaunch
  }

  private async load() {
    if (!this.page) return;
    this.lastLoad = Date.now();
    await this.page.goto(this.o.url(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
    // Poll the real row count: CoinGlass hydrates late and waitForSelector proved unreliable on it.
    for (let i = 0; i < 45; i++) {
      const n = z.number().safeParse(await this.page.evaluate<unknown>(`document.querySelectorAll("tr.ant-table-row, table tbody tr").length`).catch(() => 0));
      if (n.success && n.data > 5) break;
      if (BLOCKED.test((await this.page.title().catch(() => "")).toLowerCase())) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Push notifications: cheap local poll (1s) of the observer counter. No network involved. */
  private cb: (() => void) | null = null;
  onChange(cb: () => void): void {
    this.cb = cb;
    this.watch();
  }
  private watch(): void {
    const cb = this.cb;
    if (!cb) return;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = setInterval(async () => {
      if (!this.page || Date.now() < this.blockedUntil) return;
      const s = z.object({ v: z.number(), t: z.number() }).safeParse(await this.page.evaluate<unknown>(CHANGE_STATE_SCRIPT).catch(() => null));
      if (s.success && s.data.v !== this.lastV) {
        this.lastV = s.data.v;
        cb();
      }
    }, 1000);
  }

  private async extract(): Promise<RawTable> {
    const raw = await this.page!.evaluate<unknown>(EXTRACT_SCRIPT);
    const parsed = RawTableSchema.safeParse(raw);
    return parsed.success ? parsed.data : { headers: [], rows: [] };
  }

  private async ensureColumns(headers: string[]): Promise<void> {
    const have = new Set(headers.map(classifyHeader));
    if (REQUIRED_HEADERS.every((k) => have.has(k as never))) return;
    if (this.lastConfigure > this.lastLoad && Date.now() - this.lastConfigure < 600_000) return; // no click loops
    this.lastConfigure = Date.now();
    const n = z.number().safeParse(await this.page!.evaluate<unknown>(ensureColumnsScript(WANTED_COLUMNS)));
    log.info({ toggled: n.success ? n.data : null, loggedIn: this.loggedIn }, "coinglass columns re-enabled");
  }

  private blocked(title: string): SourceResult {
    const mins = BACKOFF_MIN[Math.min(this.blockCount, BACKOFF_MIN.length - 1)]!;
    this.blockCount++;
    this.blockedUntil = Date.now() + mins * 60_000;
    const note = `CoinGlass refused the page ("${title.slice(0, 40)}"). Backing off ${mins} min. If it persists, open Health > Show browser.`;
    log.warn({ mins }, "coinglass blocked, backing off");
    return { table: { headers: [], rows: [] }, challenge: true, note, loggedIn: this.loggedIn };
  }

  /**
   * A crashed or killed browser ("Target page, context or browser has been closed") used to leave the scraper dead
   * until the agent restarted. Relaunch on the same profile, at most once a minute.
   */
  async read(): Promise<SourceResult> {
    try {
      return await this.readOnce();
    } catch (e) {
      const msg = String((e as Error).message);
      if (!this.everStarted || !CLOSED.test(msg) || Date.now() - this.lastRelaunch < 60_000) throw e;
      this.lastRelaunch = Date.now();
      log.warn({ err: msg.split("\n")[0] }, "coinglass browser closed, relaunching");
      await this.stop();
      await this.start();
      return await this.readOnce();
    }
  }

  private async readOnce(): Promise<SourceResult> {
    if (!this.page) throw new Error("scraper not started");
    if (Date.now() < this.blockedUntil) return { table: { headers: [], rows: [] }, challenge: true, note: `Backing off until ${new Date(this.blockedUntil).toISOString().slice(11, 16)} UTC`, loggedIn: this.loggedIn };
    if (this.blockCount > 0 && Date.now() - this.lastLoad > 60_000) await this.load(); // retry after backoff: one load
    const title = (await this.page.title().catch(() => "")).toLowerCase();
    if (BLOCKED.test(title)) return this.blocked(title);
    this.blockCount = 0;
    this.loggedIn = z.boolean().catch(false).parse(await this.page.evaluate<unknown>(LOGIN_STATE_SCRIPT).catch(() => false));
    let note: string | undefined;
    if (this.loggedIn) this.wasLoggedIn = true;
    else if (this.wasLoggedIn) note = "CoinGlass session expired: log in again via Health > Show browser";
    await this.page.evaluate<unknown>(OBSERVE_SCRIPT).catch(() => false);
    let cur = await this.extract();
    if (cur.rows.length === 0 && Date.now() - this.lastLoad > 120_000) {
      log.warn("coinglass table empty, reloading page once");
      await this.load();
      cur = await this.extract();
    }
    if (cur.headers.length) {
      await this.ensureColumns(cur.headers);
      await this.page.evaluate<unknown>(SORT_OI5M_SCRIPT).catch(() => false);
      cur = await this.extract();
    }
    const changed = z.object({ t: z.number() }).safeParse(await this.page.evaluate<unknown>(CHANGE_STATE_SCRIPT).catch(() => null));
    const dataTs = changed.success && changed.data.t > 0 ? changed.data.t : Date.now();
    const pages = Math.max(1, Math.min(10, this.o.pages?.() ?? 3));
    const fullDue = Date.now() - this.lastFull >= (this.o.fullEveryMs?.() ?? 30_000) || cur.headers.join("|") !== this.fullHeaders.join("|");
    if (!fullDue) {
      // quick read: fresh page 1 + pages 2..N from the last full read (no clicks, no network)
      const fresh = new Set(cur.rows.map((r) => r.join("|").slice(0, 40)));
      return { table: { headers: cur.headers, rows: [...cur.rows, ...this.fullRows.slice(cur.rows.length).filter((r) => !fresh.has(r.join("|").slice(0, 40)))] }, challenge: false, dataTs, note, loggedIn: this.loggedIn };
    }
    const table: RawTable = { headers: cur.headers, rows: [...cur.rows] };
    for (let p = 2; p <= pages; p++) {
      const ok = z.boolean().safeParse(await this.page.evaluate<unknown>(gotoPageScript(p)).catch(() => false));
      if (!ok.success || !ok.data) break;
      const t = await this.extract();
      if (t.headers.join("|") !== table.headers.join("|")) break;
      table.rows.push(...t.rows);
    }
    if (pages > 1) await this.page.evaluate<unknown>(gotoPageScript(1)).catch(() => false);
    this.lastFull = Date.now();
    this.fullRows = table.rows;
    this.fullHeaders = table.headers;
    return { table, challenge: false, dataTs, note, loggedIn: this.loggedIn };
  }

  /** Show browser: relaunch headed on the same profile so the user can log in / pass a check once. */
  async setVisible(show: boolean): Promise<void> {
    if (this.headless === !show) return;
    this.headless = !show;
    this.blockedUntil = 0;
    this.blockCount = 0;
    await this.stop();
    try {
      await this.start();
    } catch (e) {
      // A visible window can fail (no desktop session, blocked spawn): never leave the scraper dead.
      this.headless = true;
      await this.start();
      throw Object.assign(new Error(`Could not open a visible browser (${String((e as Error).message).split("\n")[0]}). Scraper continues headless. Start the agent from a desktop terminal to log in.`), { code: "EXCHANGE_ERROR" });
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.page = null;
  }
}
