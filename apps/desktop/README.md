# Trade Mate (desktop app)

Windows and macOS app around the **unchanged** OI Sniper agent and panel. Users install it like any app: no Node, no terminal, no pairing.

## How it works

```
Trade Mate (Electron)
├── shell view      sidebar, engine status, Updates / Support / About         src/renderer, src/preload
├── panel view      the existing OI Sniper panel at http://localhost:7777      (apps/panel, untouched)
└── engine          bundled Node runtime running apps/agent/dist/main.js       (apps/agent, untouched)
```

- The app starts the agent with `OISNIPER_NO_OPEN=1`, reads its "Pair this browser" link from the console and opens it in the panel view, so pairing is automatic. The token is never logged.
- The engine is restarted automatically if it stops (backs off, and gives up with an error screen after 5 crashes in 5 minutes).
- Closing the window keeps Trade Mate in the tray so bots keep running. **Quit** asks first and says how many positions are open.
- If another copy of OI Sniper (the zip version) already runs, Trade Mate shows that instead of starting a second engine on the same data.
- Data stays where the agent always keeps it: `%APPDATA%\oisniper` / `~/Library/Application Support/oisniper`. Installing, updating, rolling back and uninstalling never touch it.
- CoinGlass works as before: the agent opens the user's Chrome / Brave / Edge for the one-time login (panel → Health → Show browser).

## Commands (from the repo root)

```bash
pnpm desktop:dev
```
Builds the shell and runs it against `apps/agent/dist` + `apps/panel/out` (run `pnpm build` once first; uses your `node`).

```bash
pnpm desktop:dist
```
Builds everything and writes the installer for this computer to `apps/desktop/release/`.

Use `OISNIPER_DATA_DIR=<folder>` to try it on a throwaway data folder.

## Files

| Path | What |
|---|---|
| `src/main/agentSupervisor.ts` | starts / watches / stops the engine |
| `src/main/controller.ts` | window, tray, quit / update confirmations |
| `src/main/updates.ts` | update checks, version history, verified installer downloads (rollback) |
| `src/main/window.ts` | the two views, navigation rules |
| `src/main/pure/` | tested logic: pairing line, redaction, restart policy, URL rules, release list |
| `scripts/stage-agent.mjs` | puts Node + agent + panel + production deps into `staging/<os>-<arch>` |
| `electron-builder.yml` | installers (NSIS on Windows, dmg + zip on macOS) |

Releases: see [docs/RELEASING.md](../../docs/RELEASING.md).
