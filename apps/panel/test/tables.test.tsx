import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/bot-controls", () => ({ ViewSelect: () => null, useRunParam: () => "" }));
vi.mock("@/components/export-button", () => ({ ExportButton: () => null }));

const paths: string[] = [];
let trades: unknown[] = [];
let signals: unknown[] = [];
vi.mock("@/lib/agent", () => ({
  api: vi.fn(async (path: string) => {
    paths.push(path);
    if (path.startsWith("/api/trades?")) return trades;
    if (path.startsWith("/api/trades/")) return { trade: trades[0], events: [] };
    if (path.startsWith("/api/signals?")) return signals;
    if (path.includes("/cooldowns")) return [];
    return {};
  }),
}));

import History from "@/app/history/page";
import Signals from "@/app/signals/page";

const trade = {
  trade_id: "trd_1", bot_id: "paper", symbol: "SOL", exchange: "binance", variant_id: "5x", mode: "paper", status: "closed",
  timing: { entry_fill_time: Date.now(), hold_seconds: 120, signal_to_fill_ms: 900 },
  config: { fitted: false, leverage: 5, margin: "40", notional: "200", sl_price: "196", tp1_price: "201", liq_price: "160" },
  execution: { avg_entry_price: "200", fill_pct: "100", slippage_pct: "0.01", latency_ms: 300 },
  exit: { reason: "SL", legs: [] }, result: { net_pnl: "-4.2", net_roe_pct: "-10.5", fees: "0.2", funding: "0", r_multiple: null },
  path: { mfe_pct: "0.1", mae_pct: "-2", peak_roe: "0.5" }, after_exit: { chg_15m: null, chg_1h: null, chg_4h: null },
};
const signal = {
  signal_id: "sig_1", ts: Date.now(), bot_id: "paper", symbol: "PEPE", status: "rejected", exchange: null,
  metrics: { oi_chg_5m: "4.2", oi_chg_1h: "12", vol_chg_1h: "30", price_chg_5m: "1.1", price_chg_1h: "-0.4" },
  reject_reasons: ["GATE_SPREAD", "GATE_DEPTH"], opened_trades: 0, rematch_count: 0,
};

function mount(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("History", () => {
  beforeEach(() => { paths.length = 0; trades = [trade]; });

  it("a losing trade shows a minus sign in red, right-aligned", async () => {
    mount(<History />);
    const pnl = await screen.findByText(/^[−-]\$4\.20$/);
    expect(pnl.className).toContain("text-neg");
    expect(pnl.closest("td")!.className).toContain("text-right");
  });

  it("sends the same query as before", async () => {
    mount(<History />);
    await screen.findByText("SOL");
    expect(paths).toContain("/api/trades?limit=500&bot=paper");
  });

  it("opens the trade detail from the keyboard", async () => {
    mount(<History />);
    const row = (await screen.findByText("SOL")).closest("tr")!;
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Execution")).toBeTruthy());
  });

  it("shows the empty state", async () => {
    trades = [];
    mount(<History />);
    expect(await screen.findByText("No trades match.")).toBeTruthy();
  });
});

describe("Signals", () => {
  beforeEach(() => { paths.length = 0; signals = [signal]; });

  it("a rejected signal shows its reason codes", async () => {
    mount(<Signals />);
    expect(await screen.findByText(/GATE_SPREAD, GATE_DEPTH/)).toBeTruthy();
  });

  it("metric cells are right-aligned and keep their sign", async () => {
    mount(<Signals />);
    const neg = await screen.findByText(/^[−-]0\.40%$/);
    expect(neg.className).toContain("text-neg");
    expect(neg.closest("td")!.className).toContain("text-right");
  });

  it("sends the same query as before", async () => {
    mount(<Signals />);
    await screen.findByText("PEPE");
    expect(paths).toContain("/api/signals?limit=300&bot=paper");
  });

  it("shows the empty state", async () => {
    signals = [];
    mount(<Signals />);
    expect(await screen.findByText(/No signals yet/)).toBeTruthy();
  });
});
