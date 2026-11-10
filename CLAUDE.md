# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`noticed Relationships` — a Manifest V3 browser extension that imports a user's **own first-degree
LinkedIn connections** into their [noticed](https://www.noticed.so) account. This repo is the extension
**client only**; the noticed backend it talks to (`/x/connect`, `/x/sync`, `/api/sync/runs`,
`/api/linkedin/import/extension`, the recipe endpoint) lives in the separate `noticedso/noticed` monorepo.

## Commands

```bash
npm ci                       # install (Node 22)
npm test                     # vitest — all tests use a mocked chrome.* (test/mocks/chrome.ts)
npx vitest run <pattern>     # a single file/test, e.g. `npx vitest run service-worker`
npx tsc --noEmit             # type-check (strict; no @types/chrome — see src/types/chrome.d.ts)
node build.mjs               # deterministic esbuild → ./dist (load unpacked in chrome://extensions)
node scripts/hash-artifact.mjs   # SHA-256 of the built dist (reproducibility proof)
```

Releasing is tag-driven (`git tag vX.Y.Z && git push origin vX.Y.Z`) — see `PUBLISHING.md`. CI
(`.github/workflows/ci.yml`) runs the tests + asserts two builds hash-identical.

## Architecture (the big picture)

**Source-agnostic by design.** The extension code does **not** hardcode which site to read or which
endpoints to hit. At pair time, noticed serves a JSON **"recipe"** (`targetOrigin`, `listPathTemplate`
with `{start}`/`{count}`, `paginationParams`, `csrfRule`, `fieldMap`, `pacing`, `excludeSources`) that is
stored in `chrome.storage` and drives a scan. This is config/data, never executable code. (`manifest.json`
declares LinkedIn as a host permission **granted at install** (NT-300). X/Twitter stay **optional**, so
the update doesn't disable LinkedIn-only installs; the toolbar button asks for X, and for any LinkedIn
access the user withheld.)

**`src/service-worker.ts` is the brain.** It registers listeners (idempotently — re-binds when the test
harness swaps the global `chrome`):
- `onMessageExternal` — only from `*.noticed.so` origins (enforced by `isNoticedOrigin`): `ping`, `pair`,
  `getOnboardingStatus`
  (store recipe+account+`noticedOrigin`, set the six-hourly sync check; it never requests permissions),
  `getCachedScan`, `syncConfirmed`.
- `onMessage` (internal) — `getStatus`, `scanNow`, `setTestMode`, `getSyncHistory`. No UI sends these
  since the popup was removed; they remain the extension's internal control surface and tests drive scans
  through them. To cap scans in a dev build, run `chrome.storage.local.set({ testMode: true })` in the
  service-worker console (a worker's own `runtime.sendMessage` never reaches its `onMessage`).
- `action.onClicked` — the toolbar button (there is no popup): restores withheld site access, then
  focuses or opens noticed's `/connect` page (`openConnectionPage`).
- `onAlarm` — every six hours, syncs each granted network that `scanDue` says is due: three days
  after its own last confirmed sync, and never within 24 hours of its last attempt.

`runScan` composes the pure libs: `cookies.ts` (read the session cookie → CSRF header) → `fetch-engine.ts`
(`scanConnections`: paced, jittered, page-capped pagination; test mode caps to 2 requests) → `recipe.ts`
(`applyFieldMap` maps each page to `ScanConnection`s). It caches the result as `pendingScan` and opens
`noticedOrigin + /x/sync?ext_id=<chrome.runtime.id>` — the extension **never holds a noticed credential**;
the first-party noticed page POSTs the data with the user's session cookie, then `syncConfirmed` clears the
pending scan and stamps `lastScanAt`/`lastScanCount`.

**Pairing has no env-id dependency.** noticed's `/connect` page pairs the extension it finds over
`externally_connectable` (`pair` with the account's recipes); the legacy `/x/connect?ext_id=` broker
still works for older flows.

**`lib/storage.ts`** is the single typed `chrome.storage.local` state (recipe, account, noticedOrigin,
pendingScan, lastScanAt, lastScanStartedAt, lastScanCount, needs, testMode). All other modules read/write
through `getState`/`setState`.

**No popup (NT-300).** Status, retry and setup live on noticed's `/connect` page, which polls
`getOnboardingStatus` and sends `retrySync`; the toolbar button opens it.

## Conventions & gotchas

- **chrome.* typing:** a minimal ambient `src/types/chrome.d.ts` (no `@types/chrome`). Add to it if you use
  a new `chrome.*` surface.
- **Dev-only UI** is gated by a build-time `__DEV__` flag (esbuild `define`). It's `true` only when built
  with `EXT_DEV=1 node build.mjs`; the published build has it `false` (the test-mode toggle is dev-only).
- **Reproducible build is load-bearing:** `build.mjs` must stay deterministic (sorted inputs, no
  timestamps/`Date.now`/random). Every release publishes the artifact hash; the uploaded Web Store zip must
  match it.
- **Tests** never touch a real browser: `test/setup.ts` installs `test/mocks/chrome.ts` per test and sets
  `globalThis.__DEV__ = true`. SW/handoff tests drive behavior by dispatching mock chrome events.
- **Only declare permissions you use** — an unused permission is an automatic Web Store rejection (e.g.
  `scripting` was removed for this reason). `chrome.tabs.create` needs no `tabs` permission.
- Keep `manifest.json` `version` and `package.json` `version` in sync, and tag `v<that version>`.
