import { existsSync } from "node:fs";
import { join } from "node:path";

const BRAVE: Record<string, string[]> = {
  win32: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
  darwin: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  linux: ["/usr/bin/brave-browser", "/usr/bin/brave"],
};

/**
 * Browser for the CoinGlass profile: Brave, else Google Chrome, else Microsoft Edge, else Playwright's bundled Chromium.
 * A system browser avoids broken bundled builds and passes site checks like a normal visitor.
 * Override with OISNIPER_BROWSER=brave | chrome | msedge | bundled.
 */
export function browserLaunch(): { channel?: string; executablePath?: string } {
  const forced = process.env.OISNIPER_BROWSER;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const find = (rel: string) => (rel.startsWith("/") ? (existsSync(rel) ? rel : null) : roots.map((r) => join(r, rel)).find((p) => existsSync(p)) ?? null);
  const brave = () => (BRAVE[process.platform] ?? []).map(find).find(Boolean) ?? null;
  if (forced === "bundled") return {};
  if (forced === "brave") return brave() ? { executablePath: brave()! } : {};
  if (forced) return { channel: forced };
  const b = brave();
  if (b) return { executablePath: b };
  if (process.platform === "win32") {
    if (find("Google\\Chrome\\Application\\chrome.exe")) return { channel: "chrome" };
    if (find("Microsoft\\Edge\\Application\\msedge.exe")) return { channel: "msedge" };
    return {};
  }
  if (process.platform === "darwin") return existsSync("/Applications/Google Chrome.app") ? { channel: "chrome" } : {};
  return existsSync("/usr/bin/google-chrome") ? { channel: "chrome" } : {};
}
