import { describe, expect, it, vi } from "vitest";
import { ConnectFlow, LOGIN_TIMEOUT_MS, type ConnectDeps } from "../src/scraper/coinglassConnect";
import { launchFreeingProfile } from "../src/scraper/profileLock";

/** Fake browser: scripted login readings, a clock that advances on sleep. */
function fake(readings: (boolean | null)[], over: Partial<ConnectDeps> = {}) {
  let t = 0;
  let i = 0;
  const calls: string[] = [];
  let open = false;
  const d: ConnectDeps = {
    openVisible: async () => {
      calls.push("visible");
      open = true;
    },
    toBackground: async () => {
      calls.push("background");
      open = false;
    },
    windowOpen: () => open,
    loginState: async () => readings[Math.min(i++, readings.length - 1)] ?? null,
    configureColumns: async () => {
      calls.push("columns");
      return [];
    },
    verifyBackground: async () => true,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    ...over,
  };
  return { d, calls, close: () => (open = false) };
}

describe("CoinGlass one-click connect", () => {
  it("opens a window, waits for two logged-in readings, sets columns, goes back to hidden: connected", async () => {
    const f = fake([null, false, true, true]);
    const flow = new ConnectFlow(f.d);
    expect(flow.start().phase).toBe("opening");
    await flow.settled();
    expect(flow.status.phase).toBe("connected");
    expect(f.calls).toEqual(["visible", "columns", "background"]);
    expect(flow.status.finishedAt).not.toBeNull();
  });

  it("a single logged-in reading (half-loaded page) is not enough", async () => {
    const f = fake([true, null, false, false]);
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("failed");
    expect(flow.status.message).toMatch(/10 minutes/);
    expect(f.calls).toEqual(["visible", "background"]);
  });

  it("times out after 10 minutes and returns to the hidden browser", async () => {
    const f = fake([false]);
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("failed");
    expect(f.d.now()).toBeGreaterThan(LOGIN_TIMEOUT_MS);
    expect(f.calls.at(-1)).toBe("background");
  });

  it("user closes the window: cancelled, hidden browser restarted", async () => {
    const f = fake([false]);
    const sleep = f.d.sleep;
    f.d.sleep = async (ms) => {
      await sleep(ms);
      f.close();
    };
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("cancelled");
    expect(f.calls).toEqual(["visible", "background"]);
  });

  it("cancel button stops the wait", async () => {
    const f = fake([false]);
    const flow = new ConnectFlow(f.d);
    const sleep = f.d.sleep;
    f.d.sleep = async (ms) => {
      await sleep(ms);
      flow.cancel();
    };
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("cancelled");
  });

  it("window cannot open: failed with a plain message and scraping stays hidden", async () => {
    const f = fake([true], { openVisible: async () => Promise.reject(new Error("spawn failed\nstack")) });
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("failed");
    expect(flow.status.message).toContain("spawn failed");
    expect(flow.status.message).not.toContain("stack");
    expect(f.calls).toEqual(["background"]);
  });

  it("missing columns after setup: connected with a warning listing them", async () => {
    const f = fake([true, true], { configureColumns: async () => ["oi_chg_30m"] });
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("warning");
    expect(flow.status.missingColumns).toEqual(["oi_chg_30m"]);
  });

  it("login not visible to the hidden browser: failed, not connected", async () => {
    const f = fake([true, true], { verifyBackground: async () => false });
    const flow = new ConnectFlow(f.d);
    flow.start();
    await flow.settled();
    expect(flow.status.phase).toBe("failed");
  });

  it("a second click while running does not start a second flow", async () => {
    const f = fake([true, true]);
    const flow = new ConnectFlow(f.d);
    flow.start();
    flow.start();
    await flow.settled();
    expect(f.calls.filter((c) => c === "visible")).toHaveLength(1);
  });
});

describe("launch on a profile still held by a closing browser", () => {
  it("frees the profile and retries", async () => {
    let n = 0;
    const free = vi.fn(async () => 2);
    const r = await launchFreeingProfile(
      async () => {
        if (n++ < 2) throw new Error("Opening in existing browser session. This usually means that the profile is already in use");
        return "ctx";
      },
      free,
      async () => undefined,
    );
    expect(r).toBe("ctx");
    expect(free).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const free = vi.fn(async () => 0);
    await expect(launchFreeingProfile(async () => Promise.reject(new Error("Executable doesn't exist")), free, async () => undefined)).rejects.toThrow("Executable");
    expect(free).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt", async () => {
    const free = vi.fn(async () => 0);
    await expect(launchFreeingProfile(async () => Promise.reject(new Error("profile is already in use")), free, async () => undefined, 3)).rejects.toThrow("already in use");
    expect(free).toHaveBeenCalledTimes(2);
  });
});
