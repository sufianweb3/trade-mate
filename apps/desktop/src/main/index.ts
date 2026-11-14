import { app, Menu } from "electron";
import { Controller } from "./controller";
import { registerIpc } from "./ipc";
import { initLogging, log } from "./logger";

app.setName("Trade Mate");
if (process.platform === "win32") app.setAppUserModelId("com.sufianweb3.trademate");

// One Trade Mate per computer: a second launch only brings the first window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  initLogging();
  const controller = new Controller();
  app.on("second-instance", () => controller.show());
  app.on("activate", () => controller.show());
  app.on("window-all-closed", () => {
    /* keep running in the tray: bots manage positions only while the engine runs */
  });
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-attach-webview", (ev) => ev.preventDefault());
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(buildMenu(controller));
    registerIpc(controller);
    log.info("Trade Mate starting", { version: app.getVersion(), platform: process.platform, arch: process.arch });
    await controller.init(process.argv.includes("--hidden"));
  });
}

function buildMenu(c: Controller): Menu {
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: () => c.navigate("panel") },
        { label: "Updates", accelerator: "CmdOrCtrl+2", click: () => c.navigate("updates") },
        { label: "Support", accelerator: "CmdOrCtrl+3", click: () => c.navigate("support") },
        { type: "separator" },
        { label: "Reload dashboard", accelerator: "CmdOrCtrl+R", click: () => c.window?.reloadPanel() },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "About Trade Mate", click: () => c.navigate("about") }] },
  ]);
}
