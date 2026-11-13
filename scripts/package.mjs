/* global process, console, fetch, Buffer */
// Builds ready-to-run zips for people who are not technical: no Node, pnpm or other installs needed.
//   pnpm build && node scripts/package.mjs              -> release/OI-Sniper-windows.zip, -mac-apple-silicon.zip, -mac-intel.zip
//   node scripts/package.mjs win-x64                     -> one target
// Each zip: runtime/ (official Node, SHA-256 verified), app/ (agent bundle + panel + production node_modules for that
// platform), a double-click launcher and READ ME FIRST.txt. Nothing user-specific (data, keys, .env) is ever included.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(root, "apps", "agent");
// fflate is an agent dependency (pnpm does not hoist it to the root)
const { zipSync } = createRequire(join(agentDir, "package.json"))("fflate");
const TARGETS = {
  "win-x64": { os: "win32", cpu: "x64", node: "win-x64", ext: "zip", zipName: "OI-Sniper-windows" },
  "mac-arm64": { os: "darwin", cpu: "arm64", node: "darwin-arm64", ext: "tar.gz", zipName: "OI-Sniper-mac-apple-silicon" },
  "mac-x64": { os: "darwin", cpu: "x64", node: "darwin-x64", ext: "tar.gz", zipName: "OI-Sniper-mac-intel" },
};
// Runtime deps of dist/main.js (everything tsup leaves external). Versions are pinned to what the tests ran with.
const DEPS = ["@fastify/static", "@fastify/websocket", "@napi-rs/keyring", "ccxt", "fastify", "fflate", "node-html-parser", "pino", "zod", "playwright"];
const NODE_VERSION = process.version; // ship the runtime the test suite and live runs used

const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; use ${Object.keys(TARGETS).join(", ")}`);

const dist = join(agentDir, "dist", "main.js");
const panelOut = join(root, "apps", "panel", "out", "index.html");
if (!existsSync(dist) || !existsSync(panelOut)) throw new Error("Run `pnpm build` first (agent dist and panel out are missing).");

const releaseDir = join(root, "release");
const cache = join(releaseDir, "cache");
mkdirSync(cache, { recursive: true });

const installed = (name) => JSON.parse(readFileSync(join(agentDir, "node_modules", name, "package.json"), "utf8")).version;
const deps = Object.fromEntries(DEPS.map((d) => [d, installed(d)]));

async function download(url, file) {
  if (existsSync(file)) return;
  console.log(`  downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

async function nodeRuntime(t, outDir) {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const name = `node-${NODE_VERSION}-${t.node}.${t.ext}`;
  const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  await download(`${base}/SHASUMS256.txt`, sums);
  const archive = join(cache, name);
  await download(`${base}/${name}`, archive);
  const want = readFileSync(sums, "utf8").split("\n").find((l) => l.trim().endsWith(`  ${name}`))?.split(/\s+/)[0];
  const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (!want || want !== got) {
    rmSync(archive);
    throw new Error(`checksum mismatch for ${name} (expected ${want}, got ${got}); download removed`);
  }
  const ex = join(cache, `x-${t.node}`);
  const top = join(ex, `node-${NODE_VERSION}-${t.node}`);
  const need = t.os === "win32" ? ["node.exe", "LICENSE"] : ["bin/node", "LICENSE"];
  if (!need.every((f) => existsSync(join(top, f)))) {
    rmSync(ex, { recursive: true, force: true });
    mkdirSync(ex, { recursive: true });
    // Only the files we ship: the macOS archive also holds symlinks (bin/npm) that Windows tar cannot create.
    execFileSync("tar", ["-xf", archive, "-C", ex, ...need.map((f) => `node-${NODE_VERSION}-${t.node}/${f}`)], { stdio: "inherit" });
  }
  mkdirSync(outDir, { recursive: true });
  if (t.os === "win32") {
    cpSync(join(top, "node.exe"), join(outDir, "node.exe"));
    // App-local Microsoft C++ runtime (redistributable) so the OS keychain binding loads without an installer.
    for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]) {
      const src = join(process.env.SystemRoot ?? "C:\\Windows", "System32", dll);
      if (process.platform === "win32" && existsSync(src)) cpSync(src, join(outDir, dll));
      else console.warn(`  note: ${dll} not found; Windows users may need the VC++ 2015-2022 Redistributable for Real mode keys`);
    }
  } else cpSync(join(top, "bin", "node"), join(outDir, "node"));
  cpSync(join(top, "LICENSE"), join(outDir, "NODE-LICENSE.txt"));
}

function appFiles(t, appDir) {
  mkdirSync(appDir, { recursive: true });
  cpSync(join(agentDir, "dist"), appDir, { recursive: true });
  cpSync(join(root, "apps", "panel", "out"), join(appDir, "panel"), { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "oisniper-app", private: true, type: "module", dependencies: deps }, null, 2));
  console.log(`  npm install (${t.os}/${t.cpu})`);
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", `--os=${t.os}`, `--cpu=${t.cpu}`], {
    cwd: appDir, stdio: "inherit", shell: process.platform === "win32",
  });
  // Trim what never runs in Node: browser bundles, TypeScript sources, maps, declaration files.
  const prune = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) prune(p);
      else if (/\.(map|d\.ts|d\.cts|d\.mts|md)$/i.test(e.name) && !/^license/i.test(e.name)) rmSync(p);
    }
  };
  for (const d of ["ccxt/dist", "ccxt/ts", "ccxt/python", "ccxt/php", "ccxt/cs", "ccxt/go"]) rmSync(join(appDir, "node_modules", d), { recursive: true, force: true });
  prune(join(appDir, "node_modules"));
}

const README = (mac) => `OI SNIPER - READ ME FIRST
==========================

You do not need to install anything. Everything the bot needs is inside this folder.
The only file you ever double-click is "Start OI Sniper". Leave the "system" folder as it is.

START
${mac
  ? `1. Move this folder somewhere permanent (for example your Documents folder).
2. Double-click "Start OI Sniper.command".
   The first time, macOS may say it cannot verify the developer:
     open System Settings > Privacy & Security, scroll down, click "Open Anyway", then confirm.
   (Or right-click the file > Open > Open.) You only do this once.
3. A Terminal window opens (leave it open) and your browser opens the OI Sniper panel.`
  : `1. Move this folder somewhere permanent (for example Documents). Do not run it from inside the zip.
2. Double-click "Start OI Sniper".
   If Windows shows "Windows protected your PC", click "More info" then "Run anyway". Only the first time.
3. A black window opens (leave it open) and your browser opens the OI Sniper panel.`}

FIRST TIME IN THE PANEL
- Signal data: either log in to CoinGlass once (Health > Show browser, needs Brave or Google Chrome), or
  open Settings > Paper Trade Settings > Signal Data Source and choose "Exchange" (no account needed).
- Check your strategy in Settings, then press Start on the Overview page for Paper and/or Test.

STOP
- Close the ${mac ? "Terminal" : "black"} window. Bots are always Stopped after the next start; press Start again.

KEEP IN MIND
- The bot only runs while this computer is on and awake.
- Your data stays on this computer${mac ? " (~/Library/Application Support/oisniper)" : " (%APPDATA%\\oisniper)"}.
- Real-money trading is not enabled in this version.

UPDATE TO A NEW VERSION
- Close the window, replace this folder with the new one. Your data and settings are kept.
`;

const WIN_LAUNCHER = `@echo off
title OI Sniper - keep this window open
rem Everything except this launcher and the readme lives in "system" so users see one thing to double-click.
cd /d "%~dp0system"
curl -s -o nul -m 2 http://127.0.0.1:7777/health && (
  echo OI Sniper is already running. Opening the panel...
  start "" http://localhost:7777
  timeout /t 3 >nul
  exit /b
)
rem The app ships packed (app.tgz) so the zip has ~10 files: Windows' built-in unzip is slow and fragile with thousands.
rem Unpack on first start and after an update (app.version changed).
if not exist "app\\.version" goto unpack
fc /b "app.version" "app\\.version" >nul 2>&1 || goto unpack
goto run
:unpack
echo Preparing OI Sniper (first start or new version). This takes about 30 seconds...
if exist "app" rmdir /s /q "app"
tar -xzf "app.tgz"
if errorlevel 1 (
  echo.
  echo Could not unpack app.tgz. Move the "OI Sniper" folder to Documents and try again.
  pause
  exit /b 1
)
copy /y "app.version" "app\\.version" >nul
:run
echo Starting OI Sniper. Your browser will open in a few seconds.
echo Keep this window open while the bot runs. Close it to stop.
echo.
"runtime\\node.exe" --disable-warning=ExperimentalWarning "app\\main.js"
echo.
echo OI Sniper stopped. If this was unexpected, take a screenshot of this window.
pause
`;

const MAC_LAUNCHER = `#!/bin/bash
cd "$(dirname "$0")"
# Files from a downloaded zip carry Apple's quarantine flag; clear it inside this folder so the bundled runtime loads.
xattr -dr com.apple.quarantine . 2>/dev/null
# Everything except this launcher and the readme lives in "system" so users see one thing to double-click.
cd system
if curl -s -o /dev/null -m 2 http://127.0.0.1:7777/health; then
  echo "OI Sniper is already running. Opening the panel..."
  open http://localhost:7777
  exit 0
fi
# The app ships packed (app.tgz); unpack on first start and after an update (app.version changed).
if [ ! -f app/.version ] || ! cmp -s app.version app/.version; then
  echo "Preparing OI Sniper (first start or new version). This takes about 30 seconds..."
  rm -rf app
  if ! tar -xzf app.tgz; then
    echo "Could not unpack app.tgz. Move the OI Sniper folder to Documents and try again."
    read -n 1 -s -r -p "Press any key to close."
    exit 1
  fi
  cp app.version app/.version
  xattr -dr com.apple.quarantine app 2>/dev/null
fi
echo "Starting OI Sniper. Your browser will open in a few seconds."
echo "Keep this window open while the bot runs. Close it to stop."
echo
./runtime/node --disable-warning=ExperimentalWarning app/main.js
echo
echo "OI Sniper stopped. If this was unexpected, take a screenshot of this window."
read -n 1 -s -r -p "Press any key to close."
`;

function zipDir(dir, out, top, executables, unix) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = `${top}/${relative(dir, p).split("\\").join("/")}`;
        const exec = executables.some((x) => rel.endsWith(x)) || /\.node$/.test(rel);
        const level = /\.tgz$/.test(rel) ? 0 : /\.(node|exe|dll)$|\/node$/.test(rel) ? 9 : 6;
        // Mac: os 3 = unix keeps the executable bit (Archive Utility honours it). Windows: plain DOS entries.
        files[rel] = [readFileSync(p), unix ? { level, os: 3, attrs: ((exec ? 0o100755 : 0o100644) << 16) >>> 0 } : { level }];
      }
    }
  };
  walk(dir);
  writeFileSync(out, zipSync(files));
}

for (const name of targets) {
  const t = TARGETS[name];
  console.log(`\n== ${name}`);
  const stage = join(releaseDir, "build", name, "OI Sniper");
  rmSync(join(releaseDir, "build", name), { recursive: true, force: true });
  const sys = join(stage, "system");
  await nodeRuntime(t, join(sys, "runtime"));
  appFiles(t, join(sys, "app"));
  // One archive instead of ~3,600 files (see launcher); app.version tells the launcher when to re-unpack.
  execFileSync("tar", ["-czf", "app.tgz", "app"], { cwd: sys, stdio: "inherit" });
  rmSync(join(sys, "app"), { recursive: true, force: true });
  writeFileSync(join(sys, "app.version"), `${NODE_VERSION} ${createHash("sha256").update(readFileSync(join(sys, "app.tgz"))).digest("hex").slice(0, 16)}\n`);
  const mac = t.os === "darwin";
  writeFileSync(join(stage, "READ ME FIRST.txt"), mac ? README(true) : README(false).replace(/\n/g, "\r\n"));
  if (mac) writeFileSync(join(stage, "Start OI Sniper.command"), MAC_LAUNCHER);
  else writeFileSync(join(stage, "Start OI Sniper.cmd"), WIN_LAUNCHER.replace(/\n/g, "\r\n"));
  const out = join(releaseDir, `${t.zipName}.zip`);
  zipDir(stage, out, "OI Sniper", ["Start OI Sniper.command", "system/runtime/node"], mac);
  console.log(`  -> ${relative(root, out)} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
}
