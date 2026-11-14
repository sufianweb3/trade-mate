import { app, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC, VIEWS, type ShellState } from "../shared/types";
import type { Controller } from "./controller";
import { logsDir } from "./logger";
import { agentDataDir } from "./paths";
import { isSafeExternalUrl } from "./pure/urlGuard";

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) });
const view = z.enum(VIEWS as [string, ...string[]]);
const channel = z.enum(["stable", "beta"]);
const version = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

/** Every call is validated and accepted only from the Trade Mate shell view (never from the panel). */
export function registerIpc(c: Controller): void {
  const fromShell = (e: IpcMainInvokeEvent | IpcMainEvent) => e.sender === c.window?.shellView.webContents;
  const handle = (ch: string, fn: (arg: unknown) => unknown) =>
    ipcMain.handle(ch, async (e, arg: unknown) => {
      if (!fromShell(e)) throw new Error("not allowed");
      return fn(arg);
    });

  handle(IPC.getState, (): ShellState => c.snapshot());
  handle(IPC.navigate, (v) => c.navigate(view.parse(v) as ShellState["view"]));
  ipcMain.on(IPC.panelBounds, (e, r: unknown) => {
    if (fromShell(e)) c.window?.setPanelBounds(rect.parse(r));
  });
  handle(IPC.restartAgent, () => c.agent.restart());
  handle(IPC.openDataFolder, () => shell.openPath(agentDataDir()));
  handle(IPC.openLogsFolder, () => shell.openPath(logsDir()));
  handle(IPC.copyDiagnostics, () => clipboard.writeText(JSON.stringify(c.diagnostics(), null, 2)));
  handle(IPC.setLaunchAtLogin, (on) => c.setLaunchAtLogin(z.boolean().parse(on)));
  handle(IPC.setChannel, (ch) => c.setChannel(channel.parse(ch)));
  handle(IPC.checkForUpdates, () => c.updates.check());
  handle(IPC.downloadUpdate, () => c.downloadUpdate());
  handle(IPC.installUpdate, () => c.installUpdate());
  handle(IPC.listVersions, async () => {
    try {
      return { items: await c.updates.listVersions(), error: null };
    } catch (e) {
      return { items: [], error: String((e as Error).message).slice(0, 200) };
    }
  });
  handle(IPC.installVersion, (v) => c.installVersion(version.parse(v)));
  handle(IPC.openExternal, async (u) => {
    const url = z.string().parse(u);
    if (!isSafeExternalUrl(url)) throw new Error("only https links can be opened");
    await shell.openExternal(url);
  });
}

export async function errorBox(title: string, e: unknown): Promise<void> {
  if (!app.isReady()) return;
  await dialog.showMessageBox({ type: "error", title, message: title, detail: String((e as Error)?.message ?? e).slice(0, 500) });
}
