import { D, Decimal, HUNDRED, ZERO } from "./decimal";

export interface ClosedTradeLike {
  netPnl: string;
  fees: string;
  funding: string;
  slippageUsd: string | null;
  exitTime: number;
  simGapPct?: string | null;
}

export interface EquityPoint {
  t: number;
  equity: string;
}

export interface Kpis {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: string | null;
  netPnl: string;
  netPnlPct: string | null;
  grossProfit: string;
  grossLoss: string;
  profitFactor: string | null;
  expectancy: string | null;
  fees: string;
  funding: string;
  avgSlippageUsd: string | null;
  maxDrawdown: string;
  maxDrawdownPct: string | null;
  avgSimGapPct: string | null;
}

export function equityCurve(trades: ClosedTradeLike[], start: Decimal): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let eq = start;
  const out: EquityPoint[] = [];
  for (const t of sorted) {
    eq = eq.add(t.netPnl);
    out.push({ t: t.exitTime, equity: eq.toString() });
  }
  return out;
}

export function maxDrawdown(start: Decimal, curve: EquityPoint[]): { abs: Decimal; pct: Decimal | null } {
  let peak = start;
  let maxAbs = ZERO;
  let maxPct: Decimal | null = null;
  for (const p of curve) {
    const e = D(p.equity);
    if (e.gt(peak)) peak = e;
    const dd = peak.sub(e);
    if (dd.gt(maxAbs)) maxAbs = dd;
    if (peak.gt(0)) {
      const pc = dd.div(peak).mul(HUNDRED);
      if (maxPct == null || pc.gt(maxPct)) maxPct = pc;
    }
  }
  return { abs: maxAbs, pct: maxPct };
}

export function computeKpis(trades: ClosedTradeLike[], startBalance: Decimal | null): Kpis {
  let net = ZERO;
  let gp = ZERO;
  let gl = ZERO;
  let fees = ZERO;
  let funding = ZERO;
  let slip = ZERO;
  let slipN = 0;
  let gap = ZERO;
  let gapN = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    const n = D(t.netPnl);
    net = net.add(n);
    if (n.gt(0)) {
      wins++;
      gp = gp.add(n);
    } else {
      losses++;
      gl = gl.add(n.abs());
    }
    fees = fees.add(t.fees);
    funding = funding.add(t.funding);
    if (t.slippageUsd != null) {
      slip = slip.add(t.slippageUsd);
      slipN++;
    }
    if (t.simGapPct != null) {
      gap = gap.add(t.simGapPct);
      gapN++;
    }
  }
  const start = startBalance ?? ZERO;
  const curve = equityCurve(trades, start);
  const dd = maxDrawdown(start, curve);
  const n = trades.length;
  return {
    trades: n,
    wins,
    losses,
    winRatePct: n ? D(wins).div(n).mul(HUNDRED).toFixed(2) : null,
    netPnl: net.toFixed(4),
    netPnlPct: startBalance && startBalance.gt(0) ? net.div(startBalance).mul(HUNDRED).toFixed(2) : null,
    grossProfit: gp.toFixed(4),
    grossLoss: gl.toFixed(4),
    profitFactor: gl.gt(0) ? gp.div(gl).toFixed(3) : gp.gt(0) ? "Infinity" : null,
    expectancy: n ? net.div(n).toFixed(4) : null,
    fees: fees.toFixed(4),
    funding: funding.toFixed(4),
    avgSlippageUsd: slipN ? slip.div(slipN).toFixed(4) : null,
    maxDrawdown: dd.abs.toFixed(4),
    maxDrawdownPct: startBalance && startBalance.gt(0) && dd.pct ? dd.pct.toFixed(2) : null,
    avgSimGapPct: gapN ? gap.div(gapN).toFixed(5) : null,
  };
}
