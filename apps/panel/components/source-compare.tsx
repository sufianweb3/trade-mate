"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/agent";
import { pct } from "@/lib/format";
import { Card, Empty, Kpi, Signed, Table, Td } from "./ui";

interface Stats { signals: number; traded: number; shadow: number; cfWinRatePct: number | null; cfDone: number; avgRoePct: number | null; avgRoeBasis: string | null }
interface Compare {
  tradesOn: string;
  coinglass: Stats;
  exchange: Stats;
  overlap: { pairs: number; pct: number | null };
  lead: { avgSec: number | null; exchangeFirst: number; coinglassFirst: number; same: number };
  recentPairs: { symbol: string; leadSec: number }[];
}

/** CoinGlass vs Exchange for one bot: both sources are always collected, the other one as shadow signals. */
export function SourceCompare({ bot }: { bot: string }) {
  const q = useQuery({ queryKey: ["compare", bot], queryFn: () => api<Compare>(`/api/analytics/sources?bot=${bot}`), refetchInterval: 60_000 });
  const c = q.data;
  const row = (name: string, s: Stats | undefined, traded: boolean) => (
    <tr key={name}>
      <Td className="font-medium">{name}{traded && <span className="ml-1 text-xs text-accent">trading</span>}</Td>
      <Td>{s?.signals ?? 0}</Td><Td>{s?.traded ?? 0}</Td><Td>{s?.shadow ?? 0}</Td>
      <Td>{s?.cfWinRatePct == null ? "—" : `${s.cfWinRatePct}%`} <span className="text-xs text-muted">({s?.cfDone ?? 0} done)</span></Td>
      <Td><Signed v={s?.avgRoePct} fmt={(v) => pct(v, 1)} /> <span className="text-xs text-muted">{s?.avgRoeBasis ?? ""}</span></Td>
    </tr>
  );
  return (
    <Card title="CoinGlass vs Exchange" action={<span className="text-xs text-muted">Win rate and ROE from each signal&apos;s +4h counterfactual (TP1 before SL), real trades when available</span>}>
      {!c || (c.coinglass.signals === 0 && c.exchange.signals === 0) ? (
        <Empty>No signals yet from either source for this bot.</Empty>
      ) : (
        <div className="space-y-4">
          <Table head={["Source", "Signals", "Traded", "Shadow", "Win rate", "Avg ROE"]}>
            {row("CoinGlass", c.coinglass, c.tradesOn === "coinglass")}
            {row("Exchange", c.exchange, c.tradesOn === "exchange")}
          </Table>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Overlap" value={c.overlap.pct == null ? "—" : `${c.overlap.pct}%`} sub={`${c.overlap.pairs} symbol pairs within 15 min`} />
            <Kpi label="Avg lead" value={c.lead.avgSec == null ? "—" : `${Math.abs(c.lead.avgSec)} s`} sub={c.lead.avgSec == null ? "" : c.lead.avgSec > 0 ? "Exchange fired first" : c.lead.avgSec < 0 ? "CoinGlass fired first" : "same time"} />
            <Kpi label="Exchange first" value={c.lead.exchangeFirst} />
            <Kpi label="CoinGlass first" value={c.lead.coinglassFirst} />
          </div>
        </div>
      )}
    </Card>
  );
}
