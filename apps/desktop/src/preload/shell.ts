import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ShellApi, type ShellState } from "../shared/types";

/** The only bridge into the main process: a fixed list of calls, no generic send/invoke. */
const api: ShellApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb) => {
    const fn = (_e: unknown, s: ShellState) => cb(s);
    ipcRenderer.on(IPC.state, fn);
    return () => ipcRenderer.removeListener(IPC.state, fn);
  },
  navigate: (v) => ipcRenderer.invoke(IPC.navigate, v),
  setPanelBounds: (r) => ipcRenderer.send(IPC.panelBounds, r),
  restartAgent: () => ipcRenderer.invoke(IPC.restartAgent),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),
  openLogsFolder: () => ipcRenderer.invoke(IPC.openLogsFolder),
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics),
  setLaunchAtLogin: (on) => ipcRenderer.invoke(IPC.setLaunchAtLogin, on),
  setChannel: (c) => ipcRenderer.invoke(IPC.setChannel, c),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  listVersions: () => ipcRenderer.invoke(IPC.listVersions),
  installVersion: (v) => ipcRenderer.invoke(IPC.installVersion, v),
  openExternal: (u) => ipcRenderer.invoke(IPC.openExternal, u),
};

contextBridge.exposeInMainWorld("tradeMate", api);
