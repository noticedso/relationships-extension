# Brave OAuth callback tab loop

Date: 2026-08-17  
Affected extension: noticed Relationships 1.2.11 and earlier state carried forward from older installs  
Browser in report: Brave  
Severity: High (repeated unwanted tabs and repeated relationship scans)

## User-visible issue

Brave repeatedly opens tabs that eventually display a URL shaped like:

```text
http://localhost:17433/oauth/callback?state=<redacted>&iss=https%3A%2F%2Fwww.noticed.so&code=<redacted>
```

Removing the extension stops the new tabs. The reported interval of roughly 15–30 seconds overlaps the extension's 30-second MV3 scan recovery cadence and the duration of a paced relationship scan.

## What is actually opening the tab

The extension does **not** construct an OAuth URL and contains no localhost or OAuth callback code. The published Chrome Web Store 1.2.11 artifact was downloaded and inspected as part of this investigation. Its only automatic tab creation after a scan is:

```text
https://<paired-noticed-origin>/x/sync?ext_id=<extension-id>&source=<source>
```

The localhost URL is a separate OAuth client's registered callback (the `iss` parameter identifies noticed as the authorization server). It is therefore the destination at which the browser tab ended, not the URL the extension originally asked Brave to open. The one-time `state` and `code` values are intentionally omitted from this report.

## Confirmed extension defect

Automatic scanning is shared by the three-day alarm and the first-party `pair` message. Before this fix, that path used only `lastScanStartedAt` as its re-entry guard.

A completed scan also stores a `pendingScans[source]` payload until the first-party `/x/sync` handoff confirms it. If the handoff is redirected away, interrupted, or inherited from an older installation without `lastScanStartedAt`, the payload remains pending. A later re-pair nevertheless started the same source again, replaced the pending payload, and opened another handoff tab.

That is the missing invariant: **a source with an unconfirmed pending handoff must never be automatically scanned again**. A manual “Sync now” remains available if the user deliberately wants a new scan.

The timestamp throttle added in 1.2.3 prevents the ordinary `/x/sync → pair → scan` loop, but timestamp state alone is insufficient for legacy, partially migrated, or failed-handoff state. The pending payload is the authoritative evidence that another automatic scan cannot help.

## Incident attribution

The repeated-tab mechanism is confirmed and is consistent with the report, but the exact reporter state cannot be recovered: uninstalling the extension removed its active storage, and no pre-uninstall Brave profile was available. The historical 1.2.0–1.2.2 extension had a known unbounded `/x/sync → pair → scan` loop; 1.2.3 added the timestamp throttle, and the current Web Store artifact is 1.2.11. An out-of-date Brave installation would therefore reproduce the original loop directly. The new pending-payload guard closes the remaining re-entry path even when timestamp state is absent or incomplete.

The localhost callback itself must not be described as extension-generated. It proves that the resulting tab participated in a separate noticed OAuth authorization, but without the original browser state or a matching bounded production OAuth lookup, the redirect that connected `/x/sync` to that callback remains unverified.

## Exact regression reproduction

The service-worker event sequence reproduces the failure on unmodified 1.2.11:

1. Store a finished `pendingScans.linkedin_extension` payload and `needs = "noticed-signin"`, as left by a handoff that never confirmed.
2. Leave `lastScanStartedAt` absent/null, matching legacy or incomplete state.
3. Grant the source host permission and keep its session cookie present.
4. Deliver the first-party `pair` message again.
5. Observe an unexpected source fetch followed by `chrome.tabs.create(...)` for another `/x/sync` handoff.

The regression test failed before the implementation with one unexpected relationship fetch. After the fix it performs zero fetches, opens zero tabs, and preserves the original pending payload.

## Fix

`autoScanGrantedSources()` now skips each granted source that already has `pendingScans[source]`. This guard is applied to both automatic entry points because they share the helper:

- first-party re-pair;
- periodic scan alarm.

User-triggered `scanNow` is intentionally unchanged.

## Scenarios verified

| Scenario | Expected result | Verification |
|---|---|---|
| Fresh pair, host permission not granted | No scan or tab | Existing test passes |
| Pair with granted source and no pending payload | One automatic scan/handoff | Existing test passes |
| Immediate re-pair after a completed scan | Timestamp throttle prevents rescan | Existing test passes |
| Re-pair with pending payload and missing legacy timestamp | No scan, no new tab, pending payload preserved | New regression test passes |
| Manual sync | Still starts a fresh scan | Existing scan tests pass |
| Full unit/integration suite | No regressions | 200 tests pass |
| TypeScript/build/reproducible artifact | Clean and deterministic | Release verification commands below |

## Brave environment note

Brave 1.93.136 was installed from the official Homebrew cask on the reported Mac. Its Developer ID signature and Apple notarization were verified. On this remote macOS 26 host, every new Brave process remained suspended at `_dyld_start` before creating a browser window or DevTools endpoint, including normal Finder launch. Because the application itself never reached UI startup, a Brave screenshot/video could not be captured in this session. The defect was reproduced at the extension service-worker event boundary against the exact 1.2.11 Web Store artifact/source instead; no authenticated user data was required.

## Release verification

Run before release:

```bash
npm test
npx tsc --noEmit
npm run build
npm run hash
```

Version 1.2.12 is intended to be released by the repository's automatic tag-and-publish workflow after merge.
