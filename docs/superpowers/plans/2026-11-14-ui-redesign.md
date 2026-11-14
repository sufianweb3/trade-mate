# Trade Mate UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Trade Mate frame and every OI Sniper panel page in the approved "Pro lists" Apple style (mint white / charcoal), move the seven panel pages into the Trade Mate sidebar, and swap the panel's hand-made components for shadcn/ui, without changing any feature, number or API call.

**Architecture:** One token file (`packages/design/tokens.css`) feeds Tailwind in the panel and plain CSS in the desktop frame. The panel keeps its exported component API in `components/ui.tsx` but implements it on shadcn/ui, gains an "embedded" mode (no top bar, a navigate hook for the desktop), and a shared page header. The desktop frame drives the panel view's route from its sidebar and follows its in-page navigation.

**Tech Stack:** Next.js 15 static export, React 19, Tailwind 3, shadcn/ui (Radix, lucide-react), Electron 44, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-ui-redesign-design.md`

## Global Constraints

- No change to features, numbers, API calls, trading logic, `apps/agent` or `packages/core`.
- Tailwind tokens only in components; no hard-coded hex outside `packages/design/tokens.css`.
- Light: background `#F3FAF6`, surfaces white, accent `#1F9D74`. Dark: background `#141617`, surfaces `#1C1F21` / `#24282A`, accent `#5FD3A6`. Red only for losses, Live and kill switch. Text contrast WCAG AA (4.5:1 body, 3:1 large).
- Every figure: tabular numbers, +/− sign and colour as today.
- No `transition: all`; no animating width/height/top/left; `:focus-visible` on every control; `prefers-reduced-motion` fallback; transitions ≤ 200 ms; no data-update animation.
- No labels in tracked capitals; status dots only where they carry state; no card inside a card.
- States kept on every page: loading, empty, error, agent disconnected, live banner, kill-switch banner.
- Static export and the browser / Vercel panel keep working with a navigation bar.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass after every task.

## Review Focus

- Kill switch, live banner and kill-switch banner appear exactly once in both embedded and browser mode → test in Task 3 (`renders kill switch once`).
- A sidebar click while the engine is starting opens that page once it is ready (not Overview) → test in Task 6 (`pending route is applied on ready`).
- In-page links (e.g. Overview → History) move the sidebar highlight → test in Task 6 (`viewForUrl`).
- Theme: Appearance "dark" with panel theme "system" renders the panel dark; panel theme "light" still wins for the panel → test in Task 6 (`nativeTheme source`) and Task 1 (token blocks for `data-theme`).
- Negative values keep red and the minus sign after the restyle → test in Task 2 (`Signed keeps sign and tone`).

## File Structure

- `packages/design/` (new): `package.json`, `tokens.css` (all tokens, both themes), `test/tokens.test.ts`.
- `apps/panel/components/ui/*.tsx` (new, shadcn generated): button, card, badge, switch, toggle-group, input, table, alert-dialog, tooltip, select, separator.
- `apps/panel/components/ui.tsx` (rewrite): same exports as today, built on the shadcn parts.
- `apps/panel/lib/embed.ts` (new): embedded-mode detection and the desktop navigate hook.
- `apps/panel/components/page-header.tsx` (new): title, view switch, source status, kill switch.
- `apps/panel/components/shell.tsx` (modify): nav bar only in browser mode, banners, header.
- `apps/panel/app/**/page.tsx` (modify): layouts per direction B.
- `apps/desktop/src/main/pure/panelRoutes.ts` (new): route ↔ sidebar item mapping.
- `apps/desktop/src/shared/types.ts`, `main/window.ts`, `main/controller.ts`, `main/settings.ts`, `renderer/*` (modify).

---

### Task 1: Shared design tokens

**Files:**
- Create: `packages/design/package.json` (name `@trademate/design`, private, `exports: { "./tokens.css": "./tokens.css" }`), `packages/design/tokens.css`, `packages/design/test/tokens.test.ts`, `packages/design/vitest.config.ts`
- Modify: `vitest.config.ts` (add `"packages/design"` to `projects`), `apps/panel/app/globals.css` (replace the three token blocks with `@import "@trademate/design/tokens.css";`), `apps/panel/package.json` (dependency `"@trademate/design": "workspace:*"`), `apps/panel/tailwind.config.ts` (add shadcn colour names: `background, foreground, card, popover, primary, secondary, border, input, ring, destructive` mapped to the tokens; keep existing names)

**Interfaces:**
- Produces: CSS custom properties as `r g b` triples: `--bg --surface --elevated --line --fg --muted --accent --pos --neg --warn --live --paper` plus shadcn aliases `--background --foreground --card --card-foreground --popover --popover-foreground --primary --primary-foreground --secondary --secondary-foreground --border --input --ring --destructive --destructive-foreground` and `--radius: 12px`. Three blocks: `:root` (light), `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, `:root[data-theme="dark"]`.

- [ ] **Step 1: Write the failing test** `packages/design/test/tokens.test.ts`
  - `every theme block defines the same token names` (parse the three blocks with a regex on `--name:`; sets equal, includes all names above)
  - `light background is #F3FAF6 and dark background #141617` (`--bg: 243 250 246`, `--bg: 20 22 23`)
  - `text contrast meets AA` (compute WCAG contrast from the triples: `fg/bg ≥ 4.5`, `muted/bg ≥ 4.5`, `fg/surface ≥ 4.5`, `pos/surface ≥ 3`, `neg/surface ≥ 3`, `accent/bg ≥ 3` in both themes)
- [ ] **Step 2: Run** `pnpm vitest run --project design` → FAIL (file missing)
- [ ] **Step 3: Write `tokens.css`** with the spec colours; tune `muted`, `pos`, `neg` only as far as the contrast test needs.
- [ ] **Step 4: Run** the test → PASS; `pnpm --filter panel build` → succeeds and the current UI shows mint / charcoal.
- [ ] **Step 5: Commit** `feat(design): mint white / charcoal tokens shared by panel and desktop`

### Task 2: shadcn/ui behind the existing component API

**Files:**
- Create: `apps/panel/components.json` (style `new-york`, `tsx: true`, `tailwind.cssVariables: true`, aliases `@/components`, `@/lib/utils`), `apps/panel/lib/utils.ts` (`cn`), `apps/panel/components/ui/*.tsx` (via `pnpm dlx shadcn@<pinned 2.x for Tailwind 3> add button card badge switch toggle-group input table alert-dialog tooltip select separator`), `apps/panel/test/ui.test.tsx`, `apps/panel/vitest.config.ts` (jsdom)
- Modify: `apps/panel/components/ui.tsx`, `apps/panel/package.json` (vitest, @testing-library/react, jsdom as dev deps; radix + lucide-react + class-variance-authority + tailwind-merge + tailwindcss-animate as deps), root `vitest.config.ts` (add `"apps/panel"`)

**Interfaces:**
- Produces (unchanged names and props, so pages compile untouched): `Button, Card, Badge, StatusBadge, Switch, Segmented, Input, Stepper, Field, Kpi, Table, Td, Signed, Empty, ErrorBox, Loading, ModeBadge, cx`. New: `ConfirmDialog({ title, body, confirmLabel, tone: "danger"|"default", onConfirm, trigger })` built on AlertDialog. New: `List` / `ListRow({ label, value, action })` for grouped inset lists (direction B).

- [ ] **Step 1: Write failing tests** in `apps/panel/test/ui.test.tsx`:
  - `Signed keeps sign and tone`: `<Signed v="-12.5" fmt={(v) => usd(v, true)} />` renders text `−$12.50` (or the current minus form from `usd`) with class containing `text-neg`; `v="3"` renders `+$3.00` with `text-pos`.
  - `Button has focus-visible ring`: rendered class contains `focus-visible:`.
  - `ConfirmDialog calls onConfirm only after confirm`: click trigger, then Cancel → not called; trigger, Confirm → called once.
- [ ] **Step 2: Run** `pnpm vitest run --project panel` → FAIL
- [ ] **Step 3: Implement** `ui.tsx` exports on the shadcn parts (same props as today; `Segmented` on ToggleGroup; `Table` with sticky head, right-aligned numeric cells; press feedback `active:scale-[0.97]` 100 ms on buttons; no `transition-all`).
- [ ] **Step 4: Run** tests → PASS; `pnpm --filter panel typecheck && pnpm --filter panel build` → succeed.
- [ ] **Step 5: Commit** `feat(panel): shadcn/ui components behind the existing ui API`

### Task 3: Embedded mode, page header, nav bar

**Files:**
- Create: `apps/panel/lib/embed.ts`, `apps/panel/components/page-header.tsx`, `apps/panel/test/shell.test.tsx`
- Modify: `apps/panel/components/shell.tsx`, `apps/panel/lib/agent.ts` (keep `#pair=` handling; the desktop now opens `/?embed=desktop#pair=…`)

**Interfaces:**
- Produces: `isEmbedded(search: string, stored: string | null): boolean` (true when `search` has `embed=desktop` or `stored === "desktop"`), `useEmbedded(): boolean` (persists to `sessionStorage["trademate.embed"]`), and in embedded mode `window.__tradeMateNavigate = (route: string) => void` calling `router.push(route)` for routes in `NAV` only.
- Produces: `PageHeader({ title }: { title: string })` containing `HeaderModeToggle`, `SourceBadges`, kill switch (via `ConfirmDialog`, `POST /api/kill-switch {confirm:true}` as today). `NAV` stays exported from `shell.tsx` as `export const NAV`.
- Page titles: `/` Overview, `/signals/` Signals, `/history/` History, `/analytics/` Analytics, `/exchanges/` Exchanges, `/health/` Health, `/settings/` Settings.

- [ ] **Step 1: Write failing tests** in `apps/panel/test/shell.test.tsx` (mock `api`/`useAgent` connected, `usePathname`):
  - `isEmbedded` cases: `("?embed=desktop", null) → true`, `("", "desktop") → true`, `("", null) → false`, `("?embed=other", null) → false`.
  - `renders kill switch once` in both modes: `getAllByRole("button", { name: /kill switch/i })` length 1; embedded → no `navigation` landmark; browser → one `navigation` with 7 links and no kill switch inside it.
  - `live banner and kill banner once`: state `{ liveRunning: true, killSwitch: true }` → each banner text found exactly once, sentence case (no `uppercase` class).
  - `navigate hook ignores unknown routes`: `window.__tradeMateNavigate("/evil")` does not call `router.push`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `embed.ts`, `PageHeader`, and `Shell`: banners at top of content, `PageHeader` on every page with the title from the route, browser-only links bar (restyled, translucent, links only).
- [ ] **Step 4: Run** tests → PASS; build passes.
- [ ] **Step 5: Commit** `feat(panel): embedded desktop mode and shared page header`

### Task 4: Overview in direction B

**Files:**
- Modify: `apps/panel/app/page.tsx`, `apps/panel/components/bot-controls.tsx` (bot list rows), `apps/panel/components/equity-chart.tsx` (colours from tokens via `getComputedStyle`)

**Interfaces:**
- Consumes: `List`, `ListRow`, `Kpi`, `Signed`, `ConfirmDialog` (Task 2); `PageHeader` (Task 3).

- [ ] **Step 1: Write failing test** `apps/panel/test/overview.test.tsx` with a fixture `/api/overview` response (2 bots, 1 open position):
  - headline shows total balance and Net PnL with sign (`+$12.40`, `(+2.48%)`)
  - open positions table renders the position row with a `Close` button that opens a confirm dialog before calling `POST /api/trades/:id/close`
  - Customize mode lists all 13 KPI ids; hiding one removes it; order saves through `PUT /api/bots/:id/layout` as today
  - empty state (no bots data) and error state render the existing `Empty` / `ErrorBox`
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** order: headline (balance + Net PnL), equity chart (range buttons kept), bot list rows (status, PnL, Start/Stop; Live start keeps typing `LIVE`), open positions table, KPI grouped list with dnd-kit vertical sorting, Get-started card when shown today.
- [ ] **Step 4: Run** → PASS; build passes.
- [ ] **Step 5: Commit** `feat(panel): Overview in the pro-lists layout`

### Task 5: Signals and History

**Files:** Modify `apps/panel/app/signals/page.tsx`, `apps/panel/app/history/page.tsx`; Test `apps/panel/test/tables.test.tsx`

- [ ] **Step 1: Write failing tests** with fixtures: numeric columns render right-aligned with `tabular-nums`; rejected signal shows its reason codes; a losing trade shows `−` and `text-neg`; empty lists render `Empty`; filters and the per-row detail behave as today (same query params sent).
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** inset grouped tables (sticky header, row hover, detail drawer/expander as today), view selector kept.
- [ ] **Step 4: Run** → PASS; build passes.
- [ ] **Step 5: Commit** `feat(panel): Signals and History as inset tables`

### Task 6: Desktop frame: sidebar pages, route sync, appearance

**Files:**
- Create: `apps/desktop/src/main/pure/panelRoutes.ts`, `apps/desktop/test/panelRoutes.test.ts`
- Modify: `apps/desktop/src/shared/types.ts`, `apps/desktop/src/main/window.ts`, `apps/desktop/src/main/controller.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/settings.ts`, `apps/desktop/src/main/agentSupervisor.ts` (pair URL gains `?embed=desktop`), `apps/desktop/src/renderer/{app.ts,pages.ts,dom.ts,index.html,styles.css}`, `apps/desktop/scripts/build.mjs` (copy `packages/design/tokens.css` to `dist-electron/renderer/tokens.css`)

**Interfaces:**
- Produces: `type PanelView = "overview" | "signals" | "history" | "analytics" | "exchanges" | "health" | "settings"`; `type ViewName = PanelView | "updates" | "support" | "about"` (replaces `"panel"`); `PANEL_ROUTES: Record<PanelView, string>` (`overview: "/"`, others `"/<name>/"`); `viewForUrl(url: string, port: number): PanelView | null`; `routeFor(view: PanelView): string`.
- Produces: `Settings.appearance: "system" | "light" | "dark"` (default `"system"`), applied with `nativeTheme.themeSource`; IPC `setAppearance(a)`.
- Produces: `ShellWindow.openRoute(view: PanelView)`: if the panel is loaded, `executeJavaScript('window.__tradeMateNavigate?.(<json route>)')`; else stores `pendingView` and applies it on the next ready load.

- [ ] **Step 1: Write failing tests** `apps/desktop/test/panelRoutes.test.ts`:
  - `viewForUrl`: `http://localhost:7777/` → `overview`; `/history/` → `history`; `/history/?run=x` → `history`; `/signals/abc` → `signals`; other port or host → `null`.
  - `routeFor(overview) === "/"`, `routeFor(health) === "/health/"`.
  - `pending route is applied on ready`: a small pure helper `nextRoute(pending: PanelView | null, loadedRoute: PanelView | null): PanelView` returns `pending ?? loadedRoute ?? "overview"`.
  - settings schema: missing `appearance` parses to `"system"`; `"neon"` falls back to `"system"`.
- [ ] **Step 2: Run** `pnpm --filter desktop test` → FAIL
- [ ] **Step 3: Implement**: sidebar groups "OI Sniper" (7) and "App" (3); no top bar on panel views; panel view listens to `did-navigate-in-page` and `did-navigate` → `viewForUrl` → shell state `view`; Appearance control (Light / Dark / Match system) on Support; renderer styles use `tokens.css` variables (`rgb(var(--x))`), translucent sidebar, press feedback, focus-visible, reduced-motion.
- [ ] **Step 4: Run** tests → PASS; `pnpm --filter desktop typecheck`; `pnpm desktop:dev` with `OISNIPER_DATA_DIR` set to a scratch folder: clicking each of the 7 items shows that page; Overview → a link to History moves the highlight; clicking Signals while the engine starts lands on Signals when ready.
- [ ] **Step 5: Commit** `feat(desktop): OI Sniper pages in the sidebar, shared tokens, appearance setting`

### Task 7: Analytics, Exchanges, Health, Settings

**Files:** Modify `apps/panel/app/{analytics,exchanges,health,settings}/page.tsx`, `apps/panel/components/{readiness,trade-settings,bot-editor,source-compare,get-started,export-button}.tsx`; Test `apps/panel/test/forms.test.tsx`

- [ ] **Step 1: Write failing tests**: readiness items render as a list with pass / fail text (not colour alone); Real key form still refuses submit without the no-withdrawal confirmation; bot-editor save still sends the same `PUT /api/bots/:id/config` body for a fixture config; theme select in Settings still writes `oisniper.theme`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** grouped inset forms and lists (Apple Settings style) with `Field`, `Switch`, `Select`, `Stepper`; analytics headline figures then charts then grouped lists.
- [ ] **Step 4: Run** → PASS; build passes.
- [ ] **Step 5: Commit** `feat(panel): Analytics, Exchanges, Health and Settings restyled`

### Task 8: Visual verification and PR

- [ ] **Step 1:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → all pass.
- [ ] **Step 2:** Run `pnpm demo` (scripted agent) and `pnpm desktop:dev`; capture screenshots of all 7 pages + Updates/Support in light and dark, embedded, and the browser panel at `http://localhost:7777`; plus disconnected (stop agent), loading, empty (fresh data dir), live banner, kill-switch banner. Save under the scratchpad, review each against Global Constraints; fix and re-shoot anything off.
- [ ] **Step 3:** Keyboard pass on Overview and Settings: Tab reaches every control with a visible ring.
- [ ] **Step 4:** Open PR `feat: Apple-style redesign (mint white / charcoal) with OI Sniper pages in the sidebar`, attach light/dark screenshots, list the spec's anti-goals as checked items.
