import log from "electron-log/main";
import { app } from "electron";
import { join } from "node:path";
import { redactLine } from "./pure/agentOutput";

/** main.log: desktop app events. agent.log: the agent's console output, redacted line by line. */
export function initLogging(): void {
  log.initialize();
  log.transports.file.resolvePathFn = () => join(logsDir(), "main.log");
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.console.level = app.isPackaged ? false : "info";
  log.hooks.push((msg) => ({ ...msg, data: msg.data.map((d) => (typeof d === "string" ? redactLine(d) : d)) }));
}

export const agentLog = log.create({ logId: "agent" });
agentLog.transports.file.resolvePathFn = () => join(logsDir(), "agent.log");
agentLog.transports.file.maxSize = 10 * 1024 * 1024;
agentLog.transports.console.level = false;

export function logsDir(): string {
  return join(app.getPath("userData"), "logs");
}

export { log };
