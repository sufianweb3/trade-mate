import { BaseWindow, WebContentsView, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import type { Rect, ViewName } from "../shared/types";
import { assetPath } from "./paths";
import { isAgentUrl, isSafeExternalUrl } from "./pure/urlGuard";
import { log } from "./logger";

/**
 * One window, two views:
 *  - shell: the Trade Mate frame (sidebar, status, Updates / Support / About), local files, typed preload bridge.
 *  - panel: the unchanged OI Sniper panel served by the local agent, no preload, may only show the agent.
 * The shell reports where the panel goes (setPanelBounds); the panel is hidden on other pages or while the engine is down.
 */
export class ShellWindow {
  readonly win: BaseWindow;
  readonly shellView: WebContentsView;
  readonly panelView: WebContentsView;
  private panelBounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private panelLoaded = false;
  view: ViewName = "panel";
  agentReady = false;

  constructor(private readonly port: number) {
    this.win = new BaseWindow({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 680,
      title: "Trade Mate",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0f17" : "#f6f7fb",
      icon: assetPath("icon.png"),
      autoHideMenuBar: true,
    });

    this.shellView = new WebContentsView({
      webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.shellView.webContents.on("will-navigate", (e) => e.preventDefault());
    this.shellView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.contentView.addChildView(this.shellView);

    const panelSession = session.fromPartition("persist:panel");
    panelSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    this.panelView = new WebContentsView({
      webPreferences: { session: panelSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const wc = this.panelView.webContents;
    wc.on("will-navigate", (e, url) => this.guard(e, url));
    wc.on("will-redirect", (e, url) => this.guard(e, url));
    wc.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("render-process-gone", (_e, d) => {
      log.error("panel renderer gone", d.reason);
      this.panelLoaded = false;
      if (this.agentReady) void this.loadPanel(`http://localhost:${this.port}/`);
    });
    this.panelView.setVisible(false);
    this.win.contentView.addChildView(this.panelView);

    this.layout();
    this.win.on("resize", () => this.layout());
    void this.shellView.webContents.loadFile(join(__dirname, "renderer", "index.html"));
    this.shellView.webContents.once("did-finish-load", () => this.win.show());
  }

  async loadPanel(url: string): Promise<void> {
    try {
      await this.panelView.webContents.loadURL(url);
      this.panelLoaded = true;
    } catch (e) {
      log.error("panel load failed", (e as Error).message);
    }
    this.syncPanel();
  }

  get isPanelLoaded(): boolean {
    return this.panelLoaded;
  }

  setPanelBounds(r: Rect): void {
    this.panelBounds = r;
    this.syncPanel();
  }

  setView(v: ViewName): void {
    this.view = v;
    this.syncPanel();
  }

  setAgentReady(ready: boolean): void {
    this.agentReady = ready;
    this.syncPanel();
  }

  reloadPanel(): void {
    if (this.panelLoaded) this.panelView.webContents.reload();
  }

  show(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  private syncPanel(): void {
    const visible = this.view === "panel" && this.agentReady && this.panelLoaded && this.panelBounds.width > 0;
    const b = this.panelBounds;
    this.panelView.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    this.panelView.setVisible(visible);
  }

  private layout(): void {
    const [w, h] = this.win.getContentSize();
    this.shellView.setBounds({ x: 0, y: 0, width: w ?? 0, height: h ?? 0 });
  }

  private guard(e: Electron.Event, url: string): void {
    if (isAgentUrl(url, this.port)) return;
    e.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  }
}
