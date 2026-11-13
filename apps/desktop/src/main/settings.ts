import { app } from "electron";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Settings } from "../shared/types";
import { log } from "./logger";

const schema = z.object({
  channel: z.enum(["stable", "beta"]).default("stable"),
  launchAtLogin: z.boolean().default(false),
  trayHintShown: z.boolean().default(false),
});

const file = () => join(app.getPath("userData"), "settings.json");

/** Desktop-app preferences only. Bot settings live in the agent's own database and are not touched here. */
export function loadSettings(): Settings {
  try {
    return schema.parse(JSON.parse(readFileSync(file(), "utf8")));
  } catch {
    return schema.parse({});
  }
}

export function saveSettings(s: Settings): void {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify(schema.parse(s), null, 2));
    renameSync(tmp, file());
  } catch (e) {
    log.error("settings save failed", (e as Error).message);
  }
}
