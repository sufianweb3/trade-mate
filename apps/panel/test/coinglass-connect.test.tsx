import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let status: Record<string, unknown> = { phase: "idle", message: "", startedAt: null, finishedAt: null, missingColumns: [] };
const posts: string[] = [];
vi.mock("@/lib/agent", () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST") posts.push(path);
    if (path === "/api/scraper/connect" && init?.method === "POST")
      status = { phase: "waiting_login", message: "Log in to CoinGlass in the window that opened. It closes by itself once you are logged in.", startedAt: 1, finishedAt: null, missingColumns: [] };
    if (path === "/api/scraper/connect/cancel") status = { phase: "cancelled", message: "Cancelled.", startedAt: 1, finishedAt: 2, missingColumns: [] };
    return path.startsWith("/api/scraper/connect") ? status : {};
  }),
}));

import { CoinGlassConnect } from "@/components/coinglass-connect";

const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CoinGlassConnect /></QueryClientProvider>);

describe("CoinGlass one-click connect", () => {
  beforeEach(() => {
    posts.length = 0;
    status = { phase: "idle", message: "", startedAt: null, finishedAt: null, missingColumns: [] };
  });

  it("one click starts it and shows the step the user is on", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect CoinGlass" }));
    await screen.findByText(/Log in to CoinGlass in the window/);
    expect(posts).toContain("/api/scraper/connect");
    expect(screen.getByRole("button", { name: "Connecting…" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/You log in/).className).toContain("font-semibold");
  });

  it("can be cancelled", async () => {
    status = { phase: "waiting_login", message: "Log in…", startedAt: 1, finishedAt: null, missingColumns: [] };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeTruthy());
  });

  it("shows the outcome in words", async () => {
    status = { phase: "connected", message: "Connected. CoinGlass runs in the background.", startedAt: 1, finishedAt: 2, missingColumns: [] };
    mount();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect CoinGlass" })).toBeTruthy();
  });
});
