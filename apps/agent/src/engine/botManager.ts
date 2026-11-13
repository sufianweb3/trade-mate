import { BOT1_PRESET, BOT2_PRESET, type BotConfig, type MetricsSnapshot } from "@oisniper/core";
import type { Bus } from "../bus";
import { log } from "../log";
import type { SleepGuard } from "../risk/sleepGuard";
import { BotInstance, type BotDeps } from "./botInstance";

/**
 * Three independent bots, each with its own account, history and settings:
 * Paper = Bot 1 Sniper on the simulator, Real = Bot 1 Sniper live, Test = Bot 2 Research Grid (paper).
 * Mode is fixed per bot, so editing Paper settings can never change Real settings.
 */
export const BOT_IDS = ["paper", "real", "test"] as const;
export type BotId = (typeof BOT_IDS)[number];
const PRESETS: { id: BotId; preset: string; cfg: BotConfig }[] = [
  { id: "paper", preset: "sniper", cfg: { ...BOT1_PRESET, name: "Paper" } },
  { id: "real", preset: "sniper", cfg: { ...BOT1_PRESET, name: "Real", mode: "live" } },
  { id: "test", preset: "research_grid_v2", cfg: { ...BOT2_PRESET, name: "Test" } },
];

/**
 * One-time upgrade of a Test bot created before the 2026-11-10 grid change: saves a new version with the new entry
 * rules, leverages, $100 margin and 15 min re-entry. Other settings (venues, gates, exits, data source) are kept.
 * Old versions stay immutable; open trades keep the version they opened with.
 */
function upgradeTestBot(cfg: BotConfig): BotConfig {
  const p = BOT2_PRESET;
  return { ...cfg, rules: p.rules, ruleGroups: p.ruleGroups, leverages: p.leverages, sizing: p.sizing, cooldownHours: p.cooldownHours, reentry: p.reentry };
}

/** Owns all bot instances, fans snapshots out, and runs the global kill switch. */
export class BotManager {
  readonly bots = new Map<string, BotInstance>();
  private kill = false;
  private unsub: (() => void)[] = [];

  constructor(
    private d: Omit<BotDeps, "killSwitch">,
    private bus: Bus,
    private sleep: SleepGuard | null,
  ) {}

  get killSwitchActive(): boolean {
    return this.kill;
  }

  async init(): Promise<void> {
    const now = this.d.clock.now();
    for (const p of PRESETS) {
      const existing = this.d.store.getBot(p.id);
      if (existing?.id === "test" && existing.preset === "research_grid") {
        const cur = this.d.store.getVersion(existing.current_version_id)!.config;
        const v = this.d.store.saveVersion(p.id, upgradeTestBot(cur), now);
        this.d.store.updateBot(p.id, { current_version_id: v.id, preset: p.preset });
        log.info({ botId: p.id, versionId: v.id }, "test bot upgraded to research_grid_v2");
      }
      if (existing) continue;
      const v = this.d.store.saveVersion(p.id, p.cfg, now);
      this.d.store.insertBot({ id: p.id, name: p.cfg.name, preset: p.preset, current_version_id: v.id, created_at: now });
    }
    for (const row of this.d.store.listBots()) {
      if (!(BOT_IDS as readonly string[]).includes(row.id)) continue; // legacy rows stay in the DB for export
      const b = new BotInstance({ ...this.d, killSwitch: () => this.kill }, row);
      await b.init(); // reconciles and keeps managing open positions
      // Never auto-start: every agent start leaves all bots Stopped.
      if (b.row().status !== "stopped") b.setStatus("stopped", "AGENT_START");
      this.bots.set(row.id, b);
    }
    this.unsub.push(this.bus.on("snapshot", (s) => void this.fanOut(s)));
    const upd = () => this.sleep?.set(this.openCount() > 0);
    this.unsub.push(this.bus.on("trade:opened", upd), this.bus.on("trade:closed", upd));
    upd();
  }

  get(id: string): BotInstance {
    const b = this.bots.get(id);
    if (!b) throw Object.assign(new Error(`bot ${id} not found`), { code: "NOT_FOUND" });
    return b;
  }

  openCount(): number {
    let n = 0;
    for (const b of this.bots.values()) n += b.pm.openCount();
    return n;
  }

  anyLiveRunning(): boolean {
    return [...this.bots.values()].some((b) => b.mode === "live" && b.row().running === 1);
  }

  /** Snapshots are processed by each bot independently and in parallel. */
  fanOut(s: MetricsSnapshot): Promise<void[]> {
    return Promise.all([...this.bots.values()].map((b) => b.handleSnapshot(s, s.health.status)));
  }

  /** Global kill: stop all bots, cancel orders, market-close everything. */
  async killAll(): Promise<{ closed: number }> {
    this.kill = true;
    const before = this.openCount();
    this.bus.emit("alert", { level: "error", kind: "KILL_SWITCH", message: "Kill switch engaged", ts: this.d.clock.now() });
    await Promise.all([...this.bots.values()].map((b) => b.kill()));
    log.warn({ closed: before - this.openCount() }, "kill switch engaged");
    return { closed: before - this.openCount() };
  }

  releaseKill(): void {
    this.kill = false;
  }

  async dispose(): Promise<void> {
    for (const u of this.unsub) u();
    for (const b of this.bots.values()) await b.dispose();
  }
}
