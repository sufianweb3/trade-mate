import type { MetricRow } from "@oisniper/core";
import type { App } from "../app";
import type { SignalRecord, TradeRecord } from "../store/types";
import type { VirtualClock } from "../util/clock";
import type { DemoHub } from "./demoHub";
import type { DemoSource } from "./demoSource";
import { pumpMetrics } from "./world";

export interface Check {
  scenario: string;
  name: string;
  pass: boolean;
  detail: string;
}

/** Scenario helpers. Every check is recorded with the measured values. */
export class Harness {
  checks: Check[] = [];
  scenario = "";
  log: string[] = [];

  constructor(public app: App, public hub: DemoHub, public src: DemoSource, public clock: VirtualClock) {}

  begin(name: string): void {
    this.scenario = name;
    this.note(`\n## ${name}  (${new Date(this.clock.now()).toISOString()})`);
  }
  note(s: string): void {
    this.log.push(s);
    if (process.env.DEMO_LIVE) console.log(s);
  }
  check(name: string, pass: boolean, detail: unknown = ""): boolean {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    this.checks.push({ scenario: this.scenario, name, pass, detail: d });
    this.note(`- [${pass ? "PASS" : "FAIL"}] ${name}${d ? `: ${d}` : ""}`);
    return pass;
  }

  /** Advance in chunks so long waits stay responsive. */
  async wait(ms: number): Promise<void> {
    const coarse = ms >= 600_000; // long waits: 5s market ticks instead of 500ms
    if (coarse) this.hub.setTickMs(5000);
    const step = coarse ? 60_000 : 5000;
    for (let left = ms; left > 0; left -= step) await this.clock.advance(Math.min(step, left));
    if (coarse) this.hub.setTickMs(500);
  }
  /** Await engine work that itself waits on simulated latency, keeping the virtual clock moving. */
  async during<T>(p: Promise<T>): Promise<T> {
    let done = false;
    const q = p.finally(() => (done = true));
    while (!done) await this.clock.advance(100);
    return q;
  }

  /** Advance until the next scrape has run and been processed. */
  async nextScrape(): Promise<void> {
    await this.wait(this.app.scraper.state.intervalMs + 1000);
  }

  price(base: string): number {
    return this.hub.refPrice(base, this.clock.now());
  }
  pump(base: string, over: Partial<MetricRow> = {}): void {
    this.src.set(base, { ...pumpMetrics(this.price(base)), ...over });
  }
  quiet(base: string): void {
    this.src.quiet(base, this.price(base));
  }

  signals(bot: string, symbol?: string): SignalRecord[] {
    return this.app.store.records.listSignals({ botId: bot, limit: 100000 }).filter((s) => !symbol || s.symbol === symbol);
  }
  lastSignal(bot: string, symbol: string): SignalRecord | undefined {
    return this.signals(bot, symbol)[0];
  }
  trades(bot: string, symbol?: string, f: { status?: "open" | "closed" } = {}): TradeRecord[] {
    return this.app.store.records.listTrades({ botId: bot, symbol, status: f.status });
  }
  events(tradeId: string) {
    return this.app.store.records.events(tradeId);
  }
  bot(id: string) {
    return this.app.bots.get(id);
  }

  summary(): { pass: number; fail: number } {
    return { pass: this.checks.filter((c) => c.pass).length, fail: this.checks.filter((c) => !c.pass).length };
  }
}
