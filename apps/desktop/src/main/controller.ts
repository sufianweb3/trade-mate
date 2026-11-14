import { app, dialog, Notification, shell } from "electron";
import type { Channel, ShellState, ViewName } from "../shared/types";
import { AgentSupervisor } from "./agentSupervisor";
import { errorBox } from "./ipc";
import { log, logsDir } from "./logger";
import { agentDataDir } from "./paths";
import { loadSettings, saveSettings } from "./settings";
import { AppTray } from "./tray";
import { UpdateService } from "./updates";
import { ShellWindow } from "./window";

/** Owns the engine, the window, the tray and updates, and every "this will stop the engine" confirmation. */
export class Controller {
  readonly agent = new AgentSupervisor();
  settings = loadSettings();
  readonly updates = new UpdateService(this.settings.channel);
  window: ShellWindow | null = null;
  private tray: AppTray | null = null;
  private quitting = false;

  async init(startHidden: boolean): Promise<void> {
    this.window = new ShellWindow(this.agent.port);
    if (startHidden) this.window.win.once("show", () => this.window?.win.hide());
    this.tray = new AppTray({ open: () => this.show(), checkUpdates: () => this.showUpdates(), quit: () => app.quit() });

    this.window.win.on("close", (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.window?.win.hide();
      this.trayHintOnce();
    });

    this.agent.on("state", (s) => {
      this.window?.setAgentReady(s.status === "running");
      this.tray?.update(s);
      this.broadcast();
    });
    this.agent.on("ready", (url) => {
      // First start opens the pairing link; later the panel keeps its own stored token and reconnects by itself.
      if (!this.window?.isPanelLoaded) void this.window?.loadPanel(url);
    });
    this.updates.on("state", (s) => {
      if (s.status === "available" && s.availableVersion && Notification.isSupported()) {
        new Notification({ title: "Trade Mate update available", body: `Version ${s.availableVersion} is ready to install from Updates.` }).show();
      }
      this.broadcast();
    });
    app.on("before-quit", (e) => {
      if (this.quitting) return;
      e.preventDefault();
      void this.confirmAndQuit();
    });

    await this.agent.start();
    this.updates.startSchedule();
  }

  snapshot(): ShellState {
    return {
      app: {
        name: "Trade Mate",
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        node: process.versions.node,
        packaged: app.isPackaged,
      },
      agent: this.agent.state,
      update: this.updates.state,
      settings: this.settings,
      view: this.window?.view ?? "panel",
    };
  }

  diagnostics(): unknown {
    const s = this.snapshot();
    return { ...s, dataDir: agentDataDir(), logsDir: logsDir(), at: new Date().toISOString() }; // no token, no keys
  }

  navigate(v: ViewName): void {
    this.window?.setView(v);
    this.broadcast();
  }

  show(): void {
    this.window?.show();
  }

  showUpdates(): void {
    this.show();
    this.navigate("updates");
    void this.updates.check();
  }

  setLaunchAtLogin(on: boolean): void {
    app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
    this.save({ launchAtLogin: on });
  }

  setChannel(c: Channel): void {
    this.save({ channel: c });
    this.updates.setChannel(c);
    void this.updates.check();
  }

  async downloadUpdate(): Promise<void> {
    try {
      if (this.updates.state.inPlaceInstall) return await this.updates.download();
      const v = this.updates.state.availableVersion;
      if (v) await this.installVersion(v);
    } catch (e) {
      await errorBox("Update download failed", e);
    }
  }

  /** Windows: stop the engine, then the installer replaces the app and starts it again. */
  async installUpdate(): Promise<void> {
    const v = this.updates.state.availableVersion ?? "";
    if (!(await this.confirmEngineStop(`Install Trade Mate ${v}`, "Trade Mate closes, installs the update and opens again (about a minute)."))) return;
    this.quitting = true;
    await this.agent.stop();
    this.updates.quitAndInstall();
  }

  /** Any listed version, older ones included: this is how a bad update is rolled back. */
  async installVersion(version: string): Promise<void> {
    try {
      const file = await this.updates.prepareInstaller(version);
      if (process.platform === "win32") {
        if (!(await this.confirmEngineStop(`Install Trade Mate ${version}`, "Trade Mate closes and the installer for this version runs. Your bots, settings and trade history are kept."))) return;
        this.quitting = true;
        await this.agent.stop();
        const { spawn } = await import("node:child_process");
        spawn(file, [], { detached: true, stdio: "ignore" }).unref();
        app.quit();
      } else {
        await shell.openPath(file);
        await dialog.showMessageBox({
          type: "info",
          title: `Trade Mate ${version}`,
          message: `Trade Mate ${version} is downloaded and checked.`,
          detail: "Quit Trade Mate (tray menu → Quit), then drag Trade Mate from the window that opened into Applications and choose Replace. Your bots, settings and trade history are kept.",
        });
      }
    } catch (e) {
      log.error("install version failed", (e as Error).message);
      await errorBox(`Could not install ${version}`, e);
    }
  }

  private async confirmAndQuit(): Promise<void> {
    if (!(await this.confirmEngineStop("Quit Trade Mate", "The bots stop until you open Trade Mate again."))) return;
    this.quitting = true;
    await this.agent.stop();
    app.quit();
  }

  /** Every path that stops the engine goes through here: it counts open positions and asks first. */
  private async confirmEngineStop(title: string, what: string): Promise<boolean> {
    if (this.agent.state.status !== "running") return true;
    const n = await this.agent.openPositions();
    const detail =
      n === null
        ? `${what}\n\nOpen positions could not be read. If any are open, trailing, TP1 and exits are not managed while the engine is stopped. Real positions keep their stop-loss on the exchange.`
        : n > 0
          ? `${what}\n\n${n} open position${n === 1 ? "" : "s"}: trailing, TP1 and exits are not managed while the engine is stopped. Real positions keep their stop-loss on the exchange.`
          : what;
    this.show();
    const r = await dialog.showMessageBox({
      type: n === 0 ? "question" : "warning",
      title,
      message: n && n > 0 ? `${title}? ${n} position${n === 1 ? " is" : "s are"} open.` : `${title}?`,
      detail,
      buttons: ["Cancel", n === 0 ? "Continue" : "Continue anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return r.response === 1;
  }

  private trayHintOnce(): void {
    if (this.settings.trayHintShown) return;
    this.save({ trayHintShown: true });
    if (Notification.isSupported())
      new Notification({
        title: "Trade Mate is still running",
        body: "Your bots keep working in the background. To stop them, use Quit in the Trade Mate tray menu.",
      }).show();
  }

  private save(p: Partial<typeof this.settings>): void {
    this.settings = { ...this.settings, ...p };
    saveSettings(this.settings);
    this.broadcast();
  }

  private broadcast(): void {
    const wc = this.window?.shellView.webContents;
    if (wc && !wc.isDestroyed()) wc.send("shell:state", this.snapshot());
  }
}
