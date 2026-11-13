import { app } from "electron";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AgentLaunch {
  /** Node runtime that runs the agent (bundled in the installer; the system `node` in development). */
  node: string;
  /** Agent bundle entry (apps/agent/dist/main.js). */
  script: string;
  cwd: string;
  panelDir: string;
}

/** Packaged: <resources>/agent/{runtime,app}, staged by scripts/stage-agent.mjs. Dev: the monorepo's own build output. */
export function agentLaunch(): AgentLaunch {
  if (app.isPackaged) {
    const root = join(process.resourcesPath, "agent");
    const node = join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const appDir = join(root, "app");
    return { node, script: join(appDir, "main.js"), cwd: appDir, panelDir: join(appDir, "panel") };
  }
  const repo = resolve(app.getAppPath(), "..", "..");
  return {
    node: process.env.TRADE_MATE_NODE ?? "node",
    script: join(repo, "apps", "agent", "dist", "main.js"),
    cwd: join(repo, "apps", "agent"),
    panelDir: join(repo, "apps", "panel", "out"),
  };
}

/** Same folder the agent itself uses (apps/agent/src/paths.ts); shown in Support, never written by the desktop app. */
export function agentDataDir(): string {
  if (process.env.OISNIPER_DATA_DIR) return process.env.OISNIPER_DATA_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "oisniper");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "oisniper");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oisniper");
}

export function assetPath(name: string): string {
  return join(app.getAppPath(), "dist-electron", "assets", name);
}
