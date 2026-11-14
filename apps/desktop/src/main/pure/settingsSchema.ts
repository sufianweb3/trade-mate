import { z } from "zod";
import type { Settings } from "../../shared/types";

/** Desktop-app preferences. Unknown or broken values fall back to the default instead of failing the app. */
const schema = z.object({
  channel: z.enum(["stable", "beta"]).catch("stable").default("stable"),
  launchAtLogin: z.boolean().catch(false).default(false),
  trayHintShown: z.boolean().catch(false).default(false),
  appearance: z.enum(["system", "light", "dark"]).catch("system").default("system"),
});

export function parseSettings(raw: unknown): Settings {
  const r = schema.safeParse(raw && typeof raw === "object" ? raw : {});
  return r.success ? r.data : schema.parse({});
}
