import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyHeader, parseTable, parseValue, tableFromHtml } from "../src/scraper/parser";

const fx = (n: string) => tableFromHtml(readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), "utf8"));

describe("CoinGlass parser (header-mapped, never by index)", () => {
  it("parses the normal fixture", () => {
    const r = parseTable(fx("coinglass-normal"), null);
    expect(r.health.status).toBe("OK");
    expect(r.rows).toHaveLength(3);
    const sol = r.rows.find((x) => x.symbol === "SOL")!;
    expect(sol.price).toBe(182.5);
    expect(sol.oi_value).toBe(4.12e9);
    expect(sol.oi_chg_5m).toBe(3.2);
    expect(sol.oi_chg_1h).toBe(6.3);
    expect(sol.vol_chg_1h).toBe(86);
    expect(sol.funding_rate).toBe(0.0125);
    expect(sol.ls_ratio).toBe(1.11);
    expect(r.rows.find((x) => x.symbol === "BTC")!.price).toBe(98250.1);
  });

  it("missing cells and unknown timeframes are null, never 0", () => {
    const r = parseTable(fx("coinglass-normal"), null);
    const pepe = r.rows.find((x) => x.symbol === "PEPE")!;
    expect(pepe.price_chg_15m).toBeNull();
    expect(pepe.oi_chg_15m).toBeNull();
    expect(pepe.funding_rate).toBeNull();
    expect(pepe.price_chg_5m).toBe(-0.05); // unicode minus
    expect(pepe.vol_chg_5m).toBeNull(); // column not on the page
  });

  it("reordered columns give identical values", () => {
    const a = parseTable(fx("coinglass-normal"), null).rows.find((x) => x.symbol === "SOL")!;
    const b = parseTable(fx("coinglass-reordered"), null).rows.find((x) => x.symbol === "SOL")!;
    for (const k of ["price", "oi_value", "oi_chg_5m", "oi_chg_1h", "vol_chg_1h", "price_chg_5m", "funding_rate", "ls_ratio"] as const) expect(b[k]).toBe(a[k]);
  });

  it("missing required column -> DEGRADED with the column named", () => {
    const r = parseTable(fx("coinglass-missing"), null);
    expect(r.health.status).toBe("DEGRADED");
    expect(r.health.missingColumns).toContain("oi_chg_5m");
    expect(r.rows.every((x) => x.oi_chg_5m === null)).toBe(true);
  });

  it("rule groups: a member CoinGlass does not show (vol 5m change) is fine while the group can still pass", () => {
    const req = ["price", "oi_chg_5m"] as const;
    // the old behaviour: vol_chg_5m as a plain required rule degrades the whole source
    expect(parseTable(fx("coinglass-normal"), null, Date.now(), [...req, "vol_chg_5m"]).health.missingColumns).toEqual(["vol_chg_5m"]);
    // in a "1 of [5m, 1h]" group: 1h has data -> OK
    const ok = parseTable(fx("coinglass-normal"), null, Date.now(), [...req], [{ metrics: ["vol_chg_5m", "vol_chg_1h"], minPass: 1 }]);
    expect(ok.health.status).toBe("OK");
    // a group that cannot reach its minimum still degrades and names the absent metric
    const short = parseTable(fx("coinglass-normal"), null, Date.now(), [...req], [{ metrics: ["vol_chg_5m", "vol_chg_1h"], minPass: 2 }]);
    expect(short.health.status).toBe("DEGRADED");
    expect(short.health.missingColumns).toEqual(["vol_chg_5m"]);
  });

  it("row count drop > 50% -> DEGRADED", () => {
    expect(parseTable(fx("coinglass-normal"), 10).health.status).toBe("DEGRADED");
  });

  it("header and value parsing", () => {
    expect(classifyHeader("OI Change (5m)")).toBe("oi_chg_5m");
    expect(classifyHeader("Open Interest Chg 4H")).toBe("oi_chg_4h");
    expect(classifyHeader("Volume Change(24h)")).toBe("vol_chg_24h");
    expect(classifyHeader("Volume(1h)")).toBe("vol_1h");
    expect(classifyHeader("Price 24h%")).toBe("price_chg_24h");
    expect(classifyHeader("Something else")).toBeNull();
    // real coinglass.com homepage headers (Nov 2026)
    expect(classifyHeader("Assets")).toBe("symbol");
    expect(classifyHeader("Volume (24h)")).toBe("vol_24h");
    expect(classifyHeader("Volume (24h%)")).toBe("vol_chg_24h");
    expect(classifyHeader("OI")).toBe("oi_value");
    expect(classifyHeader("OI (1h%)")).toBe("oi_chg_1h");
    expect(classifyHeader("Price (24h%)")).toBe("price_chg_24h");
    expect(classifyHeader("Ranking")).toBeNull();
    expect(parseValue("$1.23B")).toBe(1.23e9);
    expect(parseValue("-0.34%")).toBe(-0.34);
    expect(parseValue("--")).toBeNull();
    expect(parseValue("")).toBeNull();
    expect(parseValue("N/A")).toBeNull();
  });
});
