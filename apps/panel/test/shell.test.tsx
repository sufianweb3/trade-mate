import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

let state = { killSwitch: false, liveRunning: false, scraper: { status: "OK" }, exchangeData: { status: "OK" } };
vi.mock("@/lib/agent", () => ({
  api: vi.fn(async (path: string) => (path === "/api/state" ? state : path === "/api/bots" ? [] : {})),
  connect: vi.fn(),
  useAgent: (sel?: (s: { state: string }) => unknown) => (sel ? sel({ state: "connected" }) : { state: "connected" }),
}));

import { isEmbedded } from "@/lib/embed";
import { Shell } from "@/components/shell";

function mount(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  sessionStorage.clear();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Shell><p>page</p></Shell></QueryClientProvider>);
}

describe("isEmbedded", () => {
  it("is true only for the desktop marker", () => {
    expect(isEmbedded("?embed=desktop", null)).toBe(true);
    expect(isEmbedded("", "desktop")).toBe(true);
    expect(isEmbedded("", null)).toBe(false);
    expect(isEmbedded("?embed=other", null)).toBe(false);
  });
});

describe("Shell", () => {
  beforeEach(() => {
    push.mockReset();
    pathname = "/";
    state = { killSwitch: false, liveRunning: false, scraper: { status: "OK" }, exchangeData: { status: "OK" } };
  });

  it("renders kill switch once in embedded mode, without a navigation bar", async () => {
    mount("?embed=desktop");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /kill switch/i })).toHaveLength(1));
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  });

  it("renders kill switch once in the browser, outside a links-only navigation bar", async () => {
    mount("");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /kill switch/i })).toHaveLength(1));
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("link")).toHaveLength(7);
    expect(within(nav).queryByRole("button", { name: /kill switch/i })).toBeNull();
  });

  it("shows the live and kill-switch banners once, in sentence case", async () => {
    state = { ...state, liveRunning: true, killSwitch: true };
    mount("?embed=desktop");
    const live = await screen.findAllByText(/live trading active/i);
    const kill = await screen.findAllByText(/kill switch engaged/i);
    expect(live).toHaveLength(1);
    expect(kill).toHaveLength(1);
    expect(live[0]!.className).not.toContain("uppercase");
  });

  it("navigate hook goes to panel pages and ignores unknown routes", async () => {
    mount("?embed=desktop");
    await waitFor(() => expect(typeof (window as unknown as { __tradeMateNavigate?: unknown }).__tradeMateNavigate).toBe("function"));
    const nav = (window as unknown as { __tradeMateNavigate: (r: string) => void }).__tradeMateNavigate;
    nav("/evil");
    expect(push).not.toHaveBeenCalled();
    nav("/signals/");
    expect(push).toHaveBeenCalledWith("/signals/");
  });
});
