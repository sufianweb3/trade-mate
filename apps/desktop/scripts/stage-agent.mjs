/* global process, console, fetch, Buffer */
// Stages the unchanged OI Sniper agent for the installer:
//   staging/<os>-<arch>/runtime/node[.exe]     official Node runtime (same version as the build/tests), SHA-256 checked
//   staging/<os>-<arch>/app/main.js ...        apps/agent/dist (as built by `pnpm build`)
//   staging/<os>-<arch>/app/panel/             apps/panel/out
//   staging/<os>-<arch>/app/node_modules/      production deps for that platform, versions pinned to the tested ones
// electron-builder copies staging/${os}-${arch} to <resources>/agent.
//   node scripts/stage-agent.mjs                 -> this machine (win-x64, mac-arm64, ...)
//   node scripts/stage-agent.mjs mac-x64 mac-arm64
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..", "..");
const agentDir = join(repo, "apps", "agent");
const TARGETS = {
  "win-x64": { os: "win32", cpu: "x64", node: "win-x64", ext: "zip" },
  "mac-arm64": { os: "darwin", cpu: "arm64", node: "darwin-arm64", ext: "tar.gz" },
  "mac-x64": { os: "darwin", cpu: "x64", node: "darwin-x64", ext: "tar.gz" },
};
// Runtime deps of apps/agent/dist/main.js (what tsup leaves external), same list as scripts/package.mjs.
const DEPS = ["@fastify/static", "@fastify/websocket", "@napi-rs/keyring", "ccxt", "fastify", "fflate", "node-html-parser", "pino", "zod", "playwright"];
const NODE_VERSION = process.env.TRADE_MATE_NODE_VERSION ?? process.version;

const here = `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform}-${process.arch}`;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [here];
for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; use ${Object.keys(TARGETS).join(", ")}`);

const dist = join(agentDir, "dist", "main.js");
const panelOut = join(repo, "apps", "panel", "out", "index.html");
if (!existsSync(dist) || !existsSync(panelOut)) throw new Error("Run `pnpm build` at the repo root first (agent dist and panel out are missing).");

const cache = join(desktop, ".cache");
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
  const ex = join(cache, `x-${NODE_VERSION}-${t.node}`);
  const top = join(ex, `node-${NODE_VERSION}-${t.node}`);
  const need = t.os === "win32" ? ["node.exe", "LICENSE"] : ["bin/node", "LICENSE"];
  if (!need.every((f) => existsSync(join(top, f)))) {
    rmSync(ex, { recursive: true, force: true });
    mkdirSync(ex, { recursive: true });
    // Windows: the system bsdtar (handles .zip and drive letters); GNU tar from Git Bash reads "D:" as a remote host.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", archive, "-C", ex, ...need.map((f) => `node-${NODE_VERSION}-${t.node}/${f}`)], { stdio: "inherit" });
  }
  mkdirSync(outDir, { recursive: true });
  if (t.os === "win32") {
    cpSync(join(top, "node.exe"), join(outDir, "node.exe"));
    // App-local Microsoft C++ runtime so the OS keychain binding (@napi-rs/keyring) loads without a separate install.
    for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]) {
      const src = join(process.env.SystemRoot ?? "C:\\Windows", "System32", dll);
      if (process.platform === "win32" && existsSync(src)) cpSync(src, join(outDir, dll));
      else console.warn(`  note: ${dll} not bundled (build on Windows to include it)`);
    }
  } else cpSync(join(top, "bin", "node"), join(outDir, "node"));
  cpSync(join(top, "LICENSE"), join(outDir, "NODE-LICENSE.txt"));
}

function appFiles(t, appDir) {
  mkdirSync(appDir, { recursive: true });
  cpSync(join(agentDir, "dist"), appDir, { recursive: true });
  cpSync(join(repo, "apps", "panel", "out"), join(appDir, "panel"), { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "oisniper-app", private: true, type: "module", dependencies: deps }, null, 2));
  console.log(`  npm install (${t.os}/${t.cpu})`);
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", `--os=${t.os}`, `--cpu=${t.cpu}`], {
    cwd: appDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  for (const d of ["ccxt/dist", "ccxt/ts", "ccxt/python", "ccxt/php", "ccxt/cs", "ccxt/go"]) rmSync(join(appDir, "node_modules", d), { recursive: true, force: true });
  const prune = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) prune(p);
      else if (/\.(map|d\.ts|d\.cts|d\.mts|md)$/i.test(e.name) && !/^license/i.test(e.name)) rmSync(p);
    }
  };
  prune(join(appDir, "node_modules"));
}

for (const name of targets) {
  const t = TARGETS[name];
  const out = join(desktop, "staging", name);
  console.log(`staging agent for ${name} (Node ${NODE_VERSION})`);
  rmSync(out, { recursive: true, force: true });
  await nodeRuntime(t, join(out, "runtime"));
  appFiles(t, join(out, "app"));
  writeFileSync(join(out, "STAGED.json"), JSON.stringify({ target: name, node: NODE_VERSION, deps, at: new Date().toISOString() }, null, 2));
  console.log(`  -> ${out}`);
}
