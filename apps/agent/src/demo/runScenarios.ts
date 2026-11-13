// `pnpm demo:scenarios`: run the full agent through two simulated trading days on a virtual clock.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, setLogger } from "../log";
import { VirtualClock } from "../util/clock";
import { Harness } from "./harness";
import { day1, day2, overnight } from "./scenarios";
import { evening, restart } from "./scenarios2";
import { buildWorld } from "./world";

export async function runAll(outDir: string): Promise<Harness> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  setLogger(createLogger({ level: "warn" }));
  const dbFile = join(outDir, "demo.db");
  const clock = new VirtualClock();
  const w = buildWorld(dbFile, clock);
  w.app.store.setSetting("warm_set_size", 0);
  await w.app.start();
  const h = new Harness(w.app, w.hub, w.src, clock);
  h.note(`# OI Sniper v2 demo run\n\nVirtual clock start ${new Date(clock.now()).toISOString()}. Synthetic exchange books (6 venues), CoinGlass-style table parsed by the real parser, full engine + SimAdapter + SQLite.`);
  await h.app.bots.get("paper").start();
  await h.app.bots.get("test").start();
  const steps: [string, () => Promise<unknown>][] = [
    ["day1", () => day1(h)],
    ["overnight", () => overnight(h)],
    ["day2", () => day2(h)],
    ["restart", () => restart(h, dbFile)],
    ["evening", () => evening(h, join(outDir, "exports"))],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      h.check(`${name} crashed`, false, (e as Error).stack?.split("\n").slice(0, 4).join(" | ") ?? String(e));
    }
  }
  await h.app.stop().catch(() => undefined);
  const s = h.summary();
  h.note(`\n---\n**${s.pass} passed, ${s.fail} failed** (virtual end ${new Date(clock.now()).toISOString()})`);
  writeFileSync(join(outDir, "DEMO_REPORT.md"), h.log.join("\n") + "\n");
  return h;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = resolve(process.env.DEMO_OUT ?? join(process.cwd(), "..", "..", ".demo-data", "scenarios"));
  const t0 = Date.now();
  let finished = false;
  // An await on a virtual timer nobody advances drains the event loop: report it instead of exiting 0.
  process.on("beforeExit", () => {
    if (!finished) {
      console.error("DEADLOCK: scenario awaited a virtual timer without advancing the clock");
      process.exit(2);
    }
  });
  runAll(out).then((h) => {
    finished = true;
    console.log(h.log.join("\n"));
    const s = h.summary();
    console.log(`\n${s.pass} passed, ${s.fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s. Report: ${join(out, "DEMO_REPORT.md")}`);
    process.exit(s.fail ? 1 : 0);
  });
}
