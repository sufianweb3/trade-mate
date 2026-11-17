import { execFile } from "node:child_process";
import { log } from "../log";

/**
 * Chromium refuses a second instance on the same profile ("Opening in existing browser session"). That happened when
 * the scraper switched between hidden and visible: the old browser was still shutting down (Brave keeps helper
 * processes alive), the relaunch failed and CoinGlass stayed dead. Errors that mean "profile still held":
 */
export const PROFILE_BUSY = /existing browser session|profile is already in use|processsingleton|user data directory is already in use|has been closed/i;

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<string>((res) => execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 15_000, windowsHide: true }, (_e, out) => res(String(out ?? ""))));

/**
 * Kill browser processes started on OUR dedicated profile folder. The user's own browser runs on a different profile,
 * so it is never matched. Returns how many processes were stopped.
 */
export async function killProfileBrowsers(profileDir: string): Promise<number> {
  if (process.platform === "win32") {
    // Path passed through the environment, never interpolated into the script.
    const ps =
      "$d=$env:OIS_PROFILE.ToLower(); $n=0; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($d) -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n";
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { OIS_PROFILE: profileDir });
    return Number.parseInt(out.trim(), 10) || 0;
  }
  const out = await run("ps", ["-axo", "pid=,command="]);
  let n = 0;
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2]!.includes(profileDir) || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), "SIGKILL");
      n++;
    } catch {
      /* already gone */
    }
  }
  return n;
}

/**
 * Launch on the profile; when the profile is still held, free it (kill leftovers on our profile) and retry with a
 * growing pause. Other errors are thrown right away.
 */
export async function launchFreeingProfile<T>(
  launch: () => Promise<T>,
  free: () => Promise<number>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 4,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await launch();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= attempts - 1 || !PROFILE_BUSY.test(msg)) throw e;
      const killed = await free().catch(() => 0);
      log.warn({ attempt: i + 1, killed, err: msg.split("\n")[0] }, "coinglass profile busy, freeing it and retrying");
      await sleep(1000 * (i + 1));
    }
  }
}
