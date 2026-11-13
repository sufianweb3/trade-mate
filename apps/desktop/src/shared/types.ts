/** State and calls shared by the main process, the preload bridge and the shell UI. */

export type ViewName = "panel" | "updates" | "support" | "about";
export const VIEWS: readonly ViewName[] = ["panel", "updates", "support", "about"];

export type AgentStatus = "starting" | "running" | "restarting" | "stopping" | "stopped" | "error" | "conflict";

export interface AgentState {
  status: AgentStatus;
  message: string | null;
  port: number;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  engineVersion: string | null;
  /** True when the app joined an engine it started earlier (after the window was closed and reopened). */
  adopted: boolean;
}

export type Channel = "stable" | "beta";

export type UpdateStatus = "idle" | "dev" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  channel: Channel;
  availableVersion: string | null;
  progress: number | null;
  error: string | null;
  lastCheckedAt: number | null;
  /** Windows installs updates in place. macOS needs a signed app for that, so it opens the downloaded .dmg instead. */
  inPlaceInstall: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  packaged: boolean;
}

export interface Settings {
  channel: Channel;
  launchAtLogin: boolean;
  trayHintShown: boolean;
}

export interface ShellState {
  app: AppInfo;
  agent: AgentState;
  update: UpdateState;
  settings: Settings;
  view: ViewName;
}

export interface VersionItem {
  version: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  channel: Channel;
  url: string;
  isCurrent: boolean;
  isNewer: boolean;
  installable: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellApi {
  getState(): Promise<ShellState>;
  onState(cb: (s: ShellState) => void): () => void;
  navigate(view: ViewName): Promise<void>;
  setPanelBounds(r: Rect): void;
  restartAgent(): Promise<void>;
  openDataFolder(): Promise<void>;
  openLogsFolder(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  setChannel(c: Channel): Promise<void>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  listVersions(): Promise<{ items: VersionItem[]; error: string | null }>;
  installVersion(version: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export const IPC = {
  getState: "shell:get-state",
  state: "shell:state",
  navigate: "shell:navigate",
  panelBounds: "shell:panel-bounds",
  restartAgent: "agent:restart",
  openDataFolder: "support:open-data",
  openLogsFolder: "support:open-logs",
  copyDiagnostics: "support:copy-diagnostics",
  setLaunchAtLogin: "settings:launch-at-login",
  setChannel: "updates:set-channel",
  checkForUpdates: "updates:check",
  downloadUpdate: "updates:download",
  installUpdate: "updates:install",
  listVersions: "updates:list-versions",
  installVersion: "updates:install-version",
  openExternal: "shell:open-external",
} as const;
