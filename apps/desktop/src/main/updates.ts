import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EventEmitter } from "node:events";
import { app } from "electron";
import electronUpdater from "electron-updater";
import type { Channel, UpdateState, VersionItem } from "../shared/types";
import { log } from "./logger";
import { sha512FromMetadata, toVersionList, type Platform, type VersionEntry } from "./pure/releases";

const { autoUpdater } = electronUpdater;
export const REPO = { owner: "sufianweb3", repo: "trade-mate" };
const RELEASES_API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases?per_page=50`;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/**
 * Controlled updates: nothing downloads or installs without the user pressing a button.
 * Stable channel = GitHub releases not marked pre-release. Beta = pre-releases too.
 * Any listed version (older ones included) can be installed again: that is the rollback path.
 */
export class UpdateService extends EventEmitter<{ state: [UpdateState] }> {
  state: UpdateState;
  private versions: VersionEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(channel: Channel) {
    super();
    const inPlaceInstall = process.platform === "win32";
    this.state = { status: app.isPackaged ? "idle" : "dev", channel, availableVersion: null, progress: null, error: null, lastCheckedAt: null, inPlaceInstall };
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = channel === "beta";
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: null }));
    autoUpdater.on("update-available", (i) => this.set({ status: "available", availableVersion: i.version, lastCheckedAt: Date.now() }));
    autoUpdater.on("update-not-available", () => this.set({ status: "up-to-date", availableVersion: null, lastCheckedAt: Date.now() }));
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => this.set({ status: "downloaded", availableVersion: i.version, progress: 100 }));
    autoUpdater.on("error", (e) => this.set({ status: "error", error: friendly(e), progress: null }));
  }

  startSchedule(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), 15_000).unref();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  setChannel(c: Channel): void {
    autoUpdater.allowPrerelease = c === "beta";
    this.set({ channel: c, status: app.isPackaged ? "idle" : "dev", availableVersion: null });
  }

  async check(): Promise<void> {
    if (!app.isPackaged) return this.set({ status: "dev" });
    try {
      if (this.state.inPlaceInstall) await autoUpdater.checkForUpdates();
      else {
        // macOS (unsigned): same feed, decided from the release list; install = open the verified .dmg.
        this.set({ status: "checking", error: null });
        const newest = (await this.loadVersions()).find((v) => v.isNewer && v.installer);
        this.set(newest ? { status: "available", availableVersion: newest.version, lastCheckedAt: Date.now() } : { status: "up-to-date", availableVersion: null, lastCheckedAt: Date.now() });
      }
    } catch (e) {
      this.set({ status: "error", error: friendly(e) });
    }
  }

  async download(): Promise<void> {
    if (this.state.inPlaceInstall) {
      await autoUpdater.downloadUpdate();
      return;
    }
    if (this.state.availableVersion) await this.prepareInstaller(this.state.availableVersion);
  }

  /** Windows only: the caller has already stopped the engine. */
  quitAndInstall(): void {
    this.set({ status: "installing" });
    autoUpdater.quitAndInstall(false, true);
  }

  async listVersions(): Promise<VersionItem[]> {
    const list = await this.loadVersions();
    return list.map((v) => ({
      version: v.version,
      title: v.title,
      notes: v.notes,
      publishedAt: v.publishedAt,
      channel: v.channel,
      url: v.url,
      isCurrent: v.isCurrent,
      isNewer: v.isNewer,
      installable: !v.isCurrent && v.installer != null && v.metadata != null,
    }));
  }

  /** Downloads the installer for `version`, checks its SHA-512 against the release metadata, returns the file path. */
  async prepareInstaller(version: string): Promise<string> {
    const v = (this.versions.length ? this.versions : await this.loadVersions()).find((x) => x.version === version);
    if (!v?.installer || !v.metadata) throw new Error(`Version ${version} has no installer for this computer.`);
    const yml = await (await get(v.metadata.browser_download_url)).text();
    const expected = sha512FromMetadata(yml, v.installer.name);
    if (!expected) throw new Error(`Version ${version}: installer checksum not found, not installing.`);

    const dir = join(app.getPath("temp"), "trade-mate-installers");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, v.installer.name);
    this.set({ status: "downloading", progress: 0, error: null, availableVersion: version });
    const res = await get(v.installer.browser_download_url);
    const total = Number(res.headers.get("content-length") ?? v.installer.size);
    const hash = createHash("sha512");
    let done = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      done += chunk.length;
      if (total > 0) this.set({ progress: Math.min(99, Math.round((done / total) * 100)) });
    });
    await pipeline(body, createWriteStream(file));
    if (hash.digest("base64") !== expected) {
      rmSync(file, { force: true });
      this.set({ status: "error", progress: null, error: `Version ${version}: download did not match its checksum and was deleted.` });
      throw new Error("checksum mismatch");
    }
    this.set({ status: "downloaded", progress: 100 });
    return file;
  }

  private async loadVersions(): Promise<VersionEntry[]> {
    const raw: unknown = await (await get(RELEASES_API, { accept: "application/vnd.github+json" })).json();
    this.versions = toVersionList(raw, app.getVersion(), this.state.channel, process.platform as Platform, process.arch);
    return this.versions;
  }

  private set(p: Partial<UpdateState>): void {
    this.state = { ...this.state, ...p };
    this.emit("state", this.state);
  }
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const r = await fetch(url, { headers: { "user-agent": "TradeMate-Desktop", ...headers }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
  return r;
}

function friendly(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(m)) return "No connection to GitHub. Check the internet connection and try again.";
  if (/404|latest\.yml|No published versions/i.test(m)) return "No published version found for this channel yet.";
  if (/403|rate limit/i.test(m)) return "GitHub is limiting requests right now. Try again in an hour.";
  return m.split("\n")[0]!.slice(0, 200);
}
