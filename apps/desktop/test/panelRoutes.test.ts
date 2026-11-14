import { describe, expect, it } from "vitest";
import { navigateScript, nextRoute, routeFor, viewForUrl } from "../src/main/pure/panelRoutes";
import { parseSettings } from "../src/main/pure/settingsSchema";

describe("panel routes", () => {
  it("maps panel URLs to sidebar items", () => {
    expect(viewForUrl("http://localhost:7777/", 7777)).toBe("overview");
    expect(viewForUrl("http://localhost:7777/history/", 7777)).toBe("history");
    expect(viewForUrl("http://localhost:7777/history/?run=x", 7777)).toBe("history");
    expect(viewForUrl("http://127.0.0.1:7777/signals/abc", 7777)).toBe("signals");
    expect(viewForUrl("http://localhost:7777/?embed=desktop", 7777)).toBe("overview");
    expect(viewForUrl("http://localhost:7778/history/", 7777)).toBeNull();
    expect(viewForUrl("https://evil.example/history/", 7777)).toBeNull();
    expect(viewForUrl("http://localhost:7777/unknown/", 7777)).toBeNull();
  });

  it("gives each sidebar item its route", () => {
    expect(routeFor("overview")).toBe("/");
    expect(routeFor("health")).toBe("/health/");
  });

  it("the navigate script keeps desktop mode when it has to fall back to a full load", () => {
    const js = navigateScript("signals");
    expect(js).toContain('window.__tradeMateNavigate("/signals/")');
    expect(js).toContain('location.assign("/signals/?embed=desktop")');
  });

  it("pending route is applied on ready", () => {
    expect(nextRoute("signals", "overview")).toBe("signals");
    expect(nextRoute(null, "history")).toBe("history");
    expect(nextRoute(null, null)).toBe("overview");
  });
});

describe("settings schema", () => {
  it("defaults appearance to system and rejects unknown values", () => {
    expect(parseSettings({}).appearance).toBe("system");
    expect(parseSettings({ appearance: "neon" }).appearance).toBe("system");
    expect(parseSettings({ appearance: "dark" }).appearance).toBe("dark");
    expect(parseSettings({ channel: "beta", launchAtLogin: true }).channel).toBe("beta");
    expect(parseSettings("garbage").channel).toBe("stable");
  });
});
