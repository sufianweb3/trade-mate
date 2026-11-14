import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { path: string; init?: { method?: string; json?: Record<string, unknown> } }[] = [];
vi.mock("@/lib/agent", () => ({
  ApiError: class ApiError extends Error {},
  useAgent: () => ({ agentUrl: "http://localhost:7777", token: "abcd1234wxyz", setUrl: vi.fn(), setToken: vi.fn() }),
  api: vi.fn(async (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
    calls.push({ path, init });
    if (path === "/api/real/readiness")
      return { ready: false, exchanges: [{ exchange: "binance", ready: false, items: [
        { id: "key", label: "Key connected", ok: true, detail: "AbCd••••wxyz" },
        { id: "testnet", label: "Testnet pass recorded", ok: false, detail: "run pnpm test:testnet" },
      ] }] };
    if (path === "/api/exchanges")
      return [{ exchange: "binance", markets: 895, health: { status: "ok", rttMs: 200, clockOffsetMs: -20, wsConnected: true, subscriptions: 2 }, key: null, needsPassphrase: false, testnetAvailable: true }];
    if (path === "/api/settings") return { scrapeIntervalMs: 30000, coinglassUrl: "https://www.coinglass.com/", warmSetSize: 20, theme: "system", dataDir: null, symbolOverrides: [] };
    if (path.endsWith("/keys")) return { status: "connected", reason: null, warnings: [] };
    return {};
  }),
}));
vi.mock("@/components/trade-settings", () => ({ TradeSettings: () => null }));

import { RealReadiness } from "@/components/readiness";
import Exchanges from "@/app/exchanges/page";
import Settings from "@/app/settings/page";

function mount(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Real readiness", () => {
  beforeEach(() => { calls.length = 0; });

  it("says OK / Missing in words, not by colour alone", async () => {
    mount(<RealReadiness />);
    expect(await screen.findByText("OK")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
  });

  it("asks before changing account settings, then prepares", async () => {
    mount(<RealReadiness />);
    fireEvent.click(await screen.findByRole("button", { name: "Check & prepare" }));
    expect(calls.some((c) => c.path.endsWith("/prepare"))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Set and check" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/exchanges/binance/prepare" && c.init?.method === "POST")).toBe(true));
  });
});

describe("Exchange key form", () => {
  beforeEach(() => { calls.length = 0; });

  it("sends the key as before and clears the secret after saving", async () => {
    mount(<Exchanges />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect key" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k-123" } });
    fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "s-456" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate and save" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/exchanges/binance/keys")).toBe(true));
    const sent = calls.find((c) => c.path === "/api/exchanges/binance/keys")!.init!.json!;
    expect(sent).toMatchObject({ apiKey: "k-123", secret: "s-456", testnet: true, confirmNoWithdraw: false });
    await waitFor(() => expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe(""));
  });
});

describe("Settings appearance", () => {
  beforeEach(() => { calls.length = 0; localStorage.clear(); delete document.documentElement.dataset.theme; });

  it("Dark stores the choice and switches the page", async () => {
    mount(<Settings />);
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem("oisniper.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("the exchange picker is a labelled select", async () => {
    mount(<Settings />);
    expect(await screen.findByRole("combobox", { name: "Exchange" })).toBeTruthy();
  });
});
