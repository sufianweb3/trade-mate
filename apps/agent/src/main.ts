import { EXCHANGES } from "@oisniper/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "./app";
import { buildServer } from "./api/server";
import { log } from "./log";
import { installProcessGuard } from "./processGuard";
import { CcxtHub } from "./market/ccxtHub";
import { ExchangeDataSource } from "./exchangeData/source";
import { dataPaths } from "./paths";
import { CoinGlassSource } from "./scraper/coinglass";
import { systemClock } from "./util/clock";

const WORDS = "amber anchor apple arrow aspen atlas basil beacon birch blaze cedar cliff cloud comet coral delta drift ember falcon fern fjord flint frost glade harbor hazel iris jade juniper kelp lagoon lark lotus maple meadow mesa mint nova oak onyx orbit otter pearl pine plume quartz raven reef ridge river sage sierra slate solar spruce stone tide timber topaz tulip vale willow".split(" ");

/** 6 words derived from the token so the user can confirm the panel paired with the right agent. */
export function pairingPhrase(token: string): string {
  const h = createHash("sha256").update(token).digest();
  return Array.from({ length: 6 }, (_, i) => WORDS[h[i]! % WORDS.length]).join("-");
}

export function findPanelDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [process.env.OISNIPER_PANEL_DIR, join(here, "panel"), resolve(here, "../../panel/out"), resolve(here, "../../../apps/panel/out")])
    if (c && existsSync(join(c, "index.html"))) return c;
  return null;
}

function openBrowser(url: string) {
  if (process.env.OISNIPER_NO_OPEN) return;
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

async function main() {
  let appRef: App | null = null;
  installProcessGuard(() => appRef);
  const port = Number(process.env.OISNIPER_PORT ?? 7777);
  const paths = dataPaths();
  let getUrl = () => "https://www.coinglass.com/";
  let getPages = () => 3;
  let universe = () => 100;
  const hub = new CcxtHub([...EXCHANGES], systemClock);
  const app = new App({
    dbFile: paths.db,
    clock: systemClock,
    hub,
    exchangeSource: new ExchangeDataSource(hub, { universeSize: () => universe(), now: () => Date.now() }),
    source: new CoinGlassSource({ url: () => getUrl(), profileDir: paths.browserProfile, pages: () => getPages() }),
    dataDir: paths.root,
  });
  appRef = app;
  getUrl = () => app.store.getSetting("coinglass_url", "https://www.coinglass.com/");
  getPages = () => app.store.getSetting("coinglass_pages", 3);
  universe = () => app.store.getSetting("exchange_universe", 100);
  await app.start();
  const server = await buildServer(app, {
    port,
    panelDir: findPanelDir(),
    allowedOrigins: (process.env.OISNIPER_PANEL_ORIGIN ?? "https://oisniper.vercel.app").split(","),
  });
  await server.listen({ host: "127.0.0.1", port });
  const token = app.token();
  const panel = process.env.OISNIPER_PANEL_URL ?? `http://localhost:${port}`;
  // Console only (never the pino log file): the pairing link is how the user's browser gets the local token.
  console.log(`\n  OI Sniper agent on http://127.0.0.1:${port}\n  Pairing phrase: ${pairingPhrase(token)}\n  Pair this browser: ${panel}/#pair=${encodeURIComponent(token)}\n`);
  openBrowser(`${panel}/#pair=${encodeURIComponent(token)}`);
  const shutdown = async () => {
    log.info("shutting down");
    await server.close();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    log.error({ err: (e as Error).message }, "agent failed to start");
    process.exit(1);
  });
}
