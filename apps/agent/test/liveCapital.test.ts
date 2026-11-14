import { BOT1_PRESET, D, type BotConfig } from "@oisniper/core";
import { describe, expect, it } from "vitest";
import { makeAdapterFactory } from "../src/execution/factory";
import type { LiveAccounts } from "../src/execution/liveAccounts";
import type { MarketHub } from "../src/market/types";
import type { RunRow, Store } from "../src/store/store";
import type { Clock } from "../src/util/clock";

/** Store with one live bot whose current settings version the test can swap, as saveConfig does. */
function fakeStore(initial: BotConfig) {
  let cfg = initial;
  const store = {
    getBot: () => ({ id: "real", current_version_id: "v" }),
    getVersion: () => ({ id: "v", config: cfg }),
  } as unknown as Store;
  return { store, save: (c: BotConfig) => (cfg = c) };
}
const clock = { now: () => 0, setInterval: () => () => undefined } as unknown as Clock;
const live = (maxCapital: string | null): BotConfig => ({ ...BOT1_PRESET, mode: "live", risk: { ...BOT1_PRESET.risk, maxCapital } });

describe("Real max capital", () => {
  it("follows the bot's current settings, not the value at load", async () => {
    const { store, save } = fakeStore(live(null));
    const factory = makeAdapterFactory({ store, hub: {} as MarketHub, clock, accounts: {} as LiveAccounts });
    const adapter = factory("real", live(null), { id: "run" } as RunRow);
    expect((await adapter.available())!.toString()).toBe("0");

    save(live("300")); // user raises max capital in Real Trade Settings
    expect((await adapter.available())!.toString()).toBe("300");
    expect((await adapter.walletBalance())!.toString()).toBe("300");

    save(live("100")); // and lowers it again: the lower limit applies at once
    expect((await adapter.available())!.eq(D(100))).toBe(true);
    await adapter.close();
  });
});
