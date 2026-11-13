"use client";
import {
  BotConfigSchema, EXCHANGES, expandProfiles, exitPreview, validateBotConfig,
  type BotConfig, type Rule, type RuleOp,
} from "@oisniper/core";
import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/agent";
import { Button, Card, cx, Field, Input, Segmented, Stepper, Switch } from "./ui";

const OPS: { value: RuleOp; label: string }[] = [
  { value: "gte", label: "≥" }, { value: "gt", label: ">" }, { value: "lte", label: "≤" }, { value: "lt", label: "<" }, { value: "between", label: "between" },
];
const label = (m: string) => m.replace(/^oi_chg_/, "OI Δ ").replace(/^vol_chg_/, "Volume Δ ").replace(/^price_chg_/, "Price Δ ");

/** Strategy builder. Every save creates an immutable version on the agent. */
export function BotEditor({ botId, initial, running, onSaved }: { botId: string; initial: BotConfig; running: boolean; onSaved: () => void }) {
  const [c, setC] = useState<BotConfig>(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof BotConfig>(k: K, v: BotConfig[K]) => setC({ ...c, [k]: v });
  const setRule = (i: number, r: Partial<Rule>) => set("rules", c.rules.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const parsed = BotConfigSchema.safeParse(c);
  const validation = useMemo(() => (parsed.success ? validateBotConfig(parsed.data) : null), [parsed]);
  const profiles = parsed.success ? expandProfiles(parsed.data) : [];
  const preview = profiles[0] ? exitPreview(profiles[0], c.execution.takerFeeOverridePct.binance ?? "0.05") : null;
  const isGrid = !!c.variants;
  // Agents older than adaptive entry return configs without it.
  const ad = c.adaptive ?? { leverage: "off", minLeverage: 5, size: "off", minSizePct: 25 };
  const groups = c.ruleGroups ?? [];
  const reentry = c.reentry ?? "after_close";
  const groupOf = (m: string) => groups.find((g) => g.metrics.includes(m as never));

  const save = async () => {
    setMsg(null);
    try {
      const r = await api<{ versionId: string }>(`/api/bots/${botId}/config`, { method: "PUT", json: c });
      setMsg({ ok: true, text: `Saved as ${r.versionId}` });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const exportPreset = () => {
    const blob = new Blob([JSON.stringify({ format: "oisniper-preset@1", config: c }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `oisniper-preset-${botId}.json`;
    a.click();
  };
  const importPreset = async (f: File) => {
    try {
      const j = JSON.parse(await f.text()) as { config: unknown };
      const p = BotConfigSchema.safeParse(j.config);
      if (!p.success) throw new Error("Not a valid preset file");
      setC({ ...p.data, mode: c.mode });
      setMsg({ ok: true, text: "Preset loaded. Review and Save to create a version." });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Signal Data Source" action={<span className="text-xs text-muted">Both sources are always collected; this picks the one this bot trades on. Changing it creates a new version.</span>}>
        <div className="flex flex-wrap items-center gap-4">
          <Segmented value={c.dataSource.kind} onChange={(v) => set("dataSource", { ...c.dataSource, kind: v })} options={[{ value: "coinglass", label: "CoinGlass" }, { value: "exchange", label: "Exchange" }]} />
          {c.dataSource.kind === "exchange" && (
            <Field label="OI scope" hint={c.dataSource.oiScope === "aggregated" ? "USD OI summed over Binance, Bybit, OKX, Gate, KuCoin (closest to CoinGlass)" : "OI of the trade venue only (first selected exchange, Binance for ALL)"}>
              <Segmented value={c.dataSource.oiScope} onChange={(v) => set("dataSource", { ...c.dataSource, oiScope: v })} options={[{ value: "aggregated", label: "Aggregated" }, { value: "venue", label: "Trade venue only" }]} />
            </Field>
          )}
        </div>
      </Card>
      <Card title="Strategy rules" action={<span className="text-xs text-muted">{groups.length ? "Enabled rows outside a group are AND-ed; each group needs its minimum." : "All enabled rows AND-ed."} Disabled rows are still logged.</span>}>
        {groups.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-3">
            {groups.map((g, gi) => (
              <div key={g.name} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm">
                <span>{g.name}: at least</span>
                <Stepper value={g.minPass} step={1} onChange={(v) => set("ruleGroups", groups.map((x, j) => (j === gi ? { ...x, minPass: Math.max(1, v ?? 1) } : x)))} />
                <span className="text-muted">of {g.metrics.map(label).join(", ")}</span>
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {c.rules.map((r, i) => (
            <div key={r.metric} className={cx("flex items-center gap-2 rounded-xl border border-line px-3 py-2", !r.enabled && "opacity-60")}>
              <Switch checked={r.enabled} onChange={(v) => setRule(i, { enabled: v })} label={r.metric} />
              <span className="w-24 shrink-0 whitespace-nowrap text-sm">{label(r.metric)}</span>
              <select className="h-8 rounded-lg border border-line bg-elevated px-1 text-sm" value={r.op} onChange={(e) => setRule(i, { op: e.target.value as RuleOp, value2: e.target.value === "between" ? r.value2 ?? r.value + 1 : null })}>
                {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <Input className="!h-8 w-20" type="number" step="0.01" value={r.value} onChange={(e) => setRule(i, { value: Number(e.target.value) })} />
              {r.op === "between" && <Input className="!h-8 w-20" type="number" step="0.01" value={r.value2 ?? ""} onChange={(e) => setRule(i, { value2: Number(e.target.value) })} />}
              <span className="text-xs text-muted">%</span>
              {groupOf(r.metric) && <span className="ml-auto rounded-md bg-elevated px-1.5 text-xs text-muted">{groupOf(r.metric)!.name}</span>}
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label="Min OI value $"><Stepper value={c.filters.minOiValue} step={1_000_000} onChange={(v) => set("filters", { ...c.filters, minOiValue: v })} /></Field>
          <Field label="Min 24h volume $"><Stepper value={c.filters.minVolume24h} step={1_000_000} onChange={(v) => set("filters", { ...c.filters, minVolume24h: v })} /></Field>
          <Field label="Max funding rate %"><Stepper value={c.filters.maxFundingRate} step={0.01} onChange={(v) => set("filters", { ...c.filters, maxFundingRate: v })} /></Field>
          <Field label="Blacklist (comma)"><Input value={c.filters.blacklist.join(",")} onChange={(e) => set("filters", { ...c.filters, blacklist: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></Field>
        </div>
      </Card>

      <Card title="Exits and leverage">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="TP/SL basis"><Segmented value={c.exits.basis} onChange={(v) => set("exits", { ...c.exits, basis: v })} options={[{ value: "roe", label: "ROE %" }, { value: "price", label: "Price %" }]} /></Field>
          <Field label={isGrid ? "Leverage set" : "Leverage"} hint={isGrid ? "comma separated" : undefined}>
            {isGrid ? <Input value={c.leverages.join(",")} onChange={(e) => set("leverages", e.target.value.split(",").map((x) => parseInt(x, 10)).filter((x) => x > 0))} />
              : <Stepper value={c.leverages[0] ?? 1} step={1} onChange={(v) => set("leverages", [v ?? 1])} suffix="x" />}
          </Field>
          <Field label="Stop loss" hint={preview && `= ${preview.slPricePct.toFixed(2)}% price at ${preview.leverage}x, liq ${preview.liqPricePct.toFixed(2)}%`}><Stepper value={c.exits.slPct} step={1} onChange={(v) => set("exits", { ...c.exits, slPct: v ?? 0 })} suffix="%" /></Field>
          <Field label="TP1" hint={preview && `= +${preview.tp1PricePct.toFixed(2)}% price, fees ${preview.feeRoe.toFixed(1)}% ROE`}><Stepper value={c.exits.tp1Pct} step={1} onChange={(v) => set("exits", { ...c.exits, tp1Pct: v ?? 0 })} suffix="%" /></Field>
          {!isGrid && <>
            <Field label="Trailing after TP1"><Switch checked={c.exits.trailEnabled} onChange={(v) => set("exits", { ...c.exits, trailEnabled: v, tp1ClosePct: v ? c.exits.tp1ClosePct : 100 })} /></Field>
            <Field label="Close at TP1"><Stepper value={c.exits.tp1ClosePct} step={5} onChange={(v) => set("exits", { ...c.exits, tp1ClosePct: v ?? 0 })} suffix="%" /></Field>
            <Field label="Lock SL after TP1"><Stepper value={c.exits.lockPct} step={1} onChange={(v) => set("exits", { ...c.exits, lockPct: v ?? 0 })} suffix="%" /></Field>
            <Field label="Trail distance"><Stepper value={c.exits.trailDistancePct} step={1} onChange={(v) => set("exits", { ...c.exits, trailDistancePct: v ?? 0 })} suffix="pts" /></Field>
          </>}
          <Field label="Max hold (0 = off)"><Stepper value={c.exits.maxHoldHours} step={1} onChange={(v) => set("exits", { ...c.exits, maxHoldHours: v ?? 0 })} suffix="h" /></Field>
          <Field label="Trigger price"><Segmented value={c.exits.triggerPrice} onChange={(v) => set("exits", { ...c.exits, triggerPrice: v })} options={[{ value: "mark", label: "Mark" }, { value: "last", label: "Last" }]} /></Field>
          <Field label="Cooldown" hint={reentry === "while_open" ? "From the last entry on the coin" : "From entry and from close"}>
            <Stepper value={Math.round(c.cooldownHours * 60)} step={5} onChange={(v) => set("cooldownHours", Math.max(0, v ?? 0) / 60)} suffix="min" />
          </Field>
          {c.mode === "paper" && (
            <Field label="Re-entry" hint={reentry === "while_open" ? "Opens again after the cooldown even with positions open" : "Waits until the position is closed"}>
              <Segmented value={reentry} onChange={(v) => set("reentry", v)} options={[{ value: "after_close", label: "After close" }, { value: "while_open", label: "While open" }]} />
            </Field>
          )}
        </div>
        {isGrid && c.variants && (
          <div className="mt-4 text-xs text-muted">Grid: {c.leverages.length} leverages × {c.variants.length} trail variants = {c.leverages.length * c.variants.length} virtual positions per signal ({c.variants.map((v) => `${v.id} ${v.name}`).join(", ")}).</div>
        )}
      </Card>

      {!isGrid && (
        <Card title="Adaptive entry" action={<span className="text-xs text-muted">Off = a coin that lacks the leverage or depth is rejected. On = step down to what works. Never raises leverage or size.</span>}>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Leverage" hint={ad.leverage === "fit" ? `Uses the highest leverage ≤ ${c.leverages[0] ?? 1}x the coin offers and every gate passes` : "Configured leverage only"}>
              <Segmented value={ad.leverage} onChange={(v) => set("adaptive", { ...ad, leverage: v })} options={[{ value: "off", label: "Fixed" }, { value: "fit", label: "Fit to coin" }]} />
            </Field>
            <Field label="Min leverage" hint={c.exits.basis === "roe" ? `SL ${c.exits.slPct}% ROE = ${(c.exits.slPct / Math.max(ad.minLeverage, 1)).toFixed(2)}% price at ${ad.minLeverage}x (same $ risk)` : undefined}>
              <Stepper value={ad.minLeverage} step={1} onChange={(v) => set("adaptive", { ...ad, minLeverage: v ?? ad.minLeverage })} suffix="x" />
            </Field>
            <Field label="Size" hint={ad.size === "fit" ? "Shrinks margin only when no leverage works at full size (depth, slippage, cost)" : "Configured margin only"}>
              <Segmented value={ad.size} onChange={(v) => set("adaptive", { ...ad, size: v })} options={[{ value: "off", label: "Fixed" }, { value: "fit", label: "Fit to book" }]} />
            </Field>
            <Field label="Min size" hint="Share of the configured margin">
              <Stepper value={ad.minSizePct} step={5} onChange={(v) => set("adaptive", { ...ad, minSizePct: v ?? ad.minSizePct })} suffix="%" />
            </Field>
          </div>
        </Card>
      )}

      <Card title="Sizing, risk and venues">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Margin per trade"><Segmented value={c.sizing.mode} onChange={(v) => set("sizing", { ...c.sizing, mode: v })} options={[{ value: "pct_balance", label: "% balance" }, { value: "fixed", label: "Fixed $" }]} /></Field>
          <Field label={c.sizing.mode === "fixed" ? "USDT" : "% of balance"}><Stepper value={Number(c.sizing.value)} step={1} onChange={(v) => set("sizing", { ...c.sizing, value: String(v ?? 0) })} /></Field>
          <Field label="Paper initial funds" hint={c.paperInitialFunds == null ? "Unlimited: equity tracked from $0" : undefined}><Input value={c.paperInitialFunds ?? ""} placeholder="unlimited" onChange={(e) => set("paperInitialFunds", e.target.value === "" ? null : e.target.value)} /></Field>
          <Field label="Max capital (live)"><Input value={c.risk.maxCapital ?? ""} placeholder="required for live" onChange={(e) => set("risk", { ...c.risk, maxCapital: e.target.value === "" ? null : e.target.value })} /></Field>
          <Field label="Max open positions"><Stepper value={c.risk.maxOpenPositions} step={1} onChange={(v) => set("risk", { ...c.risk, maxOpenPositions: v })} /></Field>
          <Field label="Max daily loss %"><Stepper value={c.risk.maxDailyLossPct} step={1} onChange={(v) => set("risk", { ...c.risk, maxDailyLossPct: v })} /></Field>
          <Field label="Max drawdown %"><Stepper value={c.risk.maxDrawdownPct} step={1} onChange={(v) => set("risk", { ...c.risk, maxDrawdownPct: v })} /></Field>
          <Field label="Loss streak pause"><Stepper value={c.risk.consecutiveLossLimit} step={1} onChange={(v) => set("risk", { ...c.risk, consecutiveLossLimit: v })} /></Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Exchanges</span>
          <Button size="sm" variant={c.exchanges === "ALL" ? "primary" : "default"} onClick={() => set("exchanges", "ALL")}>ALL (router)</Button>
          {EXCHANGES.map((ex) => {
            const on = c.exchanges !== "ALL" && c.exchanges.includes(ex);
            return <Button key={ex} size="sm" variant={on ? "primary" : "default"} onClick={() => {
              const cur = c.exchanges === "ALL" ? [] : c.exchanges;
              const next = on ? cur.filter((x) => x !== ex) : [...cur, ex];
              set("exchanges", next.length ? next : "ALL");
            }}>{ex}</Button>;
          })}
        </div>
      </Card>

      <Card title="Gates (share of TP1 distance)">
        <div className="grid gap-3 md:grid-cols-4">
          {([["maxSpreadPct", "Max spread %", 0.01], ["entryDepthMult", "Entry depth ×", 1], ["exitDepthMult", "Exit depth ×", 1], ["maxEntrySlippagePct", "Max entry slip %", 0.01], ["maxCostToTargetPct", "Max cost-to-target %", 5], ["maxChasePct", "Max chase %", 5], ["maxVolatilityPct", "Max 1m range %", 10], ["minVolume24h", "Min 24h volume $", 1_000_000], ["maxFundingPct", "Max funding %", 0.01]] as const).map(([k, l, s]) => (
            <Field key={k} label={l}><Stepper value={c.gates[k]} step={s} onChange={(v) => set("gates", { ...c.gates, [k]: v ?? 0 })} /></Field>
          ))}
        </div>
      </Card>

      {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="space-y-1">
          {validation.errors.map((e, i) => <div key={i} className="rounded-xl bg-neg/10 px-3 py-2 text-sm text-neg">{e.message}</div>)}
          {validation.warnings.slice(0, 6).map((e, i) => <div key={i} className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{e.message}</div>)}
        </div>
      )}
      {!parsed.success && <div className="rounded-xl bg-neg/10 px-3 py-2 text-sm text-neg">{parsed.error.issues[0]?.path.join(".")}: {parsed.error.issues[0]?.message}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!parsed.success || (validation?.errors.length ?? 1) > 0} onClick={save}>Save new version</Button>
        <Button onClick={() => setC(initial)}>Revert</Button>
        <Button onClick={exportPreset}>Export preset</Button>
        <label className="inline-flex h-9 cursor-pointer items-center rounded-xl border border-line bg-elevated px-4 text-sm">Import preset<input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void importPreset(e.target.files[0])} /></label>
        {running && <span className="text-xs text-muted">Open positions keep the version they opened with.</span>}
        {msg && <span className={cx("text-sm", msg.ok ? "text-pos" : "text-neg")}>{msg.text}</span>}
      </div>
    </div>
  );
}
