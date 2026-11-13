import { EXCHANGES, evalRule, type BotConfig, type ExchangeId, type MetricRow, type Rule } from "@oisniper/core";
import type { ExecutionAdapter } from "../execution/types";
import type { MarketHub } from "../market/types";
import type { SymbolMapper } from "../symbols/mapper";

const NEAR = 0.7;
const MAX_SYMBOLS = 8;

/** A rule is "near" when the metric is already passing or at >= 70% of a positive threshold. null is never near. */
export function nearRule(r: Rule, v: number | null): boolean {
  if (v == null || !Number.isFinite(v)) return false;
  if (evalRule(r, v)) return true;
  if (r.op === "gte" || r.op === "gt") return r.value > 0 && v >= r.value * NEAR;
  if (r.op === "lte" || r.op === "lt") return r.value > 0 && v <= r.value / NEAR;
  return r.value > 0 && v >= r.value * NEAR && (r.value2 == null || v <= r.value2);
}

/** Closeness 0..1 across enabled rules (min of per-rule ratios) for ranking. */
function closeness(rules: Rule[], m: MetricRow): number {
  let c = 1;
  for (const r of rules) {
    const v = m[r.metric];
    if (v == null) return 0;
    if (evalRule(r, v)) continue;
    c = Math.min(c, r.value > 0 ? v / r.value : 0);
  }
  return c;
}

/** Ungrouped enabled rules must all be near; each rule group needs at least `minPass` of its rules near. */
function isNear(cfg: BotConfig, rules: Rule[], m: MetricRow): boolean {
  const grouped = new Set(cfg.ruleGroups.flatMap((g) => g.metrics));
  if (!rules.filter((r) => !grouped.has(r.metric)).every((r) => nearRule(r, m[r.metric]))) return false;
  return cfg.ruleGroups.every(
    (g) => rules.filter((r) => g.metrics.includes(r.metric) && nearRule(r, m[r.metric])).length >= g.minPass,
  );
}

export function nearTrigger(cfg: BotConfig, rows: MetricRow[]): MetricRow[] {
  const rules = cfg.rules.filter((r) => r.enabled);
  if (!rules.length) return [];
  // Closeness ranks on ungrouped rules only: a group tolerates failing rows by design.
  const grouped = new Set(cfg.ruleGroups.flatMap((g) => g.metrics));
  const rank = rules.filter((r) => !grouped.has(r.metric));
  return rows
    .filter((m) => isNear(cfg, rules, m))
    .sort((a, b) => closeness(rank, b) - closeness(rank, a))
    .slice(0, MAX_SYMBOLS);
}

/**
 * Per bot: keep L2 books subscribed, limits resolved and (live) margin mode / position mode / leverage pre-set for
 * near-trigger symbols, so a real trigger is routing + gates on in-memory data + one order call.
 */
export class Watchlist {
  private current = new Set<string>();
  constructor(private d: { botId: string; hub: MarketHub; mapper: SymbolMapper; adapter: () => ExecutionAdapter }) {}

  async update(cfg: BotConfig, rows: MetricRow[]): Promise<string[]> {
    const near = nearTrigger(cfg, rows);
    const venues = (cfg.exchanges === "ALL" ? [...EXCHANGES] : cfg.exchanges).filter((e) => this.d.hub.exchanges.includes(e));
    const lev = cfg.liveSelection?.leverage ?? cfg.leverages[0] ?? 1;
    const next = new Set<string>();
    const reason = `watch:${this.d.botId}`;
    for (const m of near)
      for (const ex of venues as ExchangeId[]) {
        const r = this.d.mapper.resolve(m.symbol, ex, null, null);
        if (!r.ok) continue;
        const k = `${ex}|${r.mapping.symbol}`;
        next.add(k);
        if (this.current.has(k)) continue;
        void this.d.hub.subscribe(ex, r.mapping.symbol, reason).catch(() => undefined);
        void this.d.hub.resolveLimits(ex, r.mapping.symbol).catch(() => undefined);
        void this.d.adapter().prewarm(ex, r.mapping.symbol, lev).catch(() => undefined);
      }
    for (const k of this.current)
      if (!next.has(k)) {
        const [ex, sym] = k.split("|") as [ExchangeId, string];
        this.d.hub.unsubscribe(ex, sym, reason);
      }
    this.current = next;
    return near.map((m) => m.symbol);
  }

  clear(): void {
    for (const k of this.current) {
      const [ex, sym] = k.split("|") as [ExchangeId, string];
      this.d.hub.unsubscribe(ex, sym, `watch:${this.d.botId}`);
    }
    this.current.clear();
  }
}
