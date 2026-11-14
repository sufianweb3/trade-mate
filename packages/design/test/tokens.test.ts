import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "tokens.css"), "utf8");

/** The three theme blocks: light (:root), dark by system preference, dark by data-theme. */
function blocks(): Record<"light" | "darkSystem" | "darkForced", Record<string, string>> {
  const body = (re: RegExp) => {
    const m = re.exec(css);
    if (!m) throw new Error(`block not found: ${re}`);
    return Object.fromEntries([...m[1]!.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]));
  };
  return {
    light: body(/^:root\s*\{([^}]*)\}/m),
    darkSystem: body(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/),
    darkForced: body(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
  };
}

const NAMES = [
  "bg", "surface", "elevated", "line", "fg", "muted", "accent", "pos", "neg", "warn", "live", "paper",
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
  "secondary", "secondary-foreground", "border", "input", "ring", "destructive", "destructive-foreground",
];

const rgb = (v: string) => v.split(/\s+/).map(Number) as [number, number, number];
const lum = ([r, g, b]: number[]) => {
  const c = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c(r!) + 0.7152 * c(g!) + 0.0722 * c(b!);
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("design tokens", () => {
  it("every theme block defines the same token names", () => {
    const b = blocks();
    for (const t of [b.light, b.darkSystem, b.darkForced]) for (const n of NAMES) expect(t, n).toHaveProperty(n);
    expect(Object.keys(b.darkSystem).sort()).toEqual(Object.keys(b.darkForced).sort());
    expect(b.darkSystem).toEqual(b.darkForced);
  });

  it("light background is #F3FAF6 and dark background #141617", () => {
    const b = blocks();
    expect(b.light.bg).toBe("243 250 246");
    expect(b.darkForced.bg).toBe("20 22 23");
    expect(b.light.surface).toBe("255 255 255");
    expect(b.darkForced.surface).toBe("28 31 33");
  });

  it("text contrast meets AA in both themes", () => {
    for (const [name, t] of Object.entries({ light: blocks().light, dark: blocks().darkForced })) {
      expect(contrast(t.fg!, t.bg!), `${name} fg/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted!, t.bg!), `${name} muted/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.fg!, t.surface!), `${name} fg/surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.pos!, t.surface!), `${name} pos/surface`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.neg!, t.surface!), `${name} neg/surface`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.accent!, t.bg!), `${name} accent/bg`).toBeGreaterThanOrEqual(3);
    }
  });

  /** A colour mixed over the background at `alpha` (how bg-accent/12 tints render). */
  const tint = (c: string, bg: string, alpha: number) =>
    rgb(c).map((x, i) => Math.round(x * alpha + rgb(bg)[i]! * (1 - alpha))).join(" ");

  it("accent is readable as text, also on its own 12% tint (active nav item)", () => {
    for (const [name, t] of Object.entries({ light: blocks().light, dark: blocks().darkForced })) {
      expect(contrast(t.accent!, t.bg!), `${name} accent text/bg`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent!, tint(t.accent!, t.bg!, 0.12)), `${name} accent on accent/12`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("white text on the live colour (live banner, live badge) is readable in both themes", () => {
    for (const [name, t] of Object.entries({ light: blocks().light, dark: blocks().darkForced })) {
      expect(contrast("255 255 255", t.live!), `${name} white/live`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
