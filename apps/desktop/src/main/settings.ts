import { app } from "electron";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../shared/types";
import { log } from "./logger";
import { parseSettings } from "./pure/settingsSchema";

const file = () => join(app.getPath("userData"), "settings.json");

/** Desktop-app preferences only. Bot settings live in the agent's own database and are not touched here. */
export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    return parseSettings({});
  }
}

export function saveSettings(s: Settings): void {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(parseSettings(s), null, 2));
    renameSync(tmp, file());
  } catch (e) {
    log.error("settings save failed", (e as Error).message);
  }
}
