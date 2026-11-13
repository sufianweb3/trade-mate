import { spawn, type ChildProcess } from "node:child_process";
import { log } from "../log";

/** Prevent OS sleep while any position is open. The exchange stop is the real protection. */
export class SleepGuard {
  private proc: ChildProcess | null = null;
  constructor(private enabled = true) {}

  get active(): boolean {
    return this.proc != null;
  }

  set(want: boolean): void {
    if (!this.enabled) return;
    if (want && !this.proc) this.start();
    if (!want && this.proc) this.stop();
  }

  private start() {
    try {
      if (process.platform === "win32") {
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held for the life of this hidden PowerShell process.
        const script =
          "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
          "$t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru; $t::SetThreadExecutionState(0x80000001) | Out-Null;" +
          "while($true){ Start-Sleep -Seconds 30 }";
        this.proc = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { stdio: "ignore", windowsHide: true });
      } else if (process.platform === "darwin") {
        this.proc = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      } else {
        this.proc = spawn("systemd-inhibit", ["--what=sleep", "--why=OI Sniper open positions", "sleep", "infinity"], { stdio: "ignore" });
      }
      this.proc.on("error", (e) => {
        log.warn({ err: e.message }, "sleep guard unavailable");
        this.proc = null;
      });
      this.proc.on("exit", () => (this.proc = null));
      log.info("sleep guard on");
    } catch (e) {
      log.warn({ err: (e as Error).message }, "sleep guard failed");
      this.proc = null;
    }
  }

  private stop() {
    this.proc?.kill();
    this.proc = null;
    log.info("sleep guard off");
  }
}
