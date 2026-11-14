import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/get-started", () => ({ GetStarted: () => null }));
vi.mock("@/components/equity-chart", () => ({ EquityChart: () => <div>chart</div> }));
vi.mock("@/components/bot-controls", () => ({ BotControls: () => <div>bots</div>, ViewSelect: () => null }));

const calls: { path: string; init?: { method?: string; json?: unknown } }[] = [];
let overview: unknown = null;
let failOverview = false;
vi.mock("@/lib/agent", () => ({
  api: vi.fn(async (path: string, init?: { method?: string; json?: unknown }) => {
    calls.push({ path, init });
    if (path.startsWith("/api/overview")) {
      if (failOverview) throw new Error("agent unreachable");
      return overview;
    }
    if (path === "/api/bots") return [{ id: "paper", layout: null }];
    return { ok: true };
  }),
}));

import Overview from "@/app/page";

const kpis = { netPnl: "12.4", trades: 24, wins: 14, grossProfit: "40", grossLoss: "27.6", fees: "3.1", funding: "0.4", maxDrawdown: "9", maxDrawdownPct: "1.8", avgSlippageUsd: "0.02", avgSimGapPct: null };
const bot = (open: unknown[] = []) => ({
  botId: "paper", name: "Paper", mode: "paper", status: "running", startBalance: "500", totalBalance: "512.4", unrealized: "-1.8", unlimited: false,
  kpis, equityCurve: [], open,
});
const position = { tradeId: "trd_1", symbol: "SOL", botId: "paper", exchange: "binance", variantId: "5x", entry: "200", mark: "199", roePct: "-2.5", unrealized: "-1.8", slPrice: "196", slRoe: "-10", tp1Hit: false, tp1Price: "201", liqPrice: "160", openedAt: Date.now() - 60_000 };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Overview /></QueryClientProvider>);
}

describe("Overview", () => {
  beforeEach(() => {
    calls.length = 0;
    failOverview = false;
    overview = [bot([position])];
  });

  it("headline shows total balance and Net PnL with sign", async () => {
    mount();
    const head = await screen.findByTestId("headline");
    expect(head.textContent).toContain("$512.40");
    expect(head.textContent).toContain("+$12.40");
    expect(head.textContent).toContain("+2.48%");
  });

  it("closing a position asks first, then calls the close API", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(calls.some((c) => c.path === "/api/trades/trd_1/close")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Close position" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/trades/trd_1/close" && c.init?.method === "POST")).toBe(true));
  });

  it("Customize lists all 13 KPIs; hiding one removes it and saves the layout", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
    const box = screen.getByTestId("customize");
    expect(within(box).getAllByRole("checkbox")).toHaveLength(13);
    expect(screen.getAllByText("Profit factor").length).toBeGreaterThan(0);
    fireEvent.click(within(box).getByRole("checkbox", { name: "Profit factor" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/bots/paper/layout" && c.init?.method === "PUT")).toBe(true));
    expect(within(screen.getByTestId("kpis")).queryByText("Profit factor")).toBeNull();
  });

  it("shows the error state when the agent fails", async () => {
    failOverview = true;
    mount();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("shows the empty open-positions state", async () => {
    overview = [bot([])];
    mount();
    expect(await screen.findByText("No open positions.")).toBeTruthy();
  });
});
