# Billiards

## Platform: FreeGameStore
- Domain: billiards.freegamestore.online
- Push to `main` auto-deploys via CF Pages
- SDK: `@freegamestore/games` (GameShell, GameTopbar, GameAuth, useGameSounds)

## Development
- `pnpm dev` — start dev server
- `pnpm build` — production build

## Rules
- No splash screens — game field visible immediately
- No custom topbar/navbar — use SDK GameTopbar
- No CSS libraries (MUI, Bootstrap, etc.) — Tailwind only
- No analytics, tracking, or third-party scripts
- Muted by default — use `useSound()` to check
- All touch targets >= 44px
- Must fit all viewports 320x568 to 1366x1024

## Docs
- Full guide: https://raw.githubusercontent.com/freeappstore-online/ops/main/SKILLS.md
- Store: ~/dev/fgs/platform/freegamestore/
- Auditor: ~/dev/fgs/platform/auditor/
