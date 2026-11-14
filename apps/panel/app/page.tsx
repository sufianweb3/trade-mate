"use client";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { BotControls, ViewSelect } from "@/components/bot-controls";
import { EquityChart } from "@/components/equity-chart";
import { GetStarted } from "@/components/get-started";
import { useView } from "@/lib/view";
import { Button, Card, ConfirmDialog, cx, Empty, ErrorBox, List, ListRow, Loading, ModeBadge, Segmented, Signed, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/agent";
import { dur, n, pct, price, tone, usd } from "@/lib/format";
import type { BotResp, OverviewBot } from "@/lib/types";

type CardId = "balance" | "start" | "net" | "unreal" | "trades" | "win" | "pf" | "exp" | "dd" | "fees" | "funding" | "slip" | "gap";
const ALL_CARDS: CardId[] = ["balance", "start", "net", "unreal", "trades", "win", "pf", "exp", "dd", "fees", "funding", "slip", "gap"];
const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, all: Number.POSITIVE_INFINITY } as const;

function combine(list: OverviewBot[]) {
  const sum = (f: (b: OverviewBot) => string | null) => list.reduce((a, b) => a + (n(f(b)) ?? 0), 0);
  const k = list.map((b) => b.kpis);
  const trades = k.reduce((a, x) => a + x.trades, 0);
  const wins = k.reduce((a, x) => a + x.wins, 0);
  return {
    total: sum((b) => b.totalBalance), start: sum((b) => b.startBalance), net: sum((b) => b.kpis.netPnl), unreal: sum((b) => b.unrealized),
    trades, wins, losses: trades - wins, win: trades ? (wins / trades) * 100 : null,
    gp: k.reduce((a, x) => a + (n(x.grossProfit) ?? 0), 0), gl: k.reduce((a, x) => a + (n(x.grossLoss) ?? 0), 0),
    fees: sum((b) => b.kpis.fees), funding: sum((b) => b.kpis.funding), dd: Math.max(0, ...list.map((b) => n(b.kpis.maxDrawdown) ?? 0)),
    ddPct: list.length === 1 ? list[0]!.kpis.maxDrawdownPct : null, slip: list.length === 1 ? list[0]!.kpis.avgSlippageUsd : null,
    gap: list.length === 1 ? list[0]!.kpis.avgSimGapPct : null, unlimited: list.some((b) => b.unlimited),
  };
}

interface KpiItem { label: string; value: string | number; tone?: string | number | null; sub?: string }

/** One KPI as a list row; draggable while customizing (order is saved in the agent). */
function SortableRow({ id, k, editing }: { id: string; k: KpiItem; editing: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled: !editing });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...(editing ? { ...attributes, ...listeners } : {})} className={editing ? "cursor-grab active:cursor-grabbing" : undefined}>
      <ListRow label={k.label} sub={k.sub} value={<span className={k.tone !== undefined ? tone(k.tone) : undefined}>{k.value}</span>} />
    </div>
  );
}

export default function Overview() {
  const bot = useView((s) => s.view);
  const [range, setRange] = useState<keyof typeof RANGES>("all");
  const [editing, setEditing] = useState(false);
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<BotResp[]>("/api/bots") });
  const ov = useQuery({ queryKey: ["overview", bot], queryFn: () => api<OverviewBot[]>(`/api/overview?bot=${bot}`) });
  const savedLayout = bots.data?.find((b) => b.id === bot)?.layout;
  const [cards, setCards] = useState<{ id: CardId; visible: boolean }[]>(ALL_CARDS.map((id) => ({ id, visible: true })));
  useEffect(() => {
    if (!savedLayout) return;
    try {
      const l = JSON.parse(savedLayout) as { cards: { id: CardId; visible: boolean }[] };
      setCards([...l.cards.filter((c) => ALL_CARDS.includes(c.id)), ...ALL_CARDS.filter((id) => !l.cards.some((c) => c.id === id)).map((id) => ({ id, visible: true }))]);
    } catch { /* default layout */ }
  }, [savedLayout]);
  const saveLayout = (next: typeof cards) => {
    setCards(next);
    void api(`/api/bots/${bot}/layout`, { method: "PUT", json: { cards: next } });
  };
  const c = useMemo(() => (ov.data ? combine(ov.data) : null), [ov.data]);
  const curve = useMemo(() => {
    if (!ov.data) return [];
    const from = Date.now() - RANGES[range];
    const pts = ov.data.length === 1 ? ov.data[0]!.equityCurve : ov.data.flatMap((b) => b.equityCurve);
    return pts.filter((p) => p.ts >= from || range === "all");
  }, [ov.data, range]);

  if (ov.isLoading || bots.isLoading) return <Loading />;
  if (ov.error) return <ErrorBox error={ov.error} />;
  if (!c || !ov.data) return <Empty>No data.</Empty>;
  const pf = c.gl > 0 ? (c.gp / c.gl).toFixed(2) : c.gp > 0 ? "∞" : "—";
  const kpi: Record<CardId, KpiItem> = {
    balance: { label: "Total balance", value: usd(c.total), sub: c.unlimited ? "Bot 2 tracks PnL from $0" : undefined },
    start: { label: "Start balance", value: usd(c.start) },
    net: { label: "Net PnL", value: usd(c.net, true), tone: c.net, sub: c.start ? pct((c.net / c.start) * 100) : undefined },
    unreal: { label: "Unrealized PnL", value: usd(c.unreal, true), tone: c.unreal },
    trades: { label: "Trades (W/L)", value: c.trades, sub: `${c.wins} W / ${c.losses} L` },
    win: { label: "Win rate", value: c.win == null ? "—" : `${c.win.toFixed(1)}%` },
    pf: { label: "Profit factor", value: pf },
    exp: { label: "Expectancy / trade", value: c.trades ? usd(c.net / c.trades, true) : "—", tone: c.trades ? c.net : null },
    dd: { label: "Max drawdown", value: usd(-c.dd), tone: -c.dd, sub: c.ddPct ? pct(-Number(c.ddPct)) : undefined },
    fees: { label: "Fees paid", value: usd(-c.fees), tone: -c.fees },
    funding: { label: "Funding paid", value: usd(-c.funding, true), tone: -c.funding },
    slip: { label: "Avg slippage", value: c.slip == null ? "—" : usd(c.slip, true, 4) },
    gap: { label: "Sim vs real gap", value: c.gap == null ? "—" : pct(c.gap, 4), sub: "Live only" },
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = cards.findIndex((x) => x.id === e.active.id);
    const to = cards.findIndex((x) => x.id === e.over!.id);
    saveLayout(arrayMove(cards, from, to));
  };
  const open = ov.data.flatMap((b) => b.open);
  return (
    <div className="space-y-6">
      <GetStarted />
      <div data-testid="headline" className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[40px] font-bold leading-none tracking-tight tabular">{usd(c.total)}</span>
        <span className={cx("text-lg font-semibold tabular", tone(c.net))}>{usd(c.net, true)}{c.start ? ` (${pct((c.net / c.start) * 100)})` : ""}</span>
        <span className="text-sm text-muted">Net PnL since start</span>
      </div>
      <Card title="Equity" action={<Segmented value={range} onChange={setRange} options={Object.keys(RANGES).map((k) => ({ value: k as keyof typeof RANGES, label: k }))} />}>
        {curve.length < 2 ? <Empty>The equity curve appears after the first closed trades.</Empty> : <EquityChart points={curve} />}
      </Card>
      <BotControls />
      <Card title={`Open positions (${open.length})`}>
        {open.length === 0 ? <Empty>No open positions.</Empty> : (
          <Table head={["Symbol", "Bot", "Venue", "Variant", "Entry", "Mark", "ROE", "Unrealized", "SL", "TP1", "Liq", "In trade", ""]}>
            {open.map((p) => (
              <tr key={p.tradeId}>
                <Td className="font-medium">{p.symbol}</Td><Td>{p.botId}</Td><Td>{p.exchange}</Td><Td>{p.variantId}</Td>
                <Td num>{price(p.entry)}</Td><Td num>{price(p.mark)}</Td><Td num><Signed v={p.roePct} fmt={(v) => pct(v)} /></Td>
                <Td num><Signed v={p.unrealized} fmt={(v) => usd(v, true)} /></Td>
                <Td num>{price(p.slPrice)} <span className="text-muted">({pct(p.slRoe, 0)})</span></Td>
                <Td num>{p.tp1Hit ? <span className="text-pos">hit</span> : price(p.tp1Price)}</Td><Td num>{price(p.liqPrice)}</Td>
                <Td>{dur((Date.now() - p.openedAt) / 1000)}</Td>
                <Td>
                  <ConfirmDialog
                    title={`Close ${p.symbol}?`}
                    body="The position is market-closed now on the exchange."
                    confirmLabel="Close position"
                    tone="danger"
                    onConfirm={() => api(`/api/trades/${p.tradeId}/close`, { method: "POST" })}
                    trigger={<Button size="sm" variant="ghost">Close</Button>}
                  />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewSelect />
        <div className="flex flex-wrap items-center gap-3">
          {ov.data.map((b) => <span key={b.botId} className="flex items-center gap-1.5 text-sm"><span className="text-muted">{b.name}</span><ModeBadge mode={b.mode} /><StatusBadge s={b.status} /></span>)}
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Customize"}</Button>
        </div>
      </div>
      {editing && (
        <div data-testid="customize" className="rounded-2xl border border-border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            {cards.map((x) => (
              <label key={x.id} className="flex items-center gap-1.5 rounded-lg bg-secondary px-2 py-1 text-xs">
                <input type="checkbox" className="accent-accent" checked={x.visible} onChange={() => saveLayout(cards.map((y) => (y.id === x.id ? { ...y, visible: !y.visible } : y)))} />{kpi[x.id].label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Drag rows to reorder. Layout is saved in the agent.</p>
        </div>
      )}
      <div data-testid="kpis">
        <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={cards.filter((x) => x.visible).map((x) => x.id)} strategy={verticalListSortingStrategy}>
            <List title="Statistics">
              {cards.filter((x) => x.visible).map((x) => <SortableRow key={x.id} id={x.id} k={kpi[x.id]} editing={editing} />)}
            </List>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
