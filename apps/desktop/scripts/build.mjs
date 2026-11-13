/* global console */
// Bundles the desktop shell: main + preload (CommonJS for Electron) and the shell UI (browser IIFE).
// Everything is bundled, so the packaged app needs no node_modules.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-electron");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });
mkdirSync(join(out, "assets"), { recursive: true });

const common = { bundle: true, sourcemap: false, minify: false, legalComments: "none", logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "src/main/index.ts")], outfile: join(out, "main.cjs"), platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "src/preload/shell.ts")], outfile: join(out, "preload.cjs"), platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "src/renderer/app.ts")], outfile: join(out, "renderer/app.js"), platform: "browser", format: "iife", target: "chrome130" });

cpSync(join(root, "src/renderer/index.html"), join(out, "renderer/index.html"));
cpSync(join(root, "src/renderer/styles.css"), join(out, "renderer/styles.css"));
const icon = join(root, "build/icon.png");
if (!existsSync(icon)) throw new Error("build/icon.png is missing: run `pnpm --filter desktop icon`");
cpSync(icon, join(out, "assets/icon.png"));
console.log("desktop shell built ->", out);
