# Releasing Trade Mate

How changes get from your computer to users, and how to pull a bad version back.

## The rules

1. **`main` is protected.** Nobody pushes to it directly. Every change goes through a pull request (PR).
2. **A PR can only be merged when CI is green**: typecheck, lint, all tests, and a Windows + macOS packaging build.
3. **Commit messages decide the version** ([Conventional Commits](https://www.conventionalcommits.org)):
   | Commit / PR title starts with | Effect | Example |
   |---|---|---|
   | `fix:` | patch bump (0.1.0 → 0.1.1) | `fix: panel blank after sleep` |
   | `feat:` | minor bump (0.1.0 → 0.2.0) | `feat: telegram alerts` |
   | `feat!:` or `BREAKING CHANGE:` | major bump (after 1.0) | `feat!: new config format` |
   | `chore:` `docs:` `ci:` `test:` `refactor:` | no release | `docs: update readme` |
   Use **Squash and merge**, so the PR title becomes the one commit on `main`.
4. **Every new version starts on Beta.** Stable users only get it after you promote it.

## Day-to-day flow

```bash
git checkout main
git pull
git checkout -b fix/short-name
```

Make the change, then:

```bash
pnpm typecheck && pnpm lint && pnpm test
git add -A
git commit -m "fix: what changed"
git push -u origin fix/short-name
gh pr create --fill
```

CI runs on the PR. When it is green, **Squash and merge** on GitHub.

## Shipping a version

1. After each merge, the **Release** workflow keeps one PR open: `chore(main): release x.y.z`.
   It collects the merged changes into `CHANGELOG.md` and sets the version. Nothing is released yet.
2. When you want to ship, merge that release PR.
3. The workflow then tags `vX.Y.Z`, creates the GitHub release **as a pre-release**, builds
   `Trade-Mate-Setup-X.Y.Z.exe` (Windows) and `Trade-Mate-X.Y.Z-arm64.dmg` / `-x64.dmg` (macOS), and attaches them.
4. **Test it.** On your own machine, switch Trade Mate to the **Beta** channel (Updates page) and install it.
5. **Promote to Stable:** open the release on GitHub → Edit → untick *Set as a pre-release* → Update.
   Stable users see the update the next time Trade Mate checks (on start and every 6 hours).

Updates never install by themselves: users see "Update available" and choose when to install.
Trade Mate asks before it stops the engine and says how many positions are open.

## When a version is bad

| Situation | What to do |
|---|---|
| Found it in Beta, not promoted | Leave it as pre-release. Fix → merge → ship the next version. |
| Already promoted to Stable | GitHub → the release → Edit → tick *Set as a pre-release* again. Stable users stop being offered it. |
| Users already installed it | They open **Updates → Version history → Roll back to this** on the last good version. The installer is downloaded, its SHA-512 checked against the release, and it replaces the app. Bots, settings and trade history are kept (they live in the engine's data folder, which installs never touch). |
| Need the fix out fast | `git revert <sha>` on a branch, PR titled `fix: revert ...`, merge, merge the release PR, promote. |

Never delete a release or a tag that users may have installed: rollback needs its installer.

## Hotfix to an older version

Branch from the tag, fix, and release from that branch only if you really need it; usually ship the next version from `main` instead.

```bash
git checkout -b hotfix/0.2.1 v0.2.0
```

## Signing (later)

Installers are not signed yet, so first launch shows:
- Windows: "Windows protected your PC" → **More info** → **Run anyway**.
- macOS: "Apple could not verify…" → System Settings → Privacy & Security → **Open Anyway**.

macOS also cannot update itself in place without a signature: the Updates page downloads and verifies the `.dmg` and opens it instead.
To sign later, add these repository secrets and remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` / `identity: "-"`:
`CSC_LINK`, `CSC_KEY_PASSWORD` (Windows certificate), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (macOS notarization).

## Emergency access

You are the repository admin, so you can still bypass branch protection on GitHub in an emergency.
Use it only when CI itself is broken, and say why in the PR.
