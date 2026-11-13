"use client";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BotControls, ViewSelect } from "@/components/bot-controls";
import { EquityChart } from "@/components/equity-chart";
import { GetStarted } from "@/components/get-started";
import { useView } from "@/lib/view";
import { Button, Card, Empty, ErrorBox, Kpi, Loading, ModeBadge, Segmented, Signed, StatusBadge, Table, Td } from "@/components/ui";
import { api } from "@/lib/agent";
import { dur, n, pct, price, usd } from "@/lib/format";
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

function SortableCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">{children}</div>;
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
  const content: Record<CardId, ReactNode> = {
    balance: <Kpi label="Total balance" value={usd(c.total)} sub={c.unlimited ? "Bot 2 tracks PnL from $0" : undefined} />,
    start: <Kpi label="Start balance" value={usd(c.start)} />,
    net: <Kpi label="Net PnL" value={usd(c.net, true)} valueTone={c.net} sub={c.start ? pct((c.net / c.start) * 100) : undefined} />,
    unreal: <Kpi label="Unrealized PnL" value={usd(c.unreal, true)} valueTone={c.unreal} />,
    trades: <Kpi label="Trades (W/L)" value={c.trades} sub={`${c.wins} W / ${c.losses} L`} />,
    win: <Kpi label="Win rate" value={c.win == null ? "—" : `${c.win.toFixed(1)}%`} />,
    pf: <Kpi label="Profit factor" value={pf} />,
    exp: <Kpi label="Expectancy / trade" value={c.trades ? usd(c.net / c.trades, true) : "—"} valueTone={c.trades ? c.net : null} />,
    dd: <Kpi label="Max drawdown" value={usd(-c.dd)} valueTone={-c.dd} sub={c.ddPct ? pct(-Number(c.ddPct)) : undefined} />,
    fees: <Kpi label="Fees paid" value={usd(-c.fees)} valueTone={-c.fees} />,
    funding: <Kpi label="Funding paid" value={usd(-c.funding, true)} valueTone={-c.funding} />,
    slip: <Kpi label="Avg slippage" value={c.slip == null ? "—" : usd(c.slip, true, 4)} />,
    gap: <Kpi label="Sim vs real gap" value={c.gap == null ? "—" : pct(c.gap, 4)} sub="Live only" />,
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
      <BotControls />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewSelect />
        <div className="flex items-center gap-3">
          {ov.data.map((b) => <span key={b.botId} className="flex items-center gap-1.5 text-sm"><span className="text-muted">{b.name}</span><ModeBadge mode={b.mode} /><StatusBadge s={b.status} /></span>)}
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Customize"}</Button>
        </div>
      </div>
      {editing && (
        <Card title="Cards" className="!p-4">
          <div className="flex flex-wrap gap-2">
            {cards.map((x) => (
              <label key={x.id} className="flex items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-xs">
                <input type="checkbox" checked={x.visible} onChange={() => saveLayout(cards.map((y) => (y.id === x.id ? { ...y, visible: !y.visible } : y)))} />{x.id}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Drag cards to reorder. Layout is saved in the agent.</p>
        </Card>
      )}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={cards.filter((x) => x.visible).map((x) => x.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {cards.filter((x) => x.visible).map((x) => <SortableCard key={x.id} id={x.id}>{content[x.id]}</SortableCard>)}
          </div>
        </SortableContext>
      </DndContext>
      <Card title="Equity" action={<Segmented value={range} onChange={setRange} options={Object.keys(RANGES).map((k) => ({ value: k as keyof typeof RANGES, label: k }))} />}>
        {curve.length < 2 ? <Empty>The equity curve appears after the first closed trades.</Empty> : <EquityChart points={curve} />}
      </Card>
      <Card title={`Open positions (${open.length})`}>
        {open.length === 0 ? <Empty>No open positions.</Empty> : (
          <Table head={["Symbol", "Bot", "Venue", "Variant", "Entry", "Mark", "ROE", "Unrealized", "SL", "TP1", "Liq", "In trade", ""]}>
            {open.map((p) => (
              <tr key={p.tradeId}>
                <Td className="font-medium">{p.symbol}</Td><Td>{p.botId}</Td><Td>{p.exchange}</Td><Td>{p.variantId}</Td>
                <Td>{price(p.entry)}</Td><Td>{price(p.mark)}</Td><Td><Signed v={p.roePct} fmt={(v) => pct(v)} /></Td>
                <Td><Signed v={p.unrealized} fmt={(v) => usd(v, true)} /></Td>
                <Td>{price(p.slPrice)} <span className="text-muted">({pct(p.slRoe, 0)})</span></Td>
                <Td>{p.tp1Hit ? <span className="text-pos">hit</span> : price(p.tp1Price)}</Td><Td>{price(p.liqPrice)}</Td>
                <Td>{dur((Date.now() - p.openedAt) / 1000)}</Td>
                <Td><Button size="sm" variant="ghost" onClick={() => void api(`/api/trades/${p.tradeId}/close`, { method: "POST" })}>Close</Button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
