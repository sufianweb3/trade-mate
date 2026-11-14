# Trade Mate UI redesign — design

Status: draft for approval · 2026-11-14

## 1. Intent

Make Trade Mate look and feel like a clean, professional Apple-style app, and make the OI Sniper pages first-class
in the desktop app's sidebar instead of a second navigation bar inside the content area.

**Who:** traders, not programmers. They should be able to read their balance, see what each bot is doing and act
(start, stop, kill switch) without hunting.

## 2. Goals

1. **Sidebar navigation**: the Trade Mate sidebar lists the OI Sniper pages (Overview, Signals, History, Analytics,
   Exchanges, Health, Settings), then the app pages (Updates, Support, About). Clicking one shows that page; the
   item for the page on screen is highlighted, including after in-page links (e.g. a trade row opening History).
2. **New look, one design language across the frame and every panel page**, direction **B "Pro lists"** (chosen
   from mockups): one large headline number per page where there is one, then compact grouped (inset) lists and
   tables, like Apple Stocks / Finder.
3. **Colours**: light = **mint white** (background `#F3FAF6`, surfaces white, deep mint accent `#1F9D74`); dark =
   **charcoal** (background `#141617`, surfaces `#1C1F21` / `#24282A`, soft mint accent `#5FD3A6`). Red only for
   losses, Live and the kill switch. Values from the approved mockup; the builder may tune them for contrast
   (WCAG AA for text) but not change the character.
4. **shadcn/ui components** replace the hand-made ones in `apps/panel/components/ui.tsx` (button, card, badge,
   switch, segmented/tabs, input, stepper, field, table, dialogs/alert-dialog for confirmations, tooltip).
5. **Page header** (in the desktop app): large page title, Paper / Real switch, signal-source status (CoinGlass /
   Exchange data), kill switch. These leave the old top bar.

## 3. Non-goals

- No change to features, numbers, API calls, trading logic, agent code or `packages/core`.
- No change to page content beyond layout and presentation (same KPIs, columns, settings, wording unless a label
  breaks a design rule below).
- The Trade Mate frame stays plain HTML/CSS (approach 2, rebuilding it in React, is deferred to the Super App).
- No marketing page (the Stageshow skill fits that later, not this).

## 4. Anti-goals

- A figure losing its +/− sign, colour meaning, tabular alignment or precision.
- Hiding or burying the kill switch, the live-trading banner or the kill-switch-engaged banner.
- Losing a UI state: loading, empty, error, agent disconnected, live mode banner (CLAUDE.md definition of done).
- The panel opened in a normal browser (or on Vercel) losing its navigation.
- Motion that slows a trader down: no animation on data updates, no transition longer than ~200 ms.

## 5. Constraints and design rules

- CLAUDE.md panel rules: shadcn/ui, Tailwind tokens only (no hard-coded hex in components), tabular numbers, every
  value with sign and colour, all UI states covered.
- From the design skills read for this (emilkowalski `apple-design` / `emil-design-eng`, Nutlope `hallmark`):
  - every colour and font through tokens; never `transition: all`; never animate width/height/top/left;
  - visible `:focus-visible` on every interactive element; `prefers-reduced-motion` fallback for any motion;
  - no labels in tracked capitals (the current live banner `uppercase tracking-wider` goes);
  - status dots only where they carry state (engine running, source status), never decorative;
  - press feedback on pointer-down (`:active` scale ~0.97, 100 ms); no card inside a card.
- Static export (`output: "export"`) and Vercel deployment keep working.

## 6. Approaches considered

| | Approach | Decision |
|---|---|---|
| 1 | **Panel moves to shadcn/ui on shared mint/charcoal tokens; the frame reads the same tokens; panel hides its top bar when embedded** | **Chosen** |
| 2 | Also rebuild the Trade Mate frame in React, sharing components with the panel | Deferred to the Super App |
| 3 | Recolour only (CSS overrides) | Rejected: not Apple-clean, no shadcn |

## 7. Design

### 7.1 Tokens (one source)

`packages/design/tokens.css` (new): the token set for light and dark, in the panel's existing `r g b` triple format
(so Tailwind's `rgb(var(--x) / <alpha>)` keeps working), plus the shadcn variable names mapped onto them
(`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`, `--destructive`, ...).
Existing semantic tokens stay: `pos`, `neg`, `warn`, `live`, `paper`. The panel's `globals.css` and the desktop
renderer both use this file (the desktop build copies it next to `styles.css`).

Theme selection keeps today's rules: `prefers-color-scheme`, overridden by `data-theme="light|dark"`.

### 7.2 Desktop frame (apps/desktop)

- Sidebar groups: **OI Sniper** (7 pages) and **App** (Updates, Support, About). "Dashboard" is replaced by the
  seven items. Engine status and version stay at the bottom.
- Clicking an OI Sniper item shows the panel view and navigates it to that route without a full reload (the panel
  exposes a navigate function in embedded mode; the main process calls it). The main process listens to the panel
  view's in-page navigation events and tells the shell which item to highlight.
- While the panel is not ready (engine starting, restarting, error or conflict; panel unpaired or disconnected), all
  seven OI Sniper items stay clickable and show the same engine screen as today; the main process remembers the
  last item clicked and opens that route once the panel is ready, and the highlight follows the panel's actual route
  after any reload (builder's call).
- The frame's top bar is removed for OI Sniper pages (the panel page header takes that role); Updates / Support /
  About keep a simple large title.
- Frame restyled with the shared tokens; sidebar translucent over the mint / charcoal background.
- **Appearance**: a Light / Dark / Match system control on the Support page sets Electron's `nativeTheme`, which
  drives `prefers-color-scheme` for both the frame and the panel (the panel's own Settings theme still overrides
  the panel when set to light or dark).

### 7.3 Panel (apps/panel)

- **Embedded mode**: the desktop app opens the panel with `?embed=desktop`; the panel remembers it for the session
  and then renders no top bar, only the page header (§2.5). Opened any other way, the panel keeps a navigation
  bar, restyled, that carries **links only**: the page header (title, Paper / Real, source status, kill switch) is
  the same component in both modes, so the kill switch and banners exist exactly once in each (builder's call).
- **Components**: shadcn/ui (Radix-based) added to the panel, themed by the tokens; `components/ui.tsx` becomes a
  thin layer over them or is replaced call site by call site. Kill switch and Live start use an AlertDialog
  instead of the inline confirm.
- **Pages** (layout per direction B; data and wording unchanged):
  - Overview: headline balance + **Net PnL** ($ and % of start balance, the existing figures; no new period change)
    for the selected account, equity chart, bot list (Paper / Real / Test with status, PnL, Start/Stop), **open
    positions table with its per-row Close button** (right under the bot list: a live-money control stays one glance
    away), then the KPIs as a grouped list. **Customize stays**: hide and drag-reorder KPIs (dnd-kit, vertical list),
    saved to the agent as today. The per-page Paper / Real / Test view selector stays. Get-started card stays when
    shown today. (Builder's calls, from the non-goal "no change to page content".)
  - Signals, History: inset grouped tables, sticky header, numbers right-aligned and tabular, row detail as today.
  - Analytics: headline figures, charts, then grouped lists.
  - Exchanges, Health, Settings: grouped inset forms and lists (Apple Settings style), readiness checklist as a list
    with clear pass / fail.
- Banners: live trading and kill switch engaged stay full-width at the top of the content area, sentence case.

### 7.4 Verification

- `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Screenshot review of every page in light and dark, embedded and browser, against the demo agent (`pnpm demo`):
  normal, loading, empty, error, disconnected, live banner, kill-switch banner.
- Keyboard pass: every control reachable with visible focus.

## 8. Left to the builder

- Exact shadcn setup for Tailwind 3 (or an upgrade to Tailwind 4 if it stays contained to the panel).
- Exact token values within the approved character (contrast), icon set (lucide, as shadcn uses), spacing scale.
- Whether `components/ui.tsx` is kept as a wrapper or removed.
- Chart colours (lightweight-charts) from the tokens.
