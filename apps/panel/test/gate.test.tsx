import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push }) }));

// The agent is still starting: the panel shows its connecting screen, Shell is not mounted yet.
vi.mock("@/lib/agent", () => ({
  api: vi.fn(),
  connect: vi.fn(),
  useAgent: (sel?: (s: Record<string, unknown>) => unknown) => {
    const s = { state: "connecting", error: null, agentUrl: "http://localhost:7777", setUrl: vi.fn(), setToken: vi.fn() };
    return sel ? sel(s) : s;
  },
}));

import { Providers } from "@/components/shell";

describe("desktop bridge before the agent is connected", () => {
  it("is registered and remembered while the panel is still connecting", async () => {
    window.history.replaceState(null, "", "/?embed=desktop");
    sessionStorage.clear();
    render(<Providers><p>page</p></Providers>);
    const w = window as unknown as { __tradeMateNavigate?: (r: string) => void };
    await waitFor(() => expect(typeof w.__tradeMateNavigate).toBe("function"));
    expect(sessionStorage.getItem("trademate.embed")).toBe("desktop");
    w.__tradeMateNavigate!("/signals/");
    expect(push).toHaveBeenCalledWith("/signals/");
  });
});
