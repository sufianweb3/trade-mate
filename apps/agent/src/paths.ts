import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** %APPDATA%\oisniper, ~/Library/Application Support/oisniper or ~/.local/share/oisniper. */
export function defaultDataDir(): string {
  if (process.env.OISNIPER_DATA_DIR) return process.env.OISNIPER_DATA_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "oisniper");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "oisniper");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oisniper");
}

export interface DataPaths {
  root: string;
  db: string;
  browserProfile: string;
  logs: string;
  exports: string;
}

export function dataPaths(root = defaultDataDir()): DataPaths {
  const p = {
    root,
    db: join(root, "oisniper.db"),
    browserProfile: join(root, "browser-profile"),
    logs: join(root, "logs"),
    exports: join(root, "exports"),
  };
  for (const d of [p.root, p.logs, p.exports]) mkdirSync(d, { recursive: true });
  return p;
}
