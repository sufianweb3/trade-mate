import { describe, expect, it } from "vitest";
import { parsePairUrl, redactLine, tokenFromPairUrl } from "../src/main/pure/agentOutput";
import { RestartPolicy } from "../src/main/pure/restartPolicy";
import { isAgentUrl, isSafeExternalUrl } from "../src/main/pure/urlGuard";
import { sha512FromMetadata, toVersionList } from "../src/main/pure/releases";

describe("agent output", () => {
  const line = "  Pair this browser: http://localhost:7777/#pair=abc%2Bdef123";

  it("finds the pairing URL for the expected local port only", () => {
    expect(parsePairUrl(line, 7777)).toBe("http://localhost:7777/#pair=abc%2Bdef123");
    expect(parsePairUrl(line, 7778)).toBeNull();
    expect(parsePairUrl("  Pair this browser: https://evil.example/#pair=abc", 7777)).toBeNull();
    expect(parsePairUrl("  Pair this browser: http://localhost:7777/", 7777)).toBeNull();
    expect(parsePairUrl("  Pair this browser: http://localhost:7777/#pair=", 7777)).toBeNull();
    expect(parsePairUrl("OI Sniper agent on http://127.0.0.1:7777", 7777)).toBeNull();
  });

  it("decodes the token", () => {
    expect(tokenFromPairUrl("http://localhost:7777/#pair=abc%2Bdef123")).toBe("abc+def123");
  });

  it("never lets a token or pairing phrase reach a log line", () => {
    expect(redactLine(line)).not.toContain("abc");
    expect(redactLine("  Pairing phrase: amber-oak-river-tide-sage-mint")).toBe("  Pairing phrase: [redacted]");
    expect(redactLine('{"pairToken":"s3cr3t"}')).not.toContain("s3cr3t");
    expect(redactLine("authorization: Bearer s3cr3t.tok")).not.toContain("s3cr3t");
    expect(redactLine("trade opened BTC/USDT")).toBe("trade opened BTC/USDT");
  });
});

describe("restart policy", () => {
  it("backs off and gives up after repeated crashes inside the window", () => {
    const p = new RestartPolicy([1, 2, 3], 1_000, 3);
    expect(p.recordCrash(0)).toEqual({ kind: "restart", delayMs: 1 });
    expect(p.recordCrash(10)).toEqual({ kind: "restart", delayMs: 2 });
    expect(p.recordCrash(20)).toEqual({ kind: "restart", delayMs: 3 });
    expect(p.recordCrash(30)).toEqual({ kind: "give_up", crashes: 4 });
  });

  it("forgets crashes outside the window and after a manual reset", () => {
    const p = new RestartPolicy([1, 2, 3], 1_000, 2);
    p.recordCrash(0);
    p.recordCrash(10);
    expect(p.recordCrash(5_000)).toEqual({ kind: "restart", delayMs: 1 });
    p.recordCrash(5_001);
    p.reset();
    expect(p.recordCrash(5_002)).toEqual({ kind: "restart", delayMs: 1 });
  });
});

describe("url guard", () => {
  it("allows only the local agent in the panel view", () => {
    expect(isAgentUrl("http://localhost:7777/signals/", 7777)).toBe(true);
    expect(isAgentUrl("http://127.0.0.1:7777/", 7777)).toBe(true);
    expect(isAgentUrl("http://localhost:3000/", 7777)).toBe(false);
    expect(isAgentUrl("https://localhost:7777/", 7777)).toBe(false);
    expect(isAgentUrl("http://localhost.evil.com:7777/", 7777)).toBe(false);
    expect(isAgentUrl("not a url", 7777)).toBe(false);
  });

  it("opens only plain https links externally", () => {
    expect(isSafeExternalUrl("https://www.coinglass.com/")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(false);
    expect(isSafeExternalUrl("file:///C:/Windows")).toBe(false);
    expect(isSafeExternalUrl("https://user:pw@example.com")).toBe(false);
  });
});

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/x/${name}`, size: 1 });
const rel = (tag: string, prerelease: boolean, draft = false, names = [`Trade-Mate-Setup-${tag.slice(1)}.exe`, "latest.yml", `Trade-Mate-${tag.slice(1)}-arm64.dmg`]) => ({
  tag_name: tag,
  name: null,
  body: `notes ${tag}`,
  draft,
  prerelease,
  published_at: "2026-11-13T00:00:00Z",
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  assets: names.map(asset),
});

describe("version history", () => {
  const raw = [rel("v0.1.0", false), rel("v0.3.0", true), rel("v0.2.0", false), rel("v0.4.0", false, true), rel("junk", false)];

  it("stable channel hides drafts and betas, newest first, marks current and newer", () => {
    const list = toVersionList(raw, "0.1.0", "stable", "win32", "x64");
    expect(list.map((v) => v.version)).toEqual(["0.2.0", "0.1.0"]);
    expect(list[0]).toMatchObject({ isNewer: true, isCurrent: false, channel: "stable" });
    expect(list[1]).toMatchObject({ isNewer: false, isCurrent: true });
    expect(list[0]!.installer?.name).toBe("Trade-Mate-Setup-0.2.0.exe");
    expect(list[0]!.metadata?.name).toBe("latest.yml");
  });

  it("beta channel includes pre-releases; the running beta is listed even on stable", () => {
    expect(toVersionList(raw, "0.1.0", "beta", "win32", "x64").map((v) => v.version)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
    expect(toVersionList(raw, "0.3.0", "stable", "win32", "x64").map((v) => v.version)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
  });

  it("picks the installer for the running platform and arch", () => {
    const mac = toVersionList(raw, "0.1.0", "stable", "darwin", "arm64");
    expect(mac[0]!.installer?.name).toBe("Trade-Mate-0.2.0-arm64.dmg");
    expect(toVersionList(raw, "0.1.0", "stable", "darwin", "x64")[0]!.installer).toBeNull();
  });

  it("rejects malformed API data", () => {
    expect(() => toVersionList([{ tag_name: 1 }], "0.1.0", "stable", "win32", "x64")).toThrow();
  });
});

describe("installer checksum metadata", () => {
  const yml = [
    "version: 0.2.0",
    "files:",
    "  - url: Trade-Mate-Setup-0.2.0.exe",
    "    sha512: AAAbbb==",
    "    size: 123",
    "  - url: 'Trade-Mate-0.2.0-arm64.dmg'",
    "    sha512: 'CCCddd=='",
    "path: Trade-Mate-Setup-0.2.0.exe",
    "sha512: AAAbbb==",
  ].join("\n");

  it("finds the SHA-512 for a listed file only", () => {
    expect(sha512FromMetadata(yml, "Trade-Mate-Setup-0.2.0.exe")).toBe("AAAbbb==");
    expect(sha512FromMetadata(yml, "Trade-Mate-0.2.0-arm64.dmg")).toBe("CCCddd==");
    expect(sha512FromMetadata(yml, "other.exe")).toBeNull();
  });
});
