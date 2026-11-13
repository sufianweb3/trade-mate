import { Menu, Tray, nativeImage } from "electron";
import type { AgentState } from "../shared/types";
import { assetPath } from "./paths";

export interface TrayActions {
  open(): void;
  checkUpdates(): void;
  quit(): void;
}

const LABEL: Record<AgentState["status"], string> = {
  starting: "Engine: starting",
  running: "Engine: running",
  restarting: "Engine: restarting",
  stopping: "Engine: stopping",
  stopped: "Engine: stopped",
  error: "Engine: needs attention",
  conflict: "Engine: blocked by another copy",
};

/** Closing the window keeps the bots running here; Quit is the only way to stop the engine. */
export class AppTray {
  private tray: Tray;

  constructor(private readonly actions: TrayActions) {
    const img = nativeImage.createFromPath(assetPath("icon.png")).resize({ width: process.platform === "darwin" ? 18 : 16 });
    this.tray = new Tray(img);
    this.tray.setToolTip("Trade Mate");
    this.tray.on("click", () => actions.open());
    this.update({ status: "starting" } as AgentState);
  }

  update(agent: AgentState): void {
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Trade Mate", click: () => this.actions.open() },
        { type: "separator" },
        { label: LABEL[agent.status], enabled: false },
        { label: "Check for updates", click: () => this.actions.checkUpdates() },
        { type: "separator" },
        { label: "Quit Trade Mate", click: () => this.actions.quit() },
      ]),
    );
  }
}
